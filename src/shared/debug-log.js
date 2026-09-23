// src/shared/debug-log.js
// Sin dependencia de chrome.* a propósito: este módulo se bundlea por
// separado en cada contexto (ISOLATED, MAIN world, offscreen) y cada uno
// tiene su propia copia independiente del estado - ver el plan que agregó
// este archivo para el porqué.
let debugEnabled = false;

export function setDebugEnabled(enabled) {
  debugEnabled = Boolean(enabled);
}

export function isDebugEnabled() {
  return debugEnabled;
}

export function debugLog(...args) {
  if (debugEnabled) console.log(...args);
}

export function debugDebug(...args) {
  if (debugEnabled) console.debug(...args);
}
