function buildWindows(sortedLabels, maxLabelDistanceMs) {
  const raw = sortedLabels.map((label, index) => {
    const next = sortedLabels[index + 1];
    return {
      speakerName: label.speakerName,
      startMs: label.timestampMs,
      endMs: next ? next.timestampMs : Infinity,
    };
  });

  const collapsed = [];
  for (const window of raw) {
    const prev = collapsed[collapsed.length - 1];
    // Ojo: no comparar contra prev.endMs — en las ventanas crudas (antes de
    // colapsar) prev.endMs siempre coincide exactamente con window.startMs (una
    // termina donde arranca la siguiente), así que esa resta siempre daría 0 y
    // colapsaría cualquier par del mismo hablante sin importar cuánto tiempo
    // pasó entre medio. Hay que comparar contra dónde arrancó la ventana
    // anterior (el timestamp del label que la originó).
    if (prev && prev.speakerName === window.speakerName && window.startMs - prev.startMs <= maxLabelDistanceMs) {
      prev.endMs = window.endMs;
    } else {
      collapsed.push({ ...window });
    }
  }
  return collapsed;
}

export function reconcileCaptionSnapshots({ captions, speakerLabels, maxLabelDistanceMs = 100, minLabelDurationMs = 100 }) {
  if (!speakerLabels || speakerLabels.length === 0) {
    return captions.map(({ speaker, text, timestampMs }) => ({ speaker, text, timestampMs }));
  }

  const sortedLabels = [...speakerLabels].sort((a, b) => a.timestampMs - b.timestampMs);
  const eligibleWindows = buildWindows(sortedLabels, maxLabelDistanceMs).filter(
    (window) => window.speakerName !== null && window.endMs - window.startMs > minLabelDurationMs
  );

  return captions.map(({ speaker, text, timestampMs }) => {
    // Dos ventanas de hablantes adyacentes, cada una con su margen de tolerancia,
    // se solapan cerca de la transición. Hay que preferir siempre la ventana que
    // contiene el timestamp de forma exacta (sin tolerancia) antes de caer al
    // matching tolerante — si no, .find() puede devolver la ventana anterior
    // (la primera en el array) para un caption que en realidad cae dentro de la
    // ventana siguiente.
    const exactMatch = eligibleWindows.find((window) => timestampMs >= window.startMs && timestampMs < window.endMs);
    const match =
      exactMatch ??
      eligibleWindows.find(
        (window) => timestampMs >= window.startMs - maxLabelDistanceMs && timestampMs < window.endMs + maxLabelDistanceMs
      );
    if (!match) return { speaker, text, timestampMs };
    const resolvedSpeaker = speaker === "You" ? `${match.speakerName} (You)` : match.speakerName;
    return { speaker: resolvedSpeaker, text, timestampMs };
  });
}
