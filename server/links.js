// Links between diagrams (the hexagons) may carry the target's editing id,
// so that people who can edit one diagram can also edit the ones it links
// to. That id must not reach anyone who only has the read-only link:
// everything sent to them goes through here first.

const hasEditLink = (element) =>
  typeof element?.customData?.escalidusk?.diagramLink?.edit === "string";

/**
 * Returns the elements with any editing ids removed from diagram links.
 * Elements without one are passed through untouched (and not copied).
 */
export function withoutEditLinks(elements) {
  if (!elements.some(hasEditLink)) return elements;
  return elements.map((element) => {
    if (!hasEditLink(element)) return element;
    const { edit: _edit, ...diagramLink } = element.customData.escalidusk.diagramLink;
    return {
      ...element,
      customData: {
        ...element.customData,
        escalidusk: { ...element.customData.escalidusk, diagramLink },
      },
    };
  });
}

/** The same, for a stored scene (a JSON string). Cheap when there is nothing to remove. */
export function sceneWithoutEditLinks(sceneJson) {
  // The marker can only be present if both of these words are.
  if (!sceneJson.includes('"diagramLink"') || !sceneJson.includes('"edit"')) return sceneJson;
  const scene = JSON.parse(sceneJson);
  const elements = withoutEditLinks(scene.elements ?? []);
  return elements === scene.elements ? sceneJson : JSON.stringify({ ...scene, elements });
}
