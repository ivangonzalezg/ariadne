// Lee una propiedad interna no documentada de Meet (`__soy`, del framework Closure/
// Soy de Google) que no está pensada como API pública y puede cambiar sin aviso
// entre versiones de Meet. Toda esta fragilidad queda encapsulada acá — si algo
// no calza con lo esperado, se devuelve null y quien llama cae al nombre que ya
// muestra el panel de captions (".NWpY1d", "You" incluido).

const MAX_SPEAKER_NAME_LENGTH = 200;

export function findSpeakerAwareIndicators() {
  const candidates = document.querySelectorAll("div[jscontroller]");
  const indicators = [];
  for (const el of candidates) {
    const soyKey = el.__soy?.key;
    if (typeof soyKey !== "string" || !soyKey.includes("speakerAware")) continue;
    if (el.children.length !== 3) continue;
    const first = el.firstElementChild;
    const last = el.lastElementChild;
    if (first?.hasChildNodes() || last?.hasChildNodes()) continue;
    indicators.push(el);
  }
  return indicators;
}

export function extractSpeakerNameFromIndicator(indicatorEl) {
  let node = indicatorEl.parentNode;
  while (node) {
    const soyData = node.__soy?.data;
    if (soyData && typeof soyData === "object") {
      const dataKey = Object.keys(soyData).find((key) => typeof soyData[key] === "object" && soyData[key] !== null);
      if (!dataKey) return null;
      const spaceObj = soyData[dataKey];
      const spaceKey = Object.keys(spaceObj)[0];
      const space = spaceKey !== undefined ? spaceObj[spaceKey] : null;
      const candidate = Array.isArray(space) ? space[28] : undefined;
      if (typeof candidate === "string" && candidate.trim().length > 0 && candidate.length <= MAX_SPEAKER_NAME_LENGTH) {
        return candidate.trim();
      }
      return null;
    }
    node = node.parentNode;
  }
  return null;
}
