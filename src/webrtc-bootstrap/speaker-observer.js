import { findSpeakerAwareIndicators, extractSpeakerNameFromIndicator } from "./speaker-dom.js";
import { findByIconText } from "../content/meet-selectors.js";

const MAX_SILENCE_DURATION_MS = 2000;
const RESCAN_DEBOUNCE_MS = 200;

export function startSpeakerObserver({ onSpeakerLabel: rawOnSpeakerLabel, log = () => {} }) {
  const onSpeakerLabel = (label) => {
    log("speaker-observer-emit", label);
    rawOnSpeakerLabel(label);
  };
  const observedIndicators = new WeakSet();
  const indicatorObservers = [];
  let silenceTimer = null;
  let lastSpeakerName = null;
  let rescanTimer = null;

  function resetSilenceTimer() {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => emit(null), MAX_SILENCE_DURATION_MS);
  }

  function emit(speakerName) {
    lastSpeakerName = speakerName;
    onSpeakerLabel({ speakerName, timestampMs: Date.now() });
    if (speakerName !== null) resetSilenceTimer();
  }

  function handleIndicatorChange(indicatorEl) {
    const speakerName = extractSpeakerNameFromIndicator(indicatorEl);
    log("speaker-observer-indicator-change", { speakerName, indicatorClass: indicatorEl.getAttribute("class") });
    if (speakerName === null) return;
    if (speakerName === lastSpeakerName) {
      // Sigue siendo el mismo hablante activo — no es un cambio para emitir,
      // pero sí es actividad real: sin este reset, alguien que habla de forma
      // continua por más de MAX_SILENCE_DURATION_MS dispararía igual el
      // marcador sintético de "silencio" a mitad de su propia intervención.
      resetSilenceTimer();
      return;
    }
    emit(speakerName);
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
    if (silenceTimer) clearTimeout(silenceTimer);
    if (rescanTimer) clearTimeout(rescanTimer);
  };
}
