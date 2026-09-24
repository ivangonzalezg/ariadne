# Captions vía WebRTC data channel (homologación parcial con Fireflies)

## Contexto

Investigamos cómo la extensión "Fireflies: AI meeting notes" captura audio y transcripción de Google Meet (descompilando su `.crx` oficial, documentado en [docs/research/fireflies-audio-capture.md](/Users/ivangonzalez/Documents/projects/personal/asterion/docs/research/fireflies-audio-capture.md)) y lo comparamos contra la implementación actual de Ariadne ([docs/research/fireflies-vs-ariadne-audio-capture.md](/Users/ivangonzalez/Documents/projects/personal/asterion/docs/research/fireflies-vs-ariadne-audio-capture.md), ya revisado por Codex).

El usuario pidió homologar la captura de audio + transcripción en vivo al nivel de Fireflies, manteniendo a Ariadne 100% local (sin backend propio, sin subir nada a la nube — eso quedó descartado explícitamente). De los dos pilares de esa homologación:

- **Robustez de captura de audio**: Ariadne ya usa el mismo mecanismo central que Fireflies (secuestro de `RTCPeerConnection` en main world). La única brecha identificada (`getReceivers()` como hook de respaldo) es menor y queda fuera de este plan — es un plan aparte si se decide encararlo.
- **Transcripción en vivo**: hoy Ariadne lee el DOM del panel de captions de Meet (`MutationObserver` + selectores CSS), lo cual es frágil (depende de que el panel esté renderizado, y de selectores CSS que Google puede cambiar sin aviso). Fireflies en cambio lee directamente el data channel interno de WebRTC que Meet usa para transmitir captions (`"captions"` v1 y `"captions_v2"`), decodificando mensajes binarios (gzip opcional + protobuf). **Este plan cubre exclusivamente esta segunda pieza.**

Reverse-engineering ya hecho y confirmado (ver research docs + sesión de Codex `01a0d11f-6de4-7112-a1aa-dc13828a1626`):

- Ambos data channels llegan como `ArrayBuffer`, opcionalmente comprimidos con gzip (firma `1f 8b 08`).
- **`captions` (v1)**: `CaptionWrapper{1:caption(embedded Caption), 2:unknown(string)}`, `Caption{1:deviceSpace(string), 2:captionId(int64), 3:version(int64), 6:caption(string)=texto, 8:languageId(int64)}`.
- **`captions_v2`**: `envelope{1:header{1:captionId(varint), 2:version(varint), 3:body{2:isFinal(bool), 3:text(string), 4:language(string), 5:translationLanguage(string), 6:deviceSpace(string)}}, 6:timestamp{1:timestampSeconds(varint)}}`.
- **`deviceSpace` es un ID de dispositivo, no un nombre.** Fireflies lo resuelve contra un "roster" que viaja por otro canal/RPC no investigado. Nosotros NO vamos a decodificar ese roster en este plan (quedó fuera de alcance, ver decisión de producto abajo).

### Decisión de producto (ya tomada por el usuario)

Se migra la **fuente de texto** de las captions al data channel `captions_v2` (más robusto: no depende de que el panel esté visible, trae `isFinal`/`captionId`/`version` para manejar revisiones parciales→finales de forma limpia en vez de diffing por mutación DOM). A cambio, se **acepta una atribución de hablante degradada** para participantes que no sean uno mismo: por defecto `speaker: "unknown"`, hasta un spike futuro (fuera de este plan) que investigue el roster de Meet. El DOM de captions actual (`meet-caption-observer.js`) se conserva, pero deja de ser la fuente canónica del texto grabado — pasa a un rol de validación/aprendizaje oportunista (ver Tarea 8, opcional).

Esta decisión fue revisada por Codex (consulta de arquitectura, sesión aparte) antes de cerrarse, con dos correcciones importantes a la propuesta inicial que ya están incorporadas en este plan:

1. **No inventar atribución de hablante por ventanas de tiempo** (mi propuesta original de extender `speaker-label-reconciler.js` para adivinar el hablante de cada caption). Codex la marcó como no confiable — `speaker-observer.js` solo emite en cambios, no tiene heartbeat, y puede dejar a alguien atribuido indefinidamente si deja de hablar sin una mutación DOM observable. Se prefiere `"unknown"` explícito antes que un nombre incorrecto con apariencia de certeza.
2. **Usar `DecompressionStream("gzip")` nativo en vez de traer `pako`** — el manifest ya declara `minimum_chrome_version: 116`, y Compression Streams está soportado desde Chromium 80, así que hay margen de sobra. Evita agregar una dependencia de runtime nueva (hoy el proyecto solo tiene `@ffmpeg/ffmpeg`).
3. **Parser protobuf propio, minimalista, no `protobufjs`** — reimplementación limpia (sin copiar código de Fireflies) del wire-format TLV/varint ya documentado arriba, limitada a los campos que necesitamos.

## Arquitectura

```
RTCPeerConnection.createDataChannel("captions"/"captions_v2")   [MAIN world, Meet lo crea]
  → caption-datachannel-patch.js: intercepta "message", detecta gzip, delega a gzip-inflate.js
  → caption-protobuf-decoder.js: decodifica bytes → {channel, captionId, version, text, isFinal, deviceSpace, timestampSeconds}
  → caption-assembler.js: agrupa por clave (deviceSpace+captionId), descarta revisiones stale (version menor a la vista), arma snapshot final cuando isFinal o el canal queda inactivo
  → bootstrap.js: durante una sesión activa, emite asterion:caption-snapshot {speaker:"unknown", text, timestampMs, captionId} vía postToIsolated (mismo canal que ya usa speaker-label)
  → meet-detector.js: reenvía tal cual por chrome.runtime.sendMessage (sin cambios, ya lo hace para asterion:speaker-label)
  → offscreen.js → SessionWriter.onCaptionSnapshot (sin cambios, ya solo acumula)
  → SessionWriter._finalizeOnce(): CaptionParser ahora soporta snapshots con captionId (agrupa por captionId) y sin él (legado DOM, agrupa por speaker consecutivo) → transcripcion.json (mismo formato de salida)
```

El patch de `createDataChannel` se instala siempre al cargar el bootstrap (igual que `installRtcPatch`/`installGetUserMediaPatch` hoy), no solo durante una sesión — así se puede loguear diagnóstico de timing (cuándo Meet crea el canal, cuándo llega el primer mensaje, relación con el click del toggle de captions) independientemente de si se está grabando. Los snapshots solo se reenvían al pipeline de grabación cuando hay una sesión activa (mismo patrón que ya usa `speaker-observer.js`).

> **Corrección de Codex (revisión del desglose de tareas, ver más abajo):** con el gating actual, `setDebugEnabled` solo se activa al recibir `asterion:start-session` (ver `offscreen.js`/`bootstrap.js`) — instalar el patch antes de eso no va a producir logs *visibles* hasta que arranque una sesión, aunque el patch en sí esté activo desde antes. El diagnóstico de timing real de creación del canal (label, primer mensaje) queda entonces limitado a sesiones que ya arrancaron, salvo que se decida explícitamente habilitar logging fuera de sesión (no está en el alcance de este plan).

`meet-caption-observer.js` se seguirá ejecutando sin cambios funcionales, pero deja de mandar `asterion:caption-snapshot` como fuente canónica (para no duplicar/mezclar texto con la fuente nueva). Su uso pasa a validación/telemetría (Tarea 7) y, opcionalmente, aprendizaje de `deviceSpace → nombre` cuando hay coincidencia inequívoca de texto+tiempo (Tarea 8, explícitamente opcional/descartable).

## Tareas

Todas las tareas se delegan a Codex (`codex:codex-rescue`, `gpt-5.6-terra`, esfuerzo `medium` salvo que se indique otro) siguiendo las reglas de `CLAUDE.md`: referenciar este archivo de plan (`docs/superpowers/plans/2026-09-24-webrtc-captions-datachannel.md`) y el número de tarea exacto, listar los archivos exactos, y pedir que reporte qué verificó y qué no pudo verificar sin una reunión real.

> **Orden corregido tras revisión de Codex del desglose de tareas** (no de la arquitectura de fondo, esa ya estaba cerrada): el orden original 5→6→7 tenía una dependencia oculta rota. `SessionWriter` pasa todos los snapshots por `reconcileCaptionSnapshots()` (`speaker-label-reconciler.js`) ANTES de que `CaptionParser` los vea — y ese reconciler hoy destructura explícitamente solo `{ speaker, text, timestampMs }` de cada caption (líneas 75 y 89-94), descartando `captionId` en silencio. Si la Tarea 6 (soporte dual de `CaptionParser`) se ejecuta sin arreglar esto primero, nunca va a recibir `captionId` y no tiene ningún efecto. Orden correcto: **1 → 2 → 3 → 4 → 6 (ahora incluye el fix del reconciler) → 5+7 (como cambio atómico) → 9 → 8 (opcional, al final)**.

### Tarea 1 — Utilidades base: gzip inflate + parser TLV/varint

**Files:** `src/lib/gzip-inflate.js`, `src/lib/gzip-inflate.test.js`, `src/lib/protobuf-lite.js`, `src/lib/protobuf-lite.test.js`

- `gzip-inflate.js`: función `maybeGunzip(bytes)` — detecta la firma mágica `1f 8b 08`; si está presente, descomprime con `DecompressionStream("gzip")` (async) con un límite de tamaño de salida (p. ej. 1 MB) para evitar payloads patológicos; si no está, devuelve los bytes tal cual. Debe capturar errores de descompresión y devolver `null` en vez de propagar la excepción (el llamador decide qué hacer con un mensaje corrupto).
- `protobuf-lite.js`: `forEachField(bytes, callback)` — camina el wire-format TLV/varint (key = fieldNumber+wireType, varint, 64-bit fixed, 32-bit fixed, length-delimited) llamando `callback({field, wire, value, bytes})` por cada campo, saltando tipos desconocidos. Debe leer varints grandes (captionId/version) como `BigInt` cuando excedan `Number.MAX_SAFE_INTEGER`, y tener límites de profundidad/tamaño para no colgarse con un mensaje corrupto o recursivo.
- Tests con fixtures binarios construidos a mano (no copiados de Fireflies) cubriendo: mensaje sin gzip, mensaje con gzip válido, gzip corrupto, campos desconocidos intercalados, varints grandes.

### Tarea 2 — Decodificador de captions (v1 y v2)

**Files:** `src/lib/caption-protobuf-decoder.js`, `src/lib/caption-protobuf-decoder.test.js`

- Usa `protobuf-lite.js` (Tarea 1) para implementar `decodeCaptionV1(bytes)` (esquema `CaptionWrapper`/`Caption`) y `decodeCaptionV2(bytes)` (esquema anidado `envelope/header/body/timestamp`), documentados arriba en este plan.
- Salida normalizada única: `{ schema: "v1"|"v2", captionId, version, text, isFinal, deviceSpace, languageId, timestampSeconds }` (campos no presentes en un esquema quedan `null`; `isFinal` no existe en v1 → `null`).
- Debe tolerar mensajes malformados devolviendo `null` en vez de tirar excepción.
- Tests con fixtures binarios sintéticos para ambos esquemas (caption simple, campo `unknown` en v1 que debe descartar el mensaje, `isFinal` true/false en v2, campos de texto con UTF-8 no ASCII).

### Tarea 3 — Patch de `createDataChannel` + captura del canal de captions

**Files:** `src/webrtc-bootstrap/caption-datachannel-patch.js`, `src/webrtc-bootstrap/caption-datachannel-patch.test.js`

- Nuevo módulo hermano de `rtc-patch.js` (no modificar `rtc-patch.js` en esta tarea). Exporta `installCaptionsDataChannelPatch({ onCaptionMessage, log })`, análogo en estilo a `installRtcPatch`/`installReplaceTrackPatch` de `src/webrtc-bootstrap/rtc-patch.js:24-93` (mismo patrón de envolver el método original, ser idempotente, loguear antes de filtrar).
- Parchea `RTCPeerConnection.prototype.createDataChannel`: cuando el `label` creado es `"captions"` o `"captions_v2"`, agrega un listener de `"message"` que: usa `maybeGunzip` (Tarea 1) sobre `event.data`, decodifica con `decodeCaptionV1`/`decodeCaptionV2` según el label (Tarea 2), y llama `onCaptionMessage(decoded, { channelLabel, receivedAtMs: Date.now() })`. Mensajes que fallan a descomprimir o decodificar se loguean y se descartan (no deben cortar la sesión).
- Loguear también la creación del canal en sí (label, `readyState` inicial) y el primer mensaje recibido — esto es diagnóstico para decidir más adelante (fuera de este plan) si `ensureCaptionsEnabled` sigue siendo necesario.
- Idempotencia: `installRtcPatch` (el patch existente de `track`/`connectionstatechange`) hoy NO tiene guard contra doble wrapping si se llama dos veces — no copiar ese hueco. `installCaptionsDataChannelPatch` debe ser explícitamente idempotente (una segunda llamada no debe volver a envolver `createDataChannel`), igual que ya hace `installReplaceTrackPatch` en `rtc-patch.js:151,178-181`.
- Validar que `event.data` sea binario (`ArrayBuffer`/`Uint8Array`) antes de pasarlo a `maybeGunzip` — un mensaje de texto plano en un canal con label coincidente (poco probable pero no imposible) no debe romper el listener.
- **Privacidad — corrección de Codex**: por defecto, los logs de diagnóstico de esta tarea (creación de canal, mensajes recibidos) NO deben incluir el texto decodificado de la caption en claro — solo metadata (label del canal, tamaño en bytes, timestamps, `captionId`/`version` truncados o hasheados, `isFinal`). Si hace falta loguear el texto real para debugging puntual, debe ser un flag separado y explícito (no activado por el mismo `debugLogging` general), documentado como tal. Este proyecto se define por ser 100% local y privado — no hay que aflojar eso solo para facilitar el debugging de esta feature.
- **Corrección de Codex**: `FakePeerConnection` (el mock usado en `rtc-patch.test.js` para los tests existentes de `installRtcPatch`) NO implementa `createDataChannel` hoy — no asumir que se puede reusar tal cual. Extenderlo (o crear un mock hermano específico) para que soporte `createDataChannel` + simular eventos `"message"` en el canal devuelto.
- Tests: sobre el mock extendido de `RTCPeerConnection`/`RTCDataChannel`, verificar que labels que no son de captions no se tocan, que un mensaje gzip corrupto no rompe el listener de otros mensajes, que una segunda llamada a `installCaptionsDataChannelPatch` no duplica listeners.

### Tarea 4 — Assembler de captions por `captionId`+`deviceSpace`

**Files:** `src/webrtc-bootstrap/caption-assembler.js`, `src/webrtc-bootstrap/caption-assembler.test.js`

- Recibe los mensajes decodificados de la Tarea 3 (`onCaptionMessage`) y los agrupa por clave `${deviceSpace}:${captionId}`.
- Descarta revisiones stale: si llega un mensaje con `version` menor a la última vista para esa clave, se ignora.
- Mantiene por clave: `firstReceivedAtMs`, `lastUpdatedAtMs`, último `text`, último `isFinal`.
- Expone un callback `onCaptionFinalized({ captionId, deviceSpace, text, startMs: firstReceivedAtMs, endMs: lastUpdatedAtMs })` que se dispara cuando `isFinal === true` (canal v2) o, para v1 (que no tiene `isFinal`), cuando no llegó una nueva revisión de esa clave en una ventana de inactividad configurable (p. ej. 2000ms — mismo orden de magnitud que el chunking de audio existente en `session.js:4`).
- **Gaps señalados por Codex, a cubrir explícitamente:**
  - `flush()`/`finalizePending()`: debe existir y llamarse al detener la sesión (`stop()` en `session.js`/`bootstrap.js`) — si no, un caption v1 todavía dentro de la ventana de inactividad cuando la sesión termina se pierde para siempre (el `setTimeout` de la ventana dispara después, con `session === null`, y nadie lo recoge).
  - `reset()`: debe existir y llamarse al arrancar una sesión nueva — el assembler vive a nivel módulo (Tarea 5), así que sin reset, estado de una sesión anterior (captions a medio cerrar, versiones vistas) podría filtrarse a la siguiente.
  - Idempotencia de `onCaptionFinalized`: una revisión que llega DESPUÉS de haber disparado `isFinal` para esa clave (revisión "post-final", o una v1 que se re-abre tras la ventana de inactividad) no debe disparar el callback una segunda vez para la misma clave sin criterio explícito — decidir y documentar el comportamiento (¿se ignora? ¿se trata como un caption nuevo con la misma clave?).
  - Claves nulas: si `deviceSpace` o `captionId` vienen `null`/`undefined` del decoder, la clave `${deviceSpace}:${captionId}` podría colisionar como `"null:null"` para captions no relacionadas entre sí — manejar explícitamente (descartar el mensaje, o generar una clave única de respaldo).
- Tests: secuencia de revisiones parciales que terminan en final (v2), secuencia v1 que se cierra por inactividad, dos `captionId` intercalados (de distintos hablantes) que no se mezclan entre sí, revisión stale que se descarta, `flush()` al detener sesión con un caption v1 todavía pendiente, `reset()` entre sesiones, revisión post-final duplicada.

### Tarea 6 — `speaker-label-reconciler.js` + `CaptionParser`: preservar y usar `captionId`

**Files:** `src/lib/speaker-label-reconciler.js` (editar), `src/lib/speaker-label-reconciler.test.js` (editar), `src/lib/caption-parser.js` (editar), `src/lib/caption-parser.test.js` (editar)

- **Bug bloqueante encontrado por la revisión de Codex, confirmado leyendo el código real**: `reconcileCaptionSnapshots()` en `speaker-label-reconciler.js` destructura explícitamente solo `{ speaker, text, timestampMs }` de cada caption, tanto en el camino sin `speakerLabels` (línea 75: `captions.map(({ speaker, text, timestampMs }) => ({ speaker, text, timestampMs }))`) como en el camino con reconciliación (líneas 89-94, mismo destructuring en el `.map` final). `SessionWriter._finalizeOnce()` SIEMPRE pasa los snapshots por esta función antes de dárselos a `CaptionParser` — así que sin arreglar esto, `captionId` nunca llega al parser, sin importar qué tan bien esté hecha la Tarea original 6 (ahora fusionada acá).
- Cambio en `speaker-label-reconciler.js`: preservar `captionId` (y cualquier otro campo que venga en el snapshot que no sea `speaker`/`text`/`timestampMs`) al pasar por ambos `.map()` — el resto de la lógica de reconciliación no cambia.
- Cambio en `caption-parser.js`: `CaptionParser.onSnapshot` hoy agrupa comparando `speaker` contra el segmento `current` en construcción. Con la fuente nueva, los snapshots vienen con `speaker: "unknown"` siempre y un `captionId` estable — agrupar por `speaker` mezclaría todas las captions "unknown" en un solo segmento. Si el snapshot trae `captionId`, agrupar/actualizar el segmento por `captionId` en vez de por `speaker`. Si NO trae `captionId` (fuente DOM legada, por si se reactiva en el futuro), mantener el comportamiento actual sin cambios.
- **Matiz de Codex sobre el alcance real de "agrupar por captionId"**: `CaptionParser` solo modela UN segmento abierto (`this.current`) a la vez — no es una agrupación general por clave con múltiples segmentos abiertos en paralelo. En la práctica esto significa "el siguiente snapshot que llega, si comparte `captionId` con `current`, lo actualiza; si no, cierra `current` y abre uno nuevo". Esto es aceptable SOLO SI el assembler (Tarea 4) garantiza que cada caption se finaliza una única vez y en orden (no hay revisiones tardías de captions ya cerrados llegando entremezcladas con las de uno nuevo). Si la Tarea 4 no puede garantizar eso con los fixes de idempotencia que se le pidieron, hay que revisar este diseño antes de dar la Tarea 6 por cerrada — dejarlo como pregunta explícita a Codex al delegar esta tarea.
- El shape de salida (`finishedSegments`) no cambia: `{ speaker, text, startMs, endMs }`.
- Actualizar/agregar tests en ambos archivos que cubran: reconciler preservando `captionId` en los dos caminos (con y sin `speakerLabels`), y `CaptionParser` en ambos modos (con y sin `captionId`) sin romper los tests existentes del modo legado.

### Tarea 5+7 (ejecutar como cambio atómico) — Wiring en `bootstrap.js` + reconversión de `meet-caption-observer.js`

**Files:** `src/webrtc-bootstrap/bootstrap.js` (editar), `src/content/meet-caption-observer.js` (editar), `src/content/meet-detector.js` (editar)

Se fusionan en una sola entrega porque son dos mitades del mismo cambio: si se hace 5 sin 7, la transcripción final mezcla texto del DOM y del data channel; si se hace 7 sin 5, se pierde la transcripción completa hasta que 5 esté lista.

- **`bootstrap.js`**: instalar `installCaptionsDataChannelPatch` a nivel módulo (junto a las llamadas existentes de `installRtcPatch`/`installGetUserMediaPatch`/`installReplaceTrackPatch` en `bootstrap.js:25-68`), conectado a un `caption-assembler.js` (Tarea 4) que vive también a nivel módulo. Cuando `onCaptionFinalized` dispara: **si hay una sesión activa** (`session` no es `null`, mismo patrón que ya filtra otros eventos en `bootstrap.js:122-134`), emitir `postToIsolated({ type: "asterion:caption-snapshot", sessionId, snapshot: { speaker: "unknown", text, timestampMs: endMs, captionId: \`${deviceSpace}:${captionId}\` } })`. Si no hay sesión activa, descartar. Llamar `caption-assembler.reset()` al arrancar sesión y `flush()` al detenerla (ver Tarea 4). No tocar `speaker-observer.js`/`asterion:speaker-label` en esta tarea.
- **`meet-detector.js` — pieza que faltaba en el plan original, señalada por Codex**: hoy `asterion:caption-snapshot` nace directamente en `meet-detector.js` (isolated world, leyendo el DOM) y NO existe ninguna rama que reenvíe un `asterion:caption-snapshot` que venga del MAIN world vía `postToIsolated` (a diferencia de `asterion:speaker-label`, que sí tiene ese camino MAIN→isolated→`chrome.runtime.sendMessage` ya armado). Hay que agregar esa rama nueva en el listener de `window.addEventListener("message", ...)` de `meet-detector.js`, análoga a la de `asterion:speaker-label`, que reenvíe el `asterion:caption-snapshot` recibido del main world por `chrome.runtime.sendMessage` tal cual.
- **`meet-caption-observer.js`**: mantener `ensureCaptionsEnabled` (sigue siendo necesario para que Meet renderice, y probablemente para que cree el data channel — no confirmado) y `observeCaptions`, pero el snapshot del DOM deja de mandarse como `asterion:caption-snapshot` desde `meet-detector.js` (dejar de invocar `chrome.runtime.sendMessage` con ese snapshot en el callback que hoy está en `meet-detector.js` ~línea 109). En su lugar, solo cuando `debugLogging` esté activo, loguear localmente **solo metadata del snapshot DOM** (timestamp, longitud del texto, si hay speaker) — **no el texto completo en claro por defecto** (mismo criterio de privacidad que la Tarea 3; si hace falta el texto real para comparar manualmente en la Tarea 9, usar un flag separado y explícito, no el `debugLogging` general).

### Tarea 8 (opcional / descartable — requiere un diseño de wiring adicional antes de delegarse)

**Files:** por definir en el diseño previo (ver abajo) — probablemente `src/webrtc-bootstrap/speaker-identity-learner.js` + cambios en `meet-caption-observer.js`, `meet-detector.js` y `bootstrap.js`

**Corrección de Codex, importante**: tal como estaba descrita originalmente, esta tarea NO es implementable. Después de la Tarea 5+7, los snapshots DOM solo van a la consola de logging local (dentro de `meet-caption-observer.js`/`meet-detector.js`, isolated world) — un `speaker-identity-learner.js` en MAIN world (donde vive el assembler de la Tarea 4) no tiene forma de consumirlos sin un canal de transporte nuevo (isolated → main world es la dirección contraria a como hoy circulan los mensajes: hoy siempre es main → isolated vía `postToIsolated`, nunca al revés).

Antes de delegar esta tarea a Codex, hay que resolver (Claude, con el usuario si es una decisión de producto) un diseño explícito de transporte isolated→main para los snapshots DOM de validación, o mover el aprendizaje al lado isolated/offscreen en vez de main world. Al delegarla, pedirle a Codex además que evalúe si vale la pena esta tarea en absoluto o si prefiere recomendar ir directo al spike del roster (decisión de arquitectura menor pero no trivial — CLAUDE.md pide consultarlo en vez de que Codex decida en silencio).

- Si se resuelve el transporte: correlaciona, dentro de una sesión activa, los snapshots DOM contra los snapshots del data channel por proximidad de texto (substring/prefix match) y ventana de tiempo ajustada (p. ej. ±500ms). Cuando hay coincidencia inequívoca Y el nombre DOM no es `"You"`/ambiguo, aprende `deviceSpace → nombre` para esa sesión y lo aplica a esa clave (y a futuras revisiones) en el assembler de la Tarea 4.
- Debe ser estrictamente best-effort: si no hay coincidencia clara, se deja `"unknown"`. No debe convertirse en la fuente de verdad.

### Tarea 9 — Verificación manual end-to-end

No delegable a Codex sin supervisión — requiere una reunión real de Meet con al menos 2 participantes hablando (uno debe ser el usuario) con captions activados.

Checklist:
- El data channel `captions_v2` se crea y llegan mensajes (confirmar en logs de diagnóstico de la Tarea 3).
- La transcripción final (`transcripcion.json`) tiene texto coherente, sin duplicados ni segmentos cortados a la mitad.
- Comparar manualmente contra los logs de validación DOM (Tarea 5+7) para evaluar qué tan buena es la transcripción de la fuente nueva vs. la vieja.
- Confirmar que reuniones donde el usuario nunca activó captions manualmente igual terminan con `ensureCaptionsEnabled` activándolas y el data channel funcionando.
- **Agregado por la revisión de Codex**: detener la grabación a mitad de una oración (mientras una caption v1 todavía está dentro de la ventana de inactividad, sin cerrar) y confirmar que el `flush()` de la Tarea 4 la recupera en vez de perderla.
- **Agregado por la revisión de Codex**: confirmar que un mensaje "final" duplicado (Meet reenvía la misma revisión final dos veces, algo que se ha visto en el research de Fireflies) no genera un segmento repetido en la transcripción.
- Si se hizo la Tarea 8: medir qué porcentaje de captions quedaron `"unknown"` vs. resueltas por aprendizaje oportunista.

**Resultado real (dos reuniones de prueba, 2026-09-24):**

- El canal que Meet creó en la práctica fue `"captions"` (v1), no `"captions_v2"` — bueno que se implementaron ambos esquemas.
- `flush()` confirmado funcionando: se cortó la grabación a mitad de una frase y el fragmento pendiente llegó igual a la transcripción (commit `c7d04b2`).
- El gating por sesión activa funcionó: mensajes del data channel que siguieron llegando después de `stop-session` no se filtraron a la sesión ya cerrada.
- Calidad de texto: coherente, sin cortes ni pérdida evidente en la prueba corta.
- **Bug encontrado y corregido** (commit `8faab84`): Meet reutiliza el mismo `captionId` v1 crudo entre turnos de habla distintos dentro de una misma sesión. Como `bootstrap.js` reenviaba `${deviceSpace}:${captionId}` tal cual hacia `CaptionParser`, dos captions finalizados por separado por el assembler (cada uno ya una frase completa y correcta) podían terminar con la misma clave compuesta y `CaptionParser` los fusionaba en un solo segmento, pisando el texto del primero con el del segundo. Evidencia: en la primera transcripción de prueba, dos pares de segmentos mostraban el patrón "uno con duración de varios segundos + uno de un instante que lee como su continuación natural" - señal de una fusión indebida. Fix: `bootstrap.js` ahora etiqueta cada snapshot emitido con un contador incremental propio (`captionSequence`, sin reset entre sesiones) en vez de reusar el id crudo de Meet.
- Speakers en `"unknown"` para todos los participantes: esperado, es la decisión de producto ya tomada (ver "Decisión de producto" arriba).
- Pendiente de una prueba con una reunión más larga: mensaje "final" duplicado, y medición si `captions_v2` aparece en algún momento (puede depender de la versión de Meet/cuenta).

## Archivos existentes relevantes (referencia, no se listan de nuevo por tarea)

- [src/webrtc-bootstrap/rtc-patch.js](/Users/ivangonzalez/Documents/projects/personal/asterion/src/webrtc-bootstrap/rtc-patch.js) — patrón a seguir para nuevos patches de WebRTC.
- [src/webrtc-bootstrap/bootstrap.js](/Users/ivangonzalez/Documents/projects/personal/asterion/src/webrtc-bootstrap/bootstrap.js) — orquestación main world, mensaje `asterion:start-session`/`asterion:stop-session`.
- [src/lib/caption-parser.js](/Users/ivangonzalez/Documents/projects/personal/asterion/src/lib/caption-parser.js) y [src/lib/speaker-label-reconciler.js](/Users/ivangonzalez/Documents/projects/personal/asterion/src/lib/speaker-label-reconciler.js) — pipeline de reconciliación existente. **Corrección respecto a la primera versión de este plan: sí hay que tocar `speaker-label-reconciler.js`** (Tarea 6) para que deje de descartar `captionId`.
- [src/storage/session-writer.js](/Users/ivangonzalez/Documents/projects/personal/asterion/src/storage/session-writer.js) — consumidor final, no debería necesitar cambios si el shape de snapshot se mantiene compatible.
- [src/content/meet-detector.js](/Users/ivangonzalez/Documents/projects/personal/asterion/src/content/meet-detector.js) y [src/content/meet-caption-observer.js](/Users/ivangonzalez/Documents/projects/personal/asterion/src/content/meet-caption-observer.js) — fuente DOM actual, pasa a validación (Tarea 5+7).
- [src/webrtc-bootstrap/rtc-patch.test.js](/Users/ivangonzalez/Documents/projects/personal/asterion/src/webrtc-bootstrap/rtc-patch.test.js) — tiene el mock `FakePeerConnection` a extender (Tarea 3) para soportar `createDataChannel`.

## Fuera de alcance (explícitamente, para no scope-creep)

- Decodificar el roster de Meet (`deviceSpace → nombre`) — spike futuro separado.
- Cualquier cosa relacionada al pipeline de audio (ya está a la par de Fireflies en lo esencial).
- El hardening con `getReceivers()` identificado en la comparación anterior — plan aparte si se decide encararlo.
- Subir nada a un backend propio — descartado explícitamente por el usuario.

## Verificación

- Cada tarea 1-6 y 8 tiene tests unitarios que Codex debe correr y hacer pasar antes de commitear (`npm test` o el runner que use el proyecto — confirmar con `package.json`).
- Tarea 9 es verificación manual end-to-end, no automatizable sin una reunión real.
- **Hecho**: Codex revisó el desglose de tareas línea por línea (después de la consulta de arquitectura de la sesión `01a0d11f-6de4-7112-a1aa-dc13828a1626`, que cubrió solo la decisión de fondo). Encontró un bug bloqueante (pérdida de `captionId` en `speaker-label-reconciler.js`, confirmado leyendo el código real antes de aceptar el hallazgo) y varios gaps de robustez/privacidad, todos ya incorporados arriba: reordenamiento de tareas, fusión de 5+7, reescritura de la Tarea 6, gaps de `flush()`/`reset()`/idempotencia en la Tarea 4, guard de idempotencia y privacidad de logs en la Tarea 3, y la Tarea 8 marcada como no ejecutable sin un diseño de transporte adicional. Con estos ajustes, el plan queda listo para arrancar la Tarea 1.
