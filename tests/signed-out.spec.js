import { expect, test } from "@playwright/test";
import { drawRectangle, expectStatus, expectStoredCount, openDiagram, visibleText } from "./helpers.js";

// A sign-in proxy (such as oauth2-proxy) in front of the app turns requests
// away once a session runs out: with a 401 on routes it knows are an API, or
// otherwise with a redirect to the login page. Either way nothing is lost.

const SAVE_URL = /\/api\/diagrams\/[0-9a-f-]{36}$/;

const turnAways = {
  "a 401": (route) => route.fulfill({ status: 401, body: "" }),
  "a redirect to a login page": (route) =>
    route.fulfill({ status: 302, headers: { Location: "https://login.example.com/authorize" } }),
};

for (const [how, turnAway] of Object.entries(turnAways)) {
  test(`a save turned away with ${how} says so, and goes through after signing in again`, async ({
    page,
    request,
  }) => {
    const id = await openDiagram(page);
    let signedIn = false;
    await page.route(SAVE_URL, (route) =>
      route.request().method() === "PUT" && !signedIn ? turnAway(route) : route.continue(),
    );

    await drawRectangle(page, 300, 250);
    await expectStatus(page, "signedout");
    expect(await visibleText(page.locator(".save-status"))).toBe("Signed out");
    const banner = page.getByRole("alert");
    await expect(banner).toContainText("You were signed out. Your changes are kept.");
    const signIn = banner.getByRole("link", { name: "Sign in again" });
    await expect(signIn).toHaveAttribute("href", "/signed-in.html");
    await expect(signIn).toHaveAttribute("target", "_blank");

    // The page the link opens (here no proxy stands in front of it) closes
    // itself, leaving the person where they were.
    const [opened] = await Promise.all([page.waitForEvent("popup"), signIn.click()]);
    await expect.poll(() => opened.isClosed()).toBe(true);

    // Signing in again in that tab lets the next retry through.
    signedIn = true;
    await expectStatus(page, "saved");
    await expectStoredCount(request, id, 1);
    await expect(page.getByRole("alert")).toHaveCount(0);
  });
}
