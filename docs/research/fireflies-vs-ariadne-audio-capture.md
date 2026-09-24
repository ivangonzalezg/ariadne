# Fireflies vs. Ariadne: comparación del pipeline de captura de audio

Compara [fireflies-audio-capture.md](./fireflies-audio-capture.md) contra la implementación actual de Ariadne (`src/webrtc-bootstrap/`, `src/offscreen/`, `src/background/service-worker.js`, `manifest.json`).

> **Revisado por Codex de forma independiente** (sesión `01a0d11f-6de4-7112-a1aa-dc13828a1626`): confirmó el paralelismo arquitectónico central y varios puntos de este documento, pero marcó matices importantes — sobre todo en la hipótesis de `replaceTrack` (§1) y en algunas afirmaciones sobre Fireflies que no son verificables solo leyendo el código de Ariadne (§6). Esos matices están incorporados abajo, marcados explícitamente como tales.

## 1. Mecanismo de captura: prácticamente el mismo enfoque

Ambas extensiones llegan a la misma conclusión de diseño: **secuestrar `RTCPeerConnection` inyectando un script en el main world de `meet.google.com`**, en vez de usar `chrome.tabCapture` o pedirle al usuario que comparta pantalla.

| | Fireflies | Ariadne |
|---|---|---|
| Punto de inyección | `chrome.scripting.executeScript({world:"MAIN"})` disparado desde el service worker cuando detecta el tab | `content_scripts` estático en el manifest, `run_at: "document_start"`, `world: "MAIN"` ([manifest.json](../../manifest.json)) |
| Parcheo de `RTCPeerConnection` | Constructor + `addTrack` + eventos `track`/`datachannel`/`connectionstatechange` | Constructor + evento `track`/`connectionstatechange` ([rtc-patch.js](../../src/webrtc-bootstrap/rtc-patch.js)) |
| Parcheo de `RTCRtpSender.replaceTrack` | Sí (confirmado por el análisis de Codex) | Sí (`installReplaceTrackPatch`) |
| Parcheo de `getUserMedia` | Sí | Sí (`installGetUserMediaPatch`) |
| Otros hooks (`getReceivers`, `srcObject`, `AudioNode.connect`) | Sí | No |

**Diferencia arquitectónica real, no solo de detalle**: Fireflies inyecta *programáticamente* desde el service worker, lo que implica una carrera — el service worker tiene que enterarse de que el tab es una reunión de Meet y disparar `executeScript` antes de que Meet cree su primera `RTCPeerConnection`. Ariadne evita esa carrera por completo declarando el content script en el manifest con `document_start`, que Chrome garantiza que corre antes que cualquier script de la página. Si esta hipótesis sobre el riesgo de carrera de Fireflies es correcta (no confirmada contra código de Fireflies que la mitigue), Ariadne está en mejor posición ahí.

**Validación cruzada interesante, con matiz de Codex**: el comentario en `rtc-patch.js` sobre `installReplaceTrackPatch` documenta una hipótesis *no confirmada* de por qué la voz propia grabada sonaba más baja ("un track ya procesado internamente... una extensión comparable... sí detecta estos reemplazos, confirmado inspeccionando su código"). El análisis de Fireflies hecho en esta sesión confirma que Fireflies también parchea `RTCRtpSender.prototype.replaceTrack` — pero la revisión independiente de Codex fue explícita en separar dos cosas que es fácil mezclar:

- **Lo que el código demuestra**: el patch está bien construido para seguir un reemplazo de track de micrófono — `onAudioTrackReplaced` solo dispara después de que el `replaceTrack` original resuelve con éxito, maneja explícitamente el caso `replaceTrack(null)` sin cortar la grabación, y `bootstrap.js` reconecta el mixer al track nuevo en caliente si ya hay una sesión en curso. Además, Ariadne no depende solo de esto: al arrancar una grabación, prioriza activamente el track que el sender WebRTC está enviando *en ese momento* vía `getCurrentLocalAudioTrack()` (con preferencia por conexiones `connected`), en vez de conformarse con el track que `getUserMedia` devolvió una sola vez al principio — lo cual mitiga el problema incluso si el reemplazo ya había ocurrido *antes* de empezar a grabar.
- **Lo que el código NO demuestra**: que Meet efectivamente reemplace el track de micrófono durante una reunión real, que ese track de reemplazo tenga una ganancia o normalización distinta, o que eso sea la causa real de que la voz propia suene más baja. Que Fireflies también parchee `replaceTrack` corrobora que es un hook razonable de tener — no es evidencia de que la cadena causal "reemplazo → procesamiento de nivel → mejora audible" sea correcta. Sigue siendo una hipótesis, pendiente de confirmar contra una reunión real (ver la verificación manual del plan que introdujo este patch).

## 2. Qué NO tiene Ariadne que Fireflies sí (a propósito)

- **`getDisplayMedia` como ruta de audio completa**: Fireflies tiene (con código muerto hoy) un modo "Enhanced Audio" que pide compartir pantalla con audio del sistema. Ariadne solo usa `getDisplayMedia` para **video opcional**, nunca como fuente de audio (`bootstrap.js`, el listener de `[data-asterion-enable-video]` solo pide `{video: true}`). El audio en Ariadne sale exclusivamente del secuestro de WebRTC.
- **Interceptar el data channel de `captions`/`captions_v2` para decodificar protobuf**: Ariadne no lee el canal de datos interno de Meet. En cambio observa el DOM de los subtítulos que Meet ya renderiza en pantalla (`src/content/meet-caption-observer.js` + `meet-selectors.js`), vía `CaptionParser`. Es más frágil ante cambios de layout de Meet, pero no depende de entender un formato binario interno no documentado.
- **Más puntos de intercepción redundantes** (`getReceivers`, `srcObject`, `AudioNode.connect`): Fireflies los tiene como capas adicionales de robustez; Ariadne no. La revisión independiente de Codex evaluó cada uno puntualmente (no los trató como un bloque parejo):

  | Hook adicional | Veredicto de Codex |
  |---|---|
  | `getReceivers()` | **Único candidato razonable.** Ariadne ya captura audio remoto vía el evento `track` de cada conexión, que es el camino normal — pero `getReceivers()` serviría como fallback de reconciliación si la inyección llegara tarde o Meet cambiara un receiver sin disparar un evento visible. Bajo costo, sin evidencia hoy de que haga falta. |
  | `HTMLMediaElement.prototype.srcObject` | **Riesgoso, no solo "falta".** Interceptarlo probablemente redescubriría tracks que ya llegaron por `track`, generando doble mezcla — requeriría integrarse con cuidado con la deduplicación actual por `stream.id`. Solo tendría valor si Meet dejara de exponer audio vía `track` pero siguiera montándolo en elementos `<audio>`/`<video>`, algo sin evidencia. |
  | `AudioNode.prototype.connect` | **El menos justificado.** Ariadne arma su propio grafo de audio (remoto → destino; mic → gain → destino) a partir de los tracks WebRTC — no necesita observar el grafo interno de Meet para capturar lo que ya circula por WebRTC. Un parche global de `connect` amplía mucho la superficie (incluida la observación del propio grafo de la extensión) sin evidencia de que cubra una pérdida real. |

  Conclusión de Codex: de los tres, **solo `getReceivers()` es un candidato razonable de hardening**; los otros dos son más ruido que señal para la arquitectura actual de Ariadne.

## 3. Dedup de streams remotos: mismo esquema, confirmado independientemente

`audio-mixer.js` (`_remoteKey`) usa `stream.id` como clave **global** (no scopeada a la conexión) cuando está disponible, con un comentario que dice explícitamente que esto imita el esquema de "una extensión comparable" para evitar eco al reconectar/renegociar. El análisis de esta sesión sobre Fireflies no llegó a confirmar ese detalle específico (no se profundizó en el código de deduplicación de streams de Fireflies), así que esa hipótesis sigue en el mismo estado: plausible, revisada por Codex, pendiente de confirmar contra una reunión real.

## 4. Divergencia grande: destino de la grabación (local vs. nube)

Acá las dos arquitecturas se separan completamente, y es la diferencia de producto más importante:

| | Fireflies | Ariadne |
|---|---|---|
| Persistencia intermedia | IndexedDB (Dexie) | OPFS (`navigator.storage.getDirectory()`, un directorio por reunión) vía [SessionWriter](../../src/storage/session-writer.js) |
| Transcodificación | ffmpeg.wasm → MP3, en offscreen document | ffmpeg.wasm, en offscreen document ([ffmpeg-client.js](../../src/offscreen/ffmpeg-client.js)) — mismo mecanismo, mismo motivo (service worker efímero de MV3) |
| Destino final | Upload HTTP PUT a `media-storage.firefliesapp.com`, URL firmada vía GraphQL (`gateway.fireflies.ai`) | Se queda **local**, en el filesystem del usuario (OPFS), sin ningún backend propio |
| Transcripción | Server-side (Fireflies procesa el audio subido) + captions en vivo por WebSocket propio | Local: overlay de captions de Meet capturado y reconciliado con hablantes (`speaker-label-reconciler.js`) |
| Permisos de red | `host_permissions: <all_urls>`, `cookies`, `notifications`, `tabs`, `activeTab`, `webNavigation`, `idle` | `host_permissions: ["https://meet.google.com/*"]` únicamente, sin `cookies`/`notifications`/`tabs`/`activeTab` |

Fireflies es una arquitectura "capturar y subir" (SaaS de transcripción); Ariadne es "capturar y quedarse local" (herramienta personal, sin backend). Esto explica por qué el manifest de Ariadne es mucho más angosto en permisos y por qué no hay nada de GraphQL/WebSocket/upload en el código.

## 5. Otros detalles de implementación que difieren

- **Chunking**: Fireflies trocea cada 2000 ms; Ariadne cada 1000 ms (`CHUNK_TIMESLICE_MS` en [session.js](../../src/webrtc-bootstrap/session.js)).
- **Manejo de mute del micrófono**: Ariadne tiene un `MuteManifest` dedicado que registra timestamps de mute/unmute y aplica una rampa de gain de 10ms (`setMicMuted`) para evitar clicks audibles — no se encontró un mecanismo equivalente documentado en el código de Fireflies revisado.
- **Reconciliación de streams remotos "stale"**: Ariadne corre un `reconcile()` periódico (cada 5s) que purga fuentes muteadas por más de 15s o con track no-`live` — no se encontró un mecanismo equivalente en Fireflies.
- **Offscreen document persistente entre reuniones**: ambas usan `chrome.offscreen`, pero Ariadne documenta explícitamente que lo deja vivo entre reuniones "porque el permiso de File System Access sobre la carpeta raíz parece estar atado a la instancia del documento" — una restricción propia de usar OPFS/File System Access que Fireflies no tiene (porque no persiste en filesystem, persiste en IndexedDB + sube a la nube).
- **Finalización de sesiones abandonadas**: reciente en Ariadne (`finalizeAbandonedSession` en el service worker, commits `060bb83`/`dddb2db`/`ada60f7`). No se investigó en profundidad si Fireflies tiene un mecanismo equivalente para reuniones que el usuario abandona sin cerrar prolijamente — sería un buen punto de investigación de seguimiento si interesa.

## 6. Afirmaciones de este documento que Codex no pudo verificar de forma independiente

Codex hizo su propia comparación leyendo el código de Ariadne desde cero (sin ver este documento hasta el final) y señaló varias afirmaciones de las secciones anteriores que se apoyan en el research de Fireflies, no en algo verificable dentro de este repo:

- Que la inyección estática con `document_start` + `world: MAIN` "garantiza" correr antes que cualquier script de Meet — es una garantía documentada del comportamiento de Chrome, no algo que se pueda confirmar leyendo únicamente este repo.
- Que la inyección programática de Fireflies (`chrome.scripting.executeScript` disparada desde el service worker) sufra una carrera real, o que no tenga ninguna mitigación para eso — Ariadne no contiene el código de Fireflies como para verificarlo directamente; es una inferencia razonable a partir de cómo funciona la API, no un hecho confirmado en el código de Fireflies.
- Que Fireflies use exactamente el mismo esquema de deduplicación por `stream.id` que Ariadne (§3) — confirmado que Ariadne lo hace así, pero no se investigó a fondo el código de deduplicación de Fireflies como para asegurar que coincide.
- Que el almacenamiento OPFS de Ariadne (`navigator.storage.getDirectory()`) sea "el filesystem del usuario" en el sentido de una carpeta visible o elegida por él — el código confirma almacenamiento local por origen, no acceso directo a un directorio normal y visible del sistema de archivos.
- Que Fireflies haga la transcripción server-side, o cómo maneja específicamente reuniones abandonadas — ninguna de las dos cosas es verificable inspeccionando el código de Ariadne.

Ninguno de estos puntos resultó estar mal — son afirmaciones sobre Fireflies (no sobre Ariadne) que este research ya había sustentado en la investigación original del `.crx`, simplemente no son re-verificables solo comparando contra el código de Ariadne, y vale la distinción para no sobre-representar cuánta de esta comparación es "código contra código" versus "código de Ariadne contra documento de research".

## Conclusión

La arquitectura de captura en sí (secuestro de WebRTC vía `RTCPeerConnection` parcheado en el main world, mezcla con Web Audio API, `MediaRecorder` en chunks, offscreen document + ffmpeg.wasm por las restricciones de MV3) es esencialmente la misma idea en ambos productos, y Ariadne ya tiene varias de las protecciones que Fireflies tiene (incluido el parcheo de `replaceTrack`, que fue una hipótesis de Ariadne confirmada de forma independiente por este análisis). La diferencia de fondo no es técnica sino de producto: Fireflies sube todo a su nube para transcribir server-side; Ariadne se queda 100% local. Las brechas de robustez identificadas (hooks adicionales de `getReceivers`/`srcObject`/`AudioNode.connect`) son candidatas razonables para un futuro plan de hardening, pero sin evidencia todavía de que resuelvan un problema real observado en Ariadne.
