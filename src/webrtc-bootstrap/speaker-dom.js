// Lee una propiedad interna no documentada de Meet (`__soy`, del framework Closure/
// Soy de Google) que no está pensada como API pública y puede cambiar sin aviso
// entre versiones de Meet. Toda esta fragilidad queda encapsulada acá — si algo
// no calza con lo esperado, se devuelve null y quien llama cae al nombre que ya
// muestra el panel de captions (".NWpY1d", "You" incluido).

const MAX_SPEAKER_NAME_LENGTH = 200;

// La forma exacta de este indicador se validó contra una reunión real de Meet
// (ver docs/superpowers/plans/2026-09-22-real-name-transcript-speaker.md, Tarea 8):
// es un único <div jscontroller> con __soy.key conteniendo "speakerAwareVolumeIndicator"
// y un solo hijo — NO tres hijos con extremos sin hijos propios, como asumía una
// versión anterior de este archivo copiada de un build viejo/distinto de un
// competidor. Esa forma puede volver a cambiar sin aviso en el futuro.
export function findSpeakerAwareIndicators() {
  const candidates = document.querySelectorAll("div[jscontroller]");
  const indicators = [];
  for (const el of candidates) {
    const soyKey = el.__soy?.key;
    if (typeof soyKey !== "string" || !soyKey.includes("speakerAwareVolumeIndicator")) continue;
    indicators.push(el);
  }
  return indicators;
}

// Máximo de niveles a subir por parentNode antes de rendirse. En una reunión
// real el nombre apareció 3 niveles arriba del indicador; este límite da
// margen amplio sin arriesgarse a recorrer todo el documento si el DOM de
// Meet reestructura esto en el futuro.
const MAX_ANCESTOR_CLIMB = 20;

export function extractSpeakerNameFromIndicator(indicatorEl) {
  let node = indicatorEl.parentNode;
  let steps = 0;
  while (node && steps < MAX_ANCESTOR_CLIMB) {
    steps++;
    const soyData = node.__soy?.data;
    if (soyData && typeof soyData === "object") {
      const dataKey = Object.keys(soyData).find((key) => typeof soyData[key] === "object" && soyData[key] !== null);
      if (dataKey) {
        const spaceObj = soyData[dataKey];
        const spaceKey = Object.keys(spaceObj)[0];
        const space = spaceKey !== undefined ? spaceObj[spaceKey] : null;
        const candidate = Array.isArray(space) ? space[28] : undefined;
        if (typeof candidate === "string" && candidate.trim().length > 0 && candidate.length <= MAX_SPEAKER_NAME_LENGTH) {
          return candidate.trim();
        }
      }
      // Este ancestro tiene __soy.data pero no un nombre usable (ej. un
      // wrapper intermedio sin contenido relevante, confirmado que existe en
      // una reunión real) — seguir subiendo en vez de rendirse acá, el
      // ancestro correcto puede estar más arriba.
    }
    node = node.parentNode;
  }
  return null;
}
