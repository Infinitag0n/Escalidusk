import { expect, test } from "@playwright/test";
import { newId, seedDiagram, stored } from "./helpers.js";

const PNG = Buffer.from("89504e470d0a1a0a66616b6564617461", "hex");

test.describe("diagram API", () => {
  test("health check", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(await response.json()).toEqual({ ok: true });
  });

  test("unknown diagram is 404, malformed id is 400", async ({ request }) => {
    expect((await request.get(`/api/diagrams/${newId()}`)).status()).toBe(404);
    expect((await request.get("/api/diagrams/nope")).status()).toBe(400);
  });

  test("create, read and update with version checks", async ({ request }) => {
    const id = newId();
    const create = await request.put(`/api/diagrams/${id}`, {
      data: { baseVersion: 0, elements: [{ id: "a" }], appState: { name: "First" } },
    });
    expect(create.status()).toBe(200);
    expect((await create.json()).version).toBe(1);

    const diagram = await stored(request, id);
    expect(diagram).toMatchObject({
      id,
      version: 1,
      readOnly: false,
      scene: { elements: [{ id: "a" }], appState: { name: "First" } },
    });

    const update = await request.put(`/api/diagrams/${id}`, {
      data: { baseVersion: 1, elements: [{ id: "a" }, { id: "b" }] },
    });
    expect((await update.json()).version).toBe(2);
  });

  test("a save based on an old version is refused with the stored copy", async ({ request }) => {
    const { id } = await seedDiagram(request, { elements: [{ id: "a" }] });
    const stale = await request.put(`/api/diagrams/${id}`, {
      data: { baseVersion: 0, elements: [] },
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).current).toMatchObject({ id, version: 1 });
    expect((await stored(request, id)).scene.elements).toEqual([{ id: "a" }]);
  });

  test("updating a diagram that does not exist reports a conflict with no copy", async ({
    request,
  }) => {
    const response = await request.put(`/api/diagrams/${newId()}`, {
      data: { baseVersion: 3, elements: [] },
    });
    expect(response.status()).toBe(409);
    expect((await response.json()).current).toBeNull();
  });

  test("malformed save bodies are rejected", async ({ request }) => {
    const id = newId();
    for (const data of [{ elements: [] }, { baseVersion: -1, elements: [] }, { baseVersion: 0 }]) {
      expect((await request.put(`/api/diagrams/${id}`, { data })).status()).toBe(400);
    }
    expect(await stored(request, id)).toBeNull();
  });

  test("unknown API paths answer with JSON, not the app page", async ({ request }) => {
    const response = await request.get("/api/nope");
    expect(response.status()).toBe(404);
    expect(response.headers()["content-type"]).toContain("application/json");
  });

  test("any other path serves the app, uncached", async ({ request }) => {
    const response = await request.get(`/${newId()}`);
    expect(response.status()).toBe(200);
    expect(response.headers()["content-type"]).toContain("text/html");
    expect(response.headers()["cache-control"]).toBe("no-cache");
  });
});

test.describe("image API", () => {
  test("stores an image and serves it back with safe headers", async ({ request }) => {
    const id = newId();
    const put = await request.put(`/api/diagrams/${id}/files/abc123`, {
      headers: { "Content-Type": "image/png" },
      data: PNG,
    });
    expect(put.status()).toBe(204);

    const get = await request.get(`/api/diagrams/${id}/files/abc123`);
    expect(get.status()).toBe(200);
    expect(Buffer.compare(await get.body(), PNG)).toBe(0);
    const headers = get.headers();
    expect(headers["content-type"]).toBe("image/png");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["content-security-policy"]).toContain("sandbox");
  });

  test("refuses content that is not an image", async ({ request }) => {
    const response = await request.put(`/api/diagrams/${newId()}/files/abc123`, {
      headers: { "Content-Type": "text/html" },
      data: "<script>alert(1)</script>",
    });
    expect(response.status()).toBe(415);
  });

  test("missing image is 404, malformed image id is 400", async ({ request }) => {
    const id = newId();
    expect((await request.get(`/api/diagrams/${id}/files/missing`)).status()).toBe(404);
    expect((await request.get(`/api/diagrams/${id}/files/bad.id`)).status()).toBe(400);
  });
});

test.describe("read-only id", () => {
  test("returns the scene without revealing the editing id", async ({ request }) => {
    const { id, viewId } = await seedDiagram(request, { elements: [{ id: "a" }] });
    expect(viewId).not.toBe(id);

    const response = await request.get(`/api/diagrams/${viewId}`);
    const body = await response.json();
    expect(body).toMatchObject({ id: viewId, readOnly: true, scene: { elements: [{ id: "a" }] } });
    expect(JSON.stringify(body)).not.toContain(id);
  });

  test("cannot be used to save, with any base version", async ({ request }) => {
    const { id, viewId } = await seedDiagram(request, { elements: [{ id: "a" }] });
    for (const baseVersion of [0, 1]) {
      const response = await request.put(`/api/diagrams/${viewId}`, {
        data: { baseVersion, elements: [] },
      });
      expect(response.status()).toBe(403);
    }
    expect(await stored(request, id)).toMatchObject({ version: 1, scene: { elements: [{ id: "a" }] } });
  });

  test("can read images but not upload them", async ({ request }) => {
    const { id, viewId } = await seedDiagram(request);
    await request.put(`/api/diagrams/${id}/files/abc123`, {
      headers: { "Content-Type": "image/png" },
      data: PNG,
    });
    expect((await request.get(`/api/diagrams/${viewId}/files/abc123`)).status()).toBe(200);

    const upload = await request.put(`/api/diagrams/${viewId}/files/other`, {
      headers: { "Content-Type": "image/png" },
      data: PNG,
    });
    expect(upload.status()).toBe(403);
  });
});
