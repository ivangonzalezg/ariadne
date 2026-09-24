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
    // Ojo: no comparar contra prev.endMs - en las ventanas crudas (antes de
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

function findMatch(eligibleWindows, timestampMs, maxLabelDistanceMs) {
  // Dos ventanas de hablantes adyacentes, cada una con su margen de tolerancia,
  // se solapan cerca de la transición. Hay que preferir siempre la ventana que
  // contiene el timestamp de forma exacta (sin tolerancia) antes de caer al
  // matching tolerante - si no, .find() puede devolver la ventana anterior
  // (la primera en el array) para un caption que en realidad cae dentro de la
  // ventana siguiente.
  const exactMatch = eligibleWindows.find((window) => timestampMs >= window.startMs && timestampMs < window.endMs);
  return (
    exactMatch ??
    eligibleWindows.find(
      (window) => timestampMs >= window.startMs - maxLabelDistanceMs && timestampMs < window.endMs + maxLabelDistanceMs
    )
  );
}

// Averigua cuál es el nombre real del propio usuario una sola vez, por
// consenso de mayoría a lo largo de TODA la sesión (no ventana por ventana).
// Corregido tras verificación manual contra una reunión real (Tarea 8): usar
// "la ventana que matchea en este instante" ingenuamente permitía que el
// indicador de OTRO participante, si se solapaba por casualidad justo cuando
// el propio quedaba en silencio, le robara la línea a la caption "You" y le
// pusiera el nombre de esa otra persona real. Fijar la identidad propia por
// mayoría hace que un solape aislado de un tercero no alcance para desplazar
// al nombre que realmente predomina en las capturas "You" de la sesión.
function resolveSelfName(captions, eligibleWindows, maxLabelDistanceMs) {
  const counts = new Map();
  for (const { speaker, timestampMs } of captions) {
    if (speaker !== "You") continue;
    const match = findMatch(eligibleWindows, timestampMs, maxLabelDistanceMs);
    if (!match) continue;
    counts.set(match.speakerName, (counts.get(match.speakerName) ?? 0) + 1);
  }
  let bestName = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      bestName = name;
      bestCount = count;
    }
  }
  return bestName;
}

export function reconcileCaptionSnapshots({ captions, speakerLabels, maxLabelDistanceMs = 100, minLabelDurationMs = 100 }) {
  if (!speakerLabels || speakerLabels.length === 0) {
    return captions.map((caption) => ({ ...caption }));
  }

  const sortedLabels = [...speakerLabels].sort((a, b) => a.timestampMs - b.timestampMs);
  const eligibleWindows = buildWindows(sortedLabels, maxLabelDistanceMs).filter(
    (window) => window.speakerName !== null && window.endMs - window.startMs > minLabelDurationMs
  );

  // Las ventanas de hablante SOLO se usan para resolver "You" -> nombre real.
  // Una caption que Meet ya atribuyó a otra persona real nunca se toca - su
  // panel de captions es la fuente de verdad para todos menos para uno mismo,
  // así que un solape de ventanas nunca le puede robar la línea a un tercero.
  const selfName = resolveSelfName(captions, eligibleWindows, maxLabelDistanceMs);

  return captions.map((caption) => {
    const { speaker, timestampMs } = caption;
    if (speaker !== "You" || selfName === null) return { ...caption };
    const match = findMatch(eligibleWindows, timestampMs, maxLabelDistanceMs);
    if (!match || match.speakerName !== selfName) return { ...caption };
    return { ...caption, speaker: `${selfName} (You)` };
  });
}
