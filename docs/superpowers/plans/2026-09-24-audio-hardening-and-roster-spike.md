# Hardening de audio (`getReceivers()`) + spike de roster de Meet

## Contexto

Ya cerramos la primera homologación con Fireflies: la transcripción en vivo vía el data channel WebRTC de Meet (`docs/superpowers/plans/2026-09-24-webrtc-captions-datachannel.md`), verificada contra reuniones reales, con un bug real encontrado y corregido (`8faab84` — Meet reutiliza `captionId` entre frases distintas).

Quedaron dos piezas pendientes para terminar de acercar a Ariadne al nivel de Fireflies, identificadas en `docs/research/fireflies-vs-ariadne-audio-capture.md`:

1. **Hardening de audio con `getReceivers()`**: de los tres hooks extra que tiene Fireflies y Ariadne no (`getReceivers()`, `HTMLMediaElement.srcObject`, `AudioNode.prototype.connect`), Codex ya evaluó los tres y solo recomendó `getReceivers()` como candidato razonable — los otros dos son más riesgo/ruido que beneficio para la arquitectura actual de Ariadne, y quedan fuera de alcance.
2. **Spike de investigación del roster de Meet** (`deviceSpace → nombre real`): hoy todos los participantes salvo uno mismo salen `"unknown"` en la transcripción, porque el data channel de captions solo trae un ID de dispositivo, no un nombre. Fireflies resuelve esto contra un roster interno que no investigamos. Esta pieza es **investigación de alcance y viabilidad desconocidos** — no una implementación cerrada — y puede terminar sin nada implementable, lo cual es un resultado aceptable si está bien documentado.

El usuario decidió explícitamente el alcance de este plan (ver decisión de producto abajo): estas dos piezas sí entran; la Tarea 8 original (aprendizaje oportunista de nombre vía DOM) queda afuera por ahora — es un fallback a reconsiderar solo si el spike del roster no da resultado.

Ambas piezas fueron diseñadas con una consulta de arquitectura a Codex (sesión `01a0d389-a6f1-78b2-b41b-90f2d1d726f2`) antes de cerrar este plan, siguiendo la regla del proyecto. Sus recomendaciones ya están incorporadas abajo.

## Parte A — Hardening de audio con `getReceivers()`

### Diseño (recomendado por Codex, con correcciones de una segunda revisión línea por línea — sesión `01a0d3a8-19b6-7cd0-958d-309041e889a2`)

- **Vive en `src/webrtc-bootstrap/rtc-patch.js`**, no en `audio-mixer.js` ni en un módulo nuevo — ese archivo ya posee `activeConnections`, `connectionIds` y `getConnectionId(pc)`, que es el estado que hace falta para recorrer conexiones. `audio-mixer.js` debe seguir siendo agnóstico de `RTCPeerConnection` (su rol es mezclar/deduplicar/purgar, no descubrir).
- **Mecanismo — corregido**: `MeetingAudioMixer.startReconciliation()` (`audio-mixer.js:137-140`) hoy SOLO programa `setInterval(() => this.reconcile(), intervalMs)`, que a su vez SOLO purga `remoteSources` (`audio-mixer.js:124-135`) — no hay ningún ciclo existente que un barrido de receivers pueda "reusar" sin cambios. La primera versión de este plan afirmaba eso incorrectamente. **Diseño correcto**: un único timer coordinado que viva en `bootstrap.js` (que ya inicia/detiene el ciclo de reconciliación junto con la sesión, `bootstrap.js:141,159`), y que en cada tick llame tanto a `mixer.reconcile()` como a una función nueva exportada por `rtc-patch.js` (p. ej. `reconcileRemoteReceivers()`). Un solo timer, no dos desincronizados — desincronizarlos solo agregaría hasta 5s de latencia extra sin ningún beneficio y complicaría los tests.
- `reconcileRemoteReceivers()` recorre las conexiones no `closed`/`failed` en `activeConnections`, llama `pc.getReceivers()` en cada una (envuelto en try/catch — igual que ya protege `getCurrentLocalAudioTrack()` a `getSenders()` en `rtc-patch.js:115-120`, `getReceivers()`/`getTransceivers()` también pueden tirar en navegadores/estados raros), se queda con los receivers de audio `live`, y localiza el `mid` correspondiente buscando el transceiver cuyo `.receiver` sea ese receiver (`getReceivers()` solo no da ni `MediaStream` ni `mid` directamente). Además, un barrido oportunista inmediato cuando una conexión pasa a `connected` (`connectionstatechange`, ya existe ese listener en `rtc-patch.js:62-69`) — complementa el polling, no lo reemplaza.
- **Es deseable, no solo tolerable, que el receiver descubra el audio ANTES que el evento `track`**: es justamente el valor del fallback (recuperarse cuando `track` llega tarde o no llega). No hay ninguna razón técnica para esperar siempre a `track` como fuente "primaria" — el flujo actual (`installRtcPatch()` a nivel módulo llamando `mixer.addRemoteTrack()` directamente, `bootstrap.js:44-48`) ya no distingue entre "sesión activa o no" para agregar fuentes, así que el fallback debe mantener esa misma semántica.
- **Riesgo real (confirmado leyendo `_remoteKey()`), a resolver explícitamente**: un receiver descubierto por `getReceivers()` no trae `MediaStream`, así que en el esquema de deduplicación actual de `audio-mixer.js` (`_remoteKey(connectionId, {streamId, mid, track})`) generaría la clave `conn:${connectionId}:mid:${mid}` en vez de la clave canónica `stream:${stream.id}` que sí genera el evento `track` normal. Si el mismo `MediaStreamTrack` llega primero por un camino y después por el otro, hoy terminaría con DOS entradas para el mismo track (audio duplicado en la mezcla), porque el guard actual (`existing.track === track`) solo compara dentro de la MISMA clave, no entre claves distintas para el mismo track.
- **Orden correcto de la deduplicación/migración en `addRemoteTrack()` — la primera versión de este plan tenía una contradicción operativa** (proponía "deduplicar por identidad ANTES de calcular la clave", lo cual con un `return` temprano nunca llegaría a migrar nada). Orden correcto:
  1. Buscar si ya existe una entrada para ese `MediaStreamTrack` por identidad (no por clave) — usando un índice `WeakMap<MediaStreamTrack, key>` nuevo (ver abajo), no iterando `remoteSources`.
  2. Calcular la clave "destino" para el evento/receiver actual (`stream:${id}` si hay `MediaStream`, o el fallback `conn:...` si no).
  3. Si existe una entrada por identidad y la clave destino es más canónica que la que tiene hoy (es decir, pasa de `conn:...` a `stream:...`), migrar esa entrada a la clave nueva.
  4. Si existe una entrada por identidad y ya está en la clave correcta (o en una igualmente canónica), no hacer nada (evita duplicar).
  5. Si NO existe por identidad, seguir la lógica actual de reemplazo por clave (`_teardownEntry` de lo que hubiera antes en esa clave, si algo).
- **Bug encontrado en la migración, a corregir explícitamente**: los listeners `ended`/`mute`/`unmute`/`removetrack` que hoy se registran en `addRemoteTrack()` (`audio-mixer.js:99-112`) capturan la variable `key` original en su closure. Si una entrada se migra a una clave nueva (moviendo el objeto en `remoteSources` de una clave a otra), esos listeners viejos seguirían comparando contra la clave vieja (`this.remoteSources.get(key)`) y dejarían de encontrar la entrada — se romperían silenciosamente después de una migración. Fix: guardar la clave actual DENTRO de la entrada (p. ej. `entry.key`, mutable), y que los listeners comparen `this.remoteSources.get(entry.key) === entry` en vez de la `key` capturada por closure. La migración actualiza `entry.key` al mover la entrada. Además, si el `MediaStream` llega tarde (el fallback inicial no tenía ninguno), hay que registrar en ese momento el listener `stream.removetrack` que hoy solo se agrega si `stream` estaba presente desde el principio.
- **Índice de identidad para evitar iterar en cada barrido de 5s**: agregar un `WeakMap<MediaStreamTrack, key>` privado en `MeetingAudioMixer` (p. ej. `remoteKeyByTrack`), actualizado al crear, migrar y desmontar cada entrada — así tanto `addRemoteTrack()` como el futuro reconciliador de receivers pueden chequear en O(1) si un track ya está mezclado, sin recorrer `remoteSources` completo.

### Cambios necesarios

**Files:**
- `src/webrtc-bootstrap/rtc-patch.js` (editar): agregar `reconcileRemoteReceivers()` (descripta arriba), exportada para que `bootstrap.js` la invoque.
- `src/webrtc-bootstrap/rtc-patch.test.js` (editar): tests para `reconcileRemoteReceivers()` con `RTCPeerConnection` mockeado (`getReceivers()`, `getTransceivers()`), incluyendo que una excepción de esas APIs no rompe el barrido.
- `src/webrtc-bootstrap/audio-mixer.js` (editar): reordenar `addRemoteTrack()` según el orden correcto de arriba, agregar el índice `remoteKeyByTrack` (`WeakMap`), y corregir los listeners `ended`/`mute`/`unmute`/`removetrack` para que usen `entry.key` en vez de la `key` capturada por closure.
- `src/webrtc-bootstrap/audio-mixer.test.js` (editar): tests para: receiver primero → `track` después (una sola fuente, termina en `stream:<id>`); `track` primero → receiver después (una sola fuente, no degrada a `mid`); migración seguida de `ended`/`mute`/`removeConnection()` (la entrada se sigue limpiando correctamente después de migrar); colisión al migrar hacia un `stream:<id>` ya ocupado por otra entrada; receiver sin `mid` (usa el fallback `conn:<id>:track:<track.id>` que ya existe en `_remoteKey()`).
- `src/webrtc-bootstrap/bootstrap.js` (editar): crear el único timer coordinador que llama `mixer.reconcile()` + `reconcileRemoteReceivers()` en cada tick, iniciado/detenido junto con la sesión (mismo patrón que ya usa `mixer.startReconciliation()`/`stopReconciliation()`).

### Verificación
- Tests unitarios (los de arriba) cubren el wiring, el orden de descubrimiento en ambos sentidos, y que el lifecycle (mute/ended/removeConnection) sigue funcionando después de una migración.
- Verificación manual: unirse a una reunión real y confirmar en los logs de diagnóstico que no aparecen fuentes de audio duplicadas ni `MediaStreamSource` repetidos para el mismo participante.

## Parte B — Spike de investigación del roster de Meet

**Esto no es una tarea de implementación cerrada — es una investigación time-boxed con una salida honesta posible de "no encontramos nada usable".** Estructura recomendada por Codex: 4 fases con un gate de decisión explícito antes de cualquier captura más sensible, para que "investigar un poco más" no se convierta en ingeniería inversa sin límite.

### Fase B1 — Contrato del spike y criterio de salida (cerrado)

**Criterio de "señal suficiente"** para pasar a la mini-ronda de la Fase B4 (y eventualmente a la Fase B5): un candidato concreto — un label de data channel (local o remoto) o un atributo DOM puntual — tal que, **para cada `deviceSpace` distinto observado en las captions durante la misma reunión**, exista un valor correlacionado de forma consistente (mismo `deviceSpace` → mismo valor candidato, sin excepciones, en los datos de esa única sesión de instrumentación). Una sola coincidencia aislada (un `deviceSpace` que por casualidad aparece cerca de un valor candidato una vez) NO alcanza — tiene que sostenerse para todos los participantes que hablaron en esa reunión.

Casos explícitos que caen en **"señal insuficiente"** (Fase B4, categoría 2), no en "ruta viable":
- Un candidato que correlaciona con algunos `deviceSpace` pero no con todos los observados.
- Un candidato que requiere mirar el contenido decodificado (texto real) de un canal no identificado para "ver si tiene sentido" — si hace falta activar el flag de captura de bytes crudos solo para poder EVALUAR si hay señal, eso ya no es la instrumentación segura de la Fase B2, es directamente la mini-ronda de la Fase B4, y necesita su propio gate de aprobación antes de activarse (ver Fase B4).

**Duración máxima**: una única sesión de instrumentación (una reunión real) + una ronda de análisis de lo que esa sesión exportó. Si al terminar esa ronda de análisis no hay un candidato que cumpla el criterio de arriba, el spike termina en "señal insuficiente" o "sin ruta" (Fase B4, categorías 2 o 3) — no se agenda una segunda reunión de instrumentación sin que el usuario lo pida explícitamente de nuevo, y no se amplía la superficie instrumentada (por ejemplo, agregar `fetch`/`XMLHttpRequest`/WebSocket) dentro de este mismo spike.

**Qué NO es parte de este spike** (reconfirmando el alcance ya acordado, para que quede escrito en un solo lugar): no se instrumenta `fetch`/`XMLHttpRequest`/WebSocket; no se captura contenido (`event.data`) de ningún canal no identificado como captions salvo bajo el flag explícito de la Fase B4; no se extrae `textContent`/`aria-label`/HTML del DOM por defecto.

### Fase B2 — Instrumentación de diagnóstico (segura por defecto)

**Files:**
- `src/webrtc-bootstrap/caption-datachannel-patch.js` o un módulo diagnóstico hermano nuevo (a decidir por Codex al implementar, avisando qué eligió): ampliar el sniffing de data channels para cubrir **ambas direcciones** — canales creados localmente (`createDataChannel`, ya cubierto) Y canales creados por el peer remoto (evento `"datachannel"` de `RTCPeerConnection`, no cubierto hoy). Corrección importante de Codex: limitarse solo a `createDataChannel` puede dar un falso negativo si el roster llega por un canal que Meet crea del otro lado.
- Un nuevo módulo o extensión de `meet-selectors.js`/una exploración puntual (no necesariamente productizada) del DOM del panel de participantes, buscando atributos con IDs de dispositivo/sesión correlacionables con `deviceSpace`.

**Reglas de privacidad no negociables para esta instrumentación (de la consulta a Codex):**
- Por defecto, **nunca** loguear el contenido (`event.data`) de canales no identificados como captions — solo label, dirección (local/remota), `readyState`, timestamps, cantidad de mensajes y tamaños en bytes.
- Para capturar bytes crudos de un candidato concreto, requiere un flag explícito separado (no el `debugLogging` general), limitado a un label/dirección puntual, con límite estricto de mensajes/bytes y sin persistencia automática entre sesiones.
- Para el DOM, no extraer `textContent`/`aria-label`/HTML completo por defecto (casi seguro contienen nombres reales) — solo nombres de atributos, y valores que ya coincidan con un `deviceSpace` previamente observado (o un hash local del valor, para demostrar correlación sin exponer el dato).
- Nota operativa importante: hoy `setDebugEnabled()` solo se activa al recibir `asterion:start-session`, así que cualquier canal/dato que aparezca al ENTRAR a la reunión (antes de arrancar la grabación) no se vería con el mecanismo de logging actual. Para este spike hace falta un buffer acotado de METADATA (nunca contenido) desde la carga temprana de la página, exportable solo bajo el modo de diagnóstico explícito.

#### Guía operativa temporal (implementación B2)

El sniffer productivo temporal vive en `src/webrtc-bootstrap/roster-spike-diagnostics.js`. Encadena su propio wrapper de `createDataChannel` después del patch de captions, en lugar de ampliar `caption-datachannel-patch.js`: ese patch sigue siendo dueño exclusivo del decoding de los dos labels conocidos, mientras que este probe observa metadata de todos los labels sin alterar ni duplicar el decoder.

Antes de entrar a la reunión, activar el opt-in explícito (en una consola con contexto de la extensión, donde `chrome.storage` esté disponible):

```js
chrome.storage.local.set({ rosterSpikeDiagnostics: true })
```

El flag es independiente de `debugLogging`. El bootstrap mantiene un ring buffer máximo de 200 entradas de metadata desde la carga temprana, aun antes de `asterion:start-session`; no retiene `event.data`, bytes, texto ni nombres. Con el flag activo, para exportar el buffer desde la consola de la página de Meet ejecutar:

```js
window.postMessage({
  source: "asterion-isolated-world",
  type: "asterion:export-roster-diagnostics",
}, "*");
```

Eso genera `console.table` y `console.log` con el buffer de metadata. No ejecutar B3 ni inferir una ruta solo de estos logs: el criterio de señal suficiente de B1 sigue siendo el gate para B4.

##### Snippet temporal de DevTools: atributos del panel de participantes

Con el panel de participantes visible, pegar este snippet en la consola de la página de Meet. Reemplazar los ejemplos de `deviceSpaces` por IDs ya observados en captions. Nunca imprime `textContent`, `aria-label`, HTML ni valores de atributos, excepto un valor cuyo contenido completo sea exactamente uno de esos `deviceSpace` ya suministrados.

```js
(() => {
  const deviceSpaces = new Set([
    // "deviceSpace-observado-1",
    // "deviceSpace-observado-2",
  ]);

  const rowSelector = [
    "[data-participant-id]",
    "[data-requested-participant-id]",
    '[role="listitem"]',
    '[role="row"]',
  ].join(", ");
  const panelSelector = '[role="dialog"], [role="complementary"], [data-participants-panel], [data-panel-id]';
  const isVisible = (element) => element.getClientRects().length > 0;
  const seenRows = new Set();
  const rows = [];

  // Se intenta acotar a contenedores de panel primero. Si la UI actual de Meet
  // no expone uno de esos contenedores, el fallback conserva solo filas visibles.
  const panelRoots = [...document.querySelectorAll(panelSelector)];
  const scopes = panelRoots.length ? panelRoots : [document];

  for (const scope of scopes) {
    for (const row of scope.querySelectorAll(rowSelector)) {
      if (!isVisible(row) || seenRows.has(row)) continue;
      seenRows.add(row);

      const attributeNames = new Set();
      const deviceSpaceMatches = [];
      for (const element of [row, ...row.querySelectorAll("*")]) {
        for (const { name, value } of element.attributes) {
          attributeNames.add(name);
          // `value` is never logged unless it is exactly a caller-provided ID.
          if (deviceSpaces.has(value)) deviceSpaceMatches.push({ attribute: name, value });
        }
      }

      rows.push({
        tagName: row.tagName.toLowerCase(),
        attributeNames: [...attributeNames].sort(),
        deviceSpaceMatches,
      });
    }
  }

  console.table(rows);
  return rows;
})();
```

Si no devuelve filas, abrir el panel de participantes y volver a ejecutarlo; si devuelve filas ajenas al roster, restringir `panelSelector` en la consola a un contenedor que se haya identificado visualmente, sin inspeccionar ni copiar texto/nombres.

### Fase B3 — Ejecución manual (el usuario, con consentimiento)

No delegable — requiere una reunión real. Recomendación de Codex: pocos participantes, identidades conocidas, con consentimiento explícito de que se está probando instrumentación de diagnóstico (los logs de metadata, aunque minimizados, podrían de todas formas correlacionar quién habló cuándo).

### Fase B4 — Análisis + gate de decisión

Clasificar el resultado en una de tres categorías:
1. **Ruta viable**: se identificó un canal/atributo candidato concreto. → **No avanza automáticamente a captura de bytes crudos ni a la Fase B5.** Primero se produce un informe de evidencia (qué candidato es, por qué se cree correlacionable, qué se vio) y se pide una aprobación explícita nueva antes de la mini-ronda limitada — activar la captura de bytes crudos cambia el nivel de sensibilidad de los datos que se manejan, así que necesita su propio gate, no hereda el de B1. Recién con esa aprobación se hace la segunda mini-ronda LIMITADA (solo ese label/dirección, con el flag de captura de bytes crudos activado solo para ese caso) para confirmar el esquema — análogo a como reverse-engineerizamos el formato de captions, pero acotado a esto.
2. **Señal insuficiente**: hay indicios pero no concluyentes. → El spike termina acá, documentando qué se vio y por qué no alcanza.
3. **Sin ruta en esta superficie**: nada correlacionable. → El spike termina, se documenta la conclusión negativa.

### Fase B5 (condicional — solo si B4 fue "ruta viable" y la mini-ronda confirma el esquema)

Implementación real del decoder + wiring del roster, análoga a como se hizo `caption-protobuf-decoder.js`/`caption-datachannel-patch.js` en el plan de captions: nuevo decoder para el formato encontrado, integración en el assembler/`bootstrap.js` para resolver `deviceSpace → nombre` y reemplazar `"unknown"` cuando haya resolución, sin tocar el fallback existente para los casos no resueltos.

### Salida honesta si no hay resultado (documentar explícitamente, no es un fracaso del plan)

- No se encontró una correlación `deviceSpace → identidad` estable y verificable.
- La transcripción vía data channel se mantiene como fuente canónica de texto — esto no se ve afectado.
- `"unknown"` se mantiene para todos los participantes salvo la resolución de "You" que ya existe.
- La Tarea 8 (aprendizaje oportunista vía DOM, descartada del alcance de este plan) queda documentada como alternativa futura a reconsiderar, no como algo que se activa automáticamente.

## Verificación general

- Parte A: tests unitarios + verificación manual de no-duplicación de audio en una reunión real.
- Parte B: sigue su propio gate de decisión (Fase B4); no tiene una "verificación de éxito" fija porque el resultado esperado puede legítimamente ser "no hay nada que implementar".
- **Hecho**: Codex revisó línea por línea el desglose de la Parte A (sesión `01a0d3a8-19b6-7cd0-958d-309041e889a2`), contra el código real de `rtc-patch.js`/`audio-mixer.js`/`bootstrap.js`. Encontró que la afirmación de "reusar el timer existente del mixer" era incorrecta (ese timer hoy solo purga, no descubre nada), una contradicción de orden en la lógica de deduplicación/migración propuesta, y un bug real de listeners con `key` capturada por closure que se rompería después de una migración — los tres ya están corregidos arriba. También ajustó el proceso de la Fase B4 (gate adicional antes de capturar bytes crudos). Con estas correcciones, el plan queda listo para arrancar la Parte A.
