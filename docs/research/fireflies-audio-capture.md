# Cómo captura audio la extensión "Fireflies: AI meeting notes"

Investigación de ingeniería inversa sobre la extensión de Chrome `meimoidfecamngeoanhnpdjjdcefoldn` (Fireflies: AI meeting notes), versión **6.6.0**, Manifest V3, construida con Plasmo. Realizada sobre una instalación local del usuario, descargando el `.crx` oficial vía el update service de Google, quitando el header CRX3 y descomprimiendo el bundle JS (webpack + Babel, con comentarios y nombres originales preservados).

Análisis hecho en paralelo por dos agentes independientes (Claude y Codex) sobre el mismo código fuente extraído, sin compartir hallazgos entre sí, y consolidado acá.

## 1. Permisos declarados

```json
"permissions": ["scripting", "storage", "activeTab", "offscreen",
  "unlimitedStorage", "notifications", "tabs", "webNavigation", "idle", "cookies"],
"host_permissions": ["<all_urls>"]
```

**No declara `tabCapture` ni `desktopCapture`.** No hay una sola referencia a `chrome.tabCapture` o `chrome.tabs.captureVisibleTab` en todo el bundle. Esto descarta de entrada las APIs privilegiadas de captura de Chrome: todo el mecanismo se construye sobre APIs estándar de la Web Platform (`getUserMedia`, `getDisplayMedia`, WebRTC, Web Audio) ejecutadas dentro del contexto de la propia página de Meet o de un *offscreen document*.

## 2. El mecanismo real: secuestro de WebRTC ("web-stenographer")

Este es el camino que **efectivamente se usa** en la versión actual (ver §3 sobre el camino alternativo, que existe en el código pero está desactivado).

`background.6a63dbdb.js` inyecta `web-stenographer-injector.b3e93dff.js` directamente en el **main world** de `meet.google.com` (no como content script en isolated world, que no tendría acceso a los objetos WebRTC reales de la página):

```js
chrome.scripting.executeScript({
  target: { tabId, allFrames: true },
  injectImmediately: true,
  world: "MAIN",
  func: webStenographer.run
})
```

Una vez inyectado, **reemplaza `window.RTCPeerConnection`** antes de que el código de Meet lo use:

- Envuelve el constructor completo: cada `RTCPeerConnection` que Meet crea queda registrada y sus eventos (`track`, `datachannel`, `connectionstatechange`) quedan escuchados.
- Parchea `RTCPeerConnection.prototype.addTrack`: cuando Meet agrega un track de audio local (el micrófono del usuario, camino hacia afuera), lo intercepta.
- Escucha el evento `track` de cada conexión para capturar los tracks de audio **remotos** (los demás participantes) a medida que llegan.
- Parchea también `RTCRtpSender.prototype.replaceTrack`, recorre `getReceivers()`, observa asignaciones a `HTMLMediaElement.srcObject` e intercepta `AudioNode.prototype.connect` — puntos de intercepción adicionales para no depender de un solo hook y tolerar cambios internos de cómo Meet cablea su audio.
- Envuelve `createDataChannel` para registrar listeners sobre canales con label `captions` y `captions_v2` — **estos no transportan audio**, transportan el texto de los subtítulos en vivo que genera Meet internamente (decodificado como protobuf), y es de ahí de donde sale la transcripción en tiempo real, sin que Fireflies tenga que correr su propio speech-to-text para eso.

Nada de esto dispara un permiso ni un diálogo del navegador: es lectura pasiva de streams y canales que Meet ya crea por su cuenta.

Cada `MediaStream` de audio detectado (local o remoto) se agrega a un registro interno (`M.set(streamId, stream)`), y `gmeetRecorder.fb0a0609.js` arranca la grabación con:

```js
sendStenographerCmd("startRecorder", { segmentTs: 2000, type: recordingType }, handleAudioData)
```

Todos los streams presentes se combinan y se graban con:

```js
new MediaRecorder(P.stream, { mimeType: "audio/webm" })
```

en fragmentos de **2000 ms** (`segmentTs: 2000`).

## 3. Camino alternativo (presente en el código, desactivado hoy): `getDisplayMedia` + mezcla manual

Existe una segunda implementación, más "de libro de texto", en `offscreen.a018690f.js` / `gmeetRecorder.fb0a0609.js`, bajo el nombre interno "Enhanced Audio":

```js
navigator.mediaDevices.getDisplayMedia({
  audio: { suppressLocalAudioPlayback: false },
  video: true,
  preferCurrentTab: true,
  systemAudio: "include"
})
```

`preferCurrentTab: true` pre-selecciona el tab actual en el picker de "compartir pantalla" para reducir fricción. Esto solo captura el audio de **salida** del tab (los remotos); para el micrófono local se pide aparte:

```js
navigator.mediaDevices.getUserMedia({ audio: true })
```

y ambos streams se mezclan con Web Audio API:

```js
audioContext = new AudioContext();
destination = audioContext.createMediaStreamDestination();
audioContext.createMediaStreamSource(tabStream).connect(destination);
audioContext.createMediaStreamSource(micStream).connect(destination);
recordingStream = destination.stream;
```

grabado con preferencia explícita por Opus:

```js
mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
  ? "audio/webm;codecs=opus" : "audio/webm";
```

Con fallback a WebRTC si `getDisplayMedia` no devuelve tracks de audio. **Pero en la versión 6.6.0 este camino está muerto**: hay una línea que fuerza siempre `audioMode = "webrtc"`, con el comentario explícito:

> *"Force webrtc so users who previously selected displayMedia don't hit the broken getDisplayMedia path."*

Es decir, `getDisplayMedia` fue el enfoque original (o un intento de mejora) y lo desactivaron por ser propenso a errores, quedando el secuestro de WebRTC como único camino activo.

## 4. Qué pasa con el audio después de capturarlo

1. **Cada fragmento de 2s** (blob `webm`) se convierte a base64 y se envía al service worker vía mensaje `add-fragment`.
2. El service worker (`background.6a63dbdb.js`) persiste cada fragmento en **IndexedDB** (vía Dexie), descrito en un comentario del propio código como *"la fuente de verdad durable: cada chunk se persiste transaccionalmente al llegar"*. No se guarda audio en `chrome.storage`.
3. Al finalizar la reunión, un **offscreen document** (`chrome.offscreen.createDocument`, justificación: *"Spawn ffmpeg worker for audio transcoding"*) concatena los fragmentos y corre **ffmpeg.wasm** (`assets/ffmpeg/*.wasm`) para transcodificar el resultado a **MP3**.
4. El service worker pide una URL de subida firmada vía GraphQL:
   ```
   mutation startUpload(...) { uploadUrl mediaUrl }
   ```
   contra `https://gateway.fireflies.ai/graphql`.
5. El offscreen document sube el MP3 con `fetch(uploadUrl, { method: "PUT", body: blob })` a `https://media-storage.firefliesapp.com`.
6. Si el offscreen document no está disponible por algún motivo, hay un **fallback explícito** (`uploadAudioInServiceWorker`) para subir directamente desde el service worker.

**Captions en tiempo real** viajan por un canal separado, un WebSocket dedicado:

```
wss://realtime-ff-streaming.firefliesapp.com/ingest
```

con batching (`REALTIME_CAPTION_BATCH_INTERVAL_MS: 3000`) y reintentos (`REALTIME_MAX_RETRIES: 3`), usado activamente vía `client.sendTranscript(captions)`. El cliente WebSocket expone también un método `sendAudioData()`, pero no se encontró ninguna llamada real a él en el código revisado — el streaming de audio crudo en vivo, si existe, no está confirmado como código activo.

## 5. Por qué la arquitectura es así (particularidades de Manifest V3)

- El service worker de MV3 se termina tras ~30s de inactividad, lo cual es incompatible con `MediaRecorder`/`AudioContext`/ejecutar ffmpeg.wasm (que necesitan un contexto de página persistente). Por eso usan un **offscreen document**, que no está sujeto a ese idle-termination.
- Hay watchdogs explícitos sobre el pipeline de ffmpeg (`FFMPEG_LOAD_TIMEOUT_MS: 180000`, `FFMPEG_RUN_TIMEOUT_MS: 1200000`) diseñados para evitar que una transcodificación colgada deje una reunión atascada en estado `TRANSCODING` para siempre, coordinados con una ventana de re-despacho del lado del service worker (`STALE_TRANSCODE_MS: 30m`) para no pisarse entre reintentos.
- Todo el diseño de persistencia en IndexedDB + reintentos de upload está pensado explícitamente para sobrevivir a que el service worker se reinicie a mitad de una grabación — el propio código lo documenta en comentarios.

## Resumen en una frase

Fireflies no usa las APIs de captura de Chrome pensadas para esto (`tabCapture`/`desktopCapture`); en cambio, inyecta un script en el contexto principal de `meet.google.com` que reescribe `RTCPeerConnection` para leer directamente los audio tracks y los data channels de captions que Google Meet ya transporta internamente, mezcla remoto+micrófono cuando aplica, trocea la grabación cada 2 segundos, la persiste en IndexedDB, la transcodifica a MP3 con ffmpeg.wasm dentro de un offscreen document (para sobrevivir al ciclo de vida efímero del service worker), y la sube por HTTP PUT a storage propio vía URL firmada por GraphQL — mientras las captions en vivo viajan aparte, en tiempo real, por un WebSocket dedicado.

---
*Nota: código fuente extraído disponible temporalmente en el scratchpad de la sesión que hizo esta investigación; no se versiona en este repo.*
