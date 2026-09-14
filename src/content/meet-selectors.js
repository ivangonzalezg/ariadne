// src/content/meet-selectors.js
// Selectores best-effort — Meet no expone una API estable para esto. Confirmar contra
// el DOM real en la verificación manual (Task 11) y ajustar acá si no matchean; es el
// único archivo que debería necesitar cambios cuando Meet actualice su interfaz.
export const SELECTORS = {
  hangUpButton: '[aria-label="Salir de la llamada"]',
  micButton: '[aria-label*="micrófono"]',
  micMutedAttribute: "data-is-muted",
  captionsToggleButton: '[aria-label="Activar subtítulos"]',
  captionsContainer: '[aria-label="Subtítulos"]',
  captionSpeakerName: ".speaker-name",
  captionText: ".caption-text",
};
