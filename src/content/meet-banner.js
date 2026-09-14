// src/content/meet-banner.js
let bannerEl = null;
let statusEl = null;
let startButtonEl = null;
let videoButtonEl = null;
let stopButtonEl = null;

const STATE_LABELS = {
  idle: "Reunión detectada.",
  starting: "Iniciando grabación…",
  recording: "Grabando audio y transcripción.",
  "video-enabled": "Grabando audio, transcripción y video.",
  error: "No se pudo iniciar la grabación.",
};

export function showBanner({ onStart, onStop }) {
  if (bannerEl) return;

  bannerEl = document.createElement("div");
  bannerEl.id = "asterion-banner";
  Object.assign(bannerEl.style, {
    position: "fixed",
    bottom: "16px",
    right: "16px",
    zIndex: "999999",
    background: "#202124",
    color: "#fff",
    padding: "12px 16px",
    borderRadius: "8px",
    fontFamily: "sans-serif",
    fontSize: "14px",
  });

  statusEl = document.createElement("span");
  bannerEl.appendChild(statusEl);

  startButtonEl = document.createElement("button");
  startButtonEl.textContent = "Iniciar grabación";
  startButtonEl.style.marginLeft = "8px";
  startButtonEl.addEventListener("click", onStart);
  bannerEl.appendChild(startButtonEl);

  // Este botón NO lleva su propio listener acá: el clic real lo captura el bootstrap
  // MAIN world (Task 6) directamente sobre el DOM, para no perder el gesto de usuario
  // que getDisplayMedia() necesita. Solo marcamos el atributo que ese bootstrap reconoce.
  videoButtonEl = document.createElement("button");
  videoButtonEl.textContent = "Activar video";
  videoButtonEl.style.marginLeft = "8px";
  videoButtonEl.setAttribute("data-asterion-enable-video", "");
  bannerEl.appendChild(videoButtonEl);

  stopButtonEl = document.createElement("button");
  stopButtonEl.textContent = "Detener";
  stopButtonEl.style.marginLeft = "8px";
  stopButtonEl.addEventListener("click", onStop);
  bannerEl.appendChild(stopButtonEl);

  document.body.appendChild(bannerEl);
  updateBannerState("idle");
}

export function updateBannerState(state, meta = {}) {
  if (!statusEl) return;
  statusEl.textContent = STATE_LABELS[state] ?? state;
  if (startButtonEl) startButtonEl.style.display = state === "idle" || state === "error" ? "inline-block" : "none";
  if (videoButtonEl) videoButtonEl.style.display = state === "recording" ? "inline-block" : "none";
  if (stopButtonEl)
    stopButtonEl.style.display = state === "recording" || state === "video-enabled" ? "inline-block" : "none";
  if (meta.videoError) console.warn("[Asterion] No se pudo activar video:", meta.videoError);
}
