import { findSpeakerAwareIndicators, extractSpeakerNameFromIndicator } from "./speaker-dom.js";
import { findByIconText } from "../content/meet-selectors.js";

const RESCAN_DEBOUNCE_MS = 200;

export function startSpeakerObserver({ onSpeakerLabel: rawOnSpeakerLabel, log = () => {} }) {
  const onSpeakerLabel = (label) => {
    log("speaker-observer-emit", label);
    rawOnSpeakerLabel(label);
  };
  const observedIndicators = new WeakSet();
  const indicatorObservers = [];
  let lastSpeakerName = null;
  let rescanTimer = null;

  // No hay temporizador de "silencio": verificado contra una reunión real
  // (Tarea 8 del plan) que el indicador de Meet solo muta una vez al empezar
  // a hablar, no de forma continua mientras la persona sigue hablando - un
  // timeout sintético (como el que tenía esta función antes, copiado de
  // Fireflies) le cortaba la cobertura a intervenciones largas sin ninguna
  // señal real que lo justificara. La ventana de cada hablante simplemente
  // se extiende hasta el próximo cambio real de indicador (el mismo u otro),
  // lo cual es seguro acá porque `speaker-label-reconciler.js` solo usa estas
  // ventanas para resolver captions que Meet YA atribuyó a "You" - nunca para
  // reemplazar el nombre de otra persona real.
  function handleIndicatorChange(indicatorEl) {
    const speakerName = extractSpeakerNameFromIndicator(indicatorEl);
    log("speaker-observer-indicator-change", { speakerName, indicatorClass: indicatorEl.getAttribute("class") });
    if (speakerName === null || speakerName === lastSpeakerName) return;
    lastSpeakerName = speakerName;
    onSpeakerLabel({ speakerName, timestampMs: Date.now() });
  }

  function observeIndicator(indicatorEl) {
    if (observedIndicators.has(indicatorEl)) return;
    observedIndicators.add(indicatorEl);
    const observer = new MutationObserver(() => handleIndicatorChange(indicatorEl));
    observer.observe(indicatorEl, { attributes: true, subtree: false, childList: false });
    indicatorObservers.push(observer);
  }

  function scanForIndicators() {
    const indicators = findSpeakerAwareIndicators();
    log("speaker-observer-scan", { found: indicators.length });
    for (const indicatorEl of indicators) observeIndicator(indicatorEl);
  }

  function scheduleRescan() {
    if (rescanTimer) return;
    rescanTimer = setTimeout(() => {
      rescanTimer = null;
      scanForIndicators();
    }, RESCAN_DEBOUNCE_MS);
  }

  scanForIndicators();

  let layoutObserver = null;
  if (findByIconText("more_vert")) {
    layoutObserver = new MutationObserver(scheduleRescan);
    layoutObserver.observe(document.body, { childList: true, subtree: true });
  } else {
    log("speaker-observer-no-layout-anchor", {});
  }

  return function stopSpeakerObserver() {
    for (const observer of indicatorObservers) observer.disconnect();
    indicatorObservers.length = 0;
    layoutObserver?.disconnect();
    if (rescanTimer) clearTimeout(rescanTimer);
  };
}
