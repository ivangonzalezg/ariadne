# Asterion — PRD: Extensión de Captura de Reuniones

## 1. Contexto y problema

Existen herramientas como Fireflies que transcriben reuniones aprovechando los subtítulos nativos de Google Meet, pero cobran por el acceso al audio de la reunión. El usuario necesita una alternativa de uso personal que le permita conservar transcripción, audio y video de sus reuniones sin depender de un servicio de pago ni de infraestructura externa.

## 2. Objetivo del producto

Ofrecer al usuario un respaldo local y completo de sus reuniones de Google Meet — transcripción, audio y video — para poder revisarlas o reescucharlas posteriormente, sin intervención de terceros ni costos recurrentes.

## 3. Usuario objetivo

Un único usuario, quien además es quien construye y mantiene el producto. Uso estrictamente personal.

## 4. Alcance

### 4.1 Dentro de alcance
- Captura de transcripción, audio y video de reuniones en Google Meet.
- Un único archivo de audio combinado por reunión, con la voz de los demás participantes y la voz propia del usuario mezcladas (ver 5.2, 5.3).
- Soporte para múltiples reuniones ocurriendo al mismo tiempo en pestañas distintas.
- Organización y acceso local a lo capturado.
- Un historial de reuniones grabadas dentro del propio producto.
- Una interfaz propia de la extensión (ícono en la barra de Chrome + ventana emergente) que muestra el estado de la grabación en curso, incluyendo la transcripción en vivo cuando sea posible, y permite detenerla.
- Un aviso dentro de la página de Meet, visible solo para el usuario, cuando la grabación de audio/transcripción arrancó automáticamente, ofreciendo activar también la grabación de video con un clic.
- Un ajuste de configuración para habilitar o deshabilitar el inicio automático de la grabación de audio/transcripción al detectar una reunión.

### 4.2 Fuera de alcance
- Soporte para Zoom, Microsoft Teams u otras plataformas de videollamada.
- Distribución o publicación del producto para otros usuarios.
- Unirse a la reunión como un participante independiente (bot).
- Cualquier aviso o notificación a los demás participantes de la reunión indicando que se está grabando.
- Transcripción o identificación de hablantes generada por el propio producto a partir del audio (más allá de lo que la transcripción nativa de Meet ya provee).
- Procesamiento posterior de lo capturado (resúmenes, análisis, envío a otros sistemas). El producto entrega los archivos; qué se hace con ellos después es responsabilidad de otro sistema.

## 5. Requerimientos funcionales

### 5.1 Transcripción
El producto debe capturar, en tiempo real, la transcripción de la reunión tal como la genera Google Meet de forma nativa, incluyendo la atribución de cada intervención a su hablante. El resultado debe quedar disponible como un archivo de texto asociado a esa reunión.

Si por cualquier motivo no es posible capturar la transcripción (subtítulos no disponibles, no se pudieron activar, el mecanismo de captura falla), esto no debe interrumpir ni condicionar la captura de audio (5.2, 5.3) ni de video (5.4) de esa reunión: simplemente no se genera el archivo de transcripción para esa reunión, y el resto se graba con normalidad.

### 5.2 Audio de la reunión (combinado)
El producto debe capturar en **un único archivo de audio** tanto la voz de los demás participantes como la voz propia del usuario, mezcladas en tiempo real — no como archivos separados (esto reemplaza el diseño original de dos archivos; se cambió durante la implementación al confirmar que es el mismo enfoque que usa Fireflies, la referencia de facto de este producto según la sección 8). El audio de los demás participantes se captura de forma continua durante toda la grabación; la voz propia se mezcla únicamente durante los períodos en los que el usuario tuvo el micrófono activo en Meet — los períodos en mute no deben sumar silencio audible al archivo combinado, simplemente no aportan nada a la mezcla en ese tramo (ver el manifiesto de mute, 5.3, para poder reconstruir esa línea de tiempo después). Esta captura debe poder ocurrir sin requerir ninguna acción explícita del usuario más allá de lo definido en 5.8 (ver mecanismo técnico en la sección 6). Cualquier corte por error debe quedar registrado con su marca de tiempo, no simplemente ausente del archivo.

### 5.3 Manifiesto de mute
Para poder reconciliar más adelante qué tramos del audio combinado (5.2) corresponden a intervenciones propias del usuario, el producto debe mantener, por reunión, un **registro de intervalos de mute**: una lista de pares de marcas de tiempo (inicio/fin) que indican cuándo el micrófono del usuario estuvo activo dentro de esa reunión, generada a partir del estado real de mute/unmute detectado en Meet (tomando la pista de micrófono que el propio Meet ya solicita internamente — ver sección 6 — en vez de pedirla por separado). Este registro debe guardarse junto con los demás archivos de la reunión (ver 5.6).

### 5.4 Video de la reunión
El producto debe poder capturar el contenido visual de la pestaña de la reunión (participantes, pantallas compartidas) como un archivo de video. A diferencia de 5.2 y 5.3, esta captura **sí requiere una autorización explícita del usuario por cada reunión**: Chrome exige una confirmación nativa del usuario para compartir el contenido de una pestaña, y no existe ninguna configuración, permiso de manifiesto, ni parámetro de arranque del navegador que elimine ese paso (validado empíricamente — ver sección 8). El producto debe ofrecer esa activación de la forma menos intrusiva posible: un aviso en la página de Meet, mostrado en cuanto arranca la grabación automática de audio/transcripción, con una opción de un clic para también grabar el video (ese clic dispara la confirmación nativa de Chrome, que el usuario debe aceptar). Si el usuario no la activa, la reunión queda grabada igual en audio y, cuando sea posible según 5.1, transcripción, sin video.

### 5.5 Aislamiento entre reuniones concurrentes
Cuando el usuario tiene más de una reunión ocurriendo simultáneamente en pestañas distintas, cada una debe generar su propio conjunto de archivos de captura (audio combinado, manifiesto de mute y, cuando estén disponibles, transcripción y video) de forma completamente independiente. No debe haber mezcla de audio entre reuniones distintas.

### 5.6 Almacenamiento y organización
Todo lo capturado debe guardarse localmente en el equipo del usuario, organizado de forma que los archivos de una misma reunión (transcripción, audio, video) queden agrupados y sean fácilmente identificables como pertenecientes a esa reunión.

**Mecanismo de almacenamiento (cambiado durante la implementación — ver sección 8):** en vez de un directorio del sistema elegido explícitamente por el usuario (que exige un permiso del sistema operativo que demostró vencerse con el tiempo, causando pérdida silenciosa de grabaciones automáticas), la captura escribe en el **almacenamiento privado propio de la extensión** (Origin Private File System — OPFS), que no requiere ningún permiso del usuario y no se vence. Esto es totalmente compatible con el inicio 100% automático (5.8): nunca depende de que el usuario haya interactuado antes con la extensión. La contrapartida es que esos archivos no son navegables directamente desde el Finder/Explorador del sistema — para eso está el historial (5.7), que ofrece descargarlos a una ubicación real cuando el usuario lo pida. El envío a un sistema de storage propio vía webhook (ver sección 7) sigue planteado como una evolución posterior, ahora tomando como fuente el almacenamiento interno en vez de un directorio externo.

### 5.7 Historial y acceso a las reuniones grabadas
El producto debe ofrecer una vista con el historial de reuniones grabadas (al menos nombre y fecha de cada una). Desde esa vista, el usuario debe poder **descargar** los archivos de una reunión específica (individualmente) a una ubicación de su elección en el equipo, dado que ya no viven en una carpeta elegida por el usuario (ver 5.6).

### 5.8 Detección e inicio de grabación
El producto debe poder identificar cuándo el usuario se encuentra en una reunión activa de Google Meet. El comportamiento de inicio depende de un ajuste de configuración (ver 5.10):

- **Con inicio automático activado (comportamiento por defecto):** en cuanto se detecta la reunión, arrancan automáticamente la captura de audio combinado (5.2, con su manifiesto de mute — 5.3) y transcripción (5.1) — a la vez, sin que el usuario tenga que hacer clic en nada. Esto es técnicamente posible porque ese mecanismo (ver sección 6) no depende de una API de captura de Chrome que exija invocación del usuario, a diferencia del video. Inmediatamente después de arrancar, se muestra el aviso descrito en 5.4 ofreciendo activar también el video.
- **Con inicio automático desactivado:** el producto solo advierte al usuario que hay una reunión activa (banner en la página + estado visible en la ventana emergente de la extensión), y el usuario debe iniciar la grabación manualmente desde ahí.

En ambos casos, la grabación de video (5.4) siempre requiere el clic de confirmación nativo de Chrome descrito en esa sección — el ajuste de inicio automático no aplica al video.

**Comportamiento si no hay reunión activa o la pestaña se cierra:** si el usuario cierra la pestaña de Meet, navega fuera de la reunión, o la llamada termina mientras se está grabando, el producto debe finalizar la sesión automáticamente: detener toda captura en curso y escribir los archivos con lo capturado hasta ese momento (no descartarlo). El historial (5.7) debe reflejar esa reunión con lo que efectivamente se alcanzó a grabar, sin requerir que el usuario haya hecho clic en "Detener" para que se guarde.

### 5.9 Interfaz de usuario
El producto debe ofrecer dos superficies de control, mantenidas sincronizadas entre sí, que reflejan en todo momento uno de estos estados por reunión: **sin grabación** (reunión detectada, esperando inicio manual — solo aplica con el inicio automático desactivado), **grabando** (audio/transcripción activos, video activo o no), o **finalizada**. No existe un estado de pausa — la grabación se inicia y se detiene, sin un punto intermedio; no es un caso de uso real para el usuario de este producto.

- **Un aviso dentro de la página de Meet** (visible solo para el usuario, nunca para los demás participantes — ver sección 6): en estado "sin grabación", muestra el botón para iniciar manualmente; en estado "grabando", informa el estado actual, ofrece activar el video (5.4) si todavía no está activo, y permite detener la grabación.
- **Una ventana emergente propia de la extensión** (al hacer clic en su ícono en la barra de Chrome): muestra el mismo estado descrito arriba para la reunión detectada en la pestaña activa, la transcripción en vivo cuando sea técnicamente viable, y los mismos controles que el aviso en página (iniciar, detener, activar video). También es donde vive la configuración (ajuste de inicio automático — ver 5.10).

**Comportamiento si los subtítulos nativos de Meet no están disponibles:** ver el fallback definido en 5.1. La interfaz debe reflejar un estado explícito de "transcripción no disponible" para esa reunión, en vez de mostrar una transcripción vacía sin explicación.

### 5.10 Configuración
El producto debe ofrecer, desde la ventana emergente de la extensión, al menos estos ajustes:
- Activar/desactivar el inicio automático de la grabación de audio combinado y transcripción (5.8) — juntas, no por separado. Por defecto, activado. Este ajuste no afecta al video (5.4), que siempre requiere su propio clic de confirmación.

## 6. Requerimientos no funcionales y restricciones

- Uso exclusivamente personal; no está destinado a instalación por terceros ni a publicación en la Chrome Web Store. Esto exime al producto de la revisión y las políticas de la Chrome Web Store, pero **no cambia ni relaja ninguna restricción técnica o de seguridad del navegador** (aislamiento de mundos de ejecución, permisos, diálogos nativos de confirmación) — esas restricciones aplican igual a una extensión sin publicar.
- Alcance de plataforma limitado a Google Meet en esta fase.
- El producto no debe generar ningún indicio visible hacia los demás participantes de que la reunión está siendo grabada.
- El producto depende de la estructura de la interfaz de Google Meet para varias de sus funciones; se acepta que cambios en esa interfaz puedan requerir mantenimiento por parte del usuario.
- **Mecanismo de captura de audio (5.2, 5.3) — arquitectura objetivo, pendiente de validación de aceptación contra una reunión real (ver sección 8):** en vez de las APIs de captura de pantalla/pestaña de Chrome (que siempre exigen una acción del usuario — ver más abajo), la captura automática de audio apunta a lograrse interceptando el WebRTC interno de Google Meet desde un content script que corre en el contexto de la página (no en el mundo aislado habitual):
  - Las pistas de audio remotas que las conexiones `RTCPeerConnection` de Meet ya reciben de los demás participantes, y la pista de micrófono que el propio Meet ya solicita internamente vía `getUserMedia()` (en vez de que el producto pida el micrófono por su cuenta), se mezclan en tiempo real con la Web Audio API (`AudioContext` + `MediaStreamAudioDestinationNode`) en un único stream, grabado con un solo `MediaRecorder` — no dos streams/archivos separados. La contribución del micrófono propio a la mezcla se controla con un nodo de ganancia (`GainNode`) que se lleva a cero durante los períodos de mute y se restaura al desmutear, en vez de pausar la grabación completa (que también cortaría el audio de los demás participantes).
  - El estado de mute/unmute se sigue detectando por separado (DOM del botón de mic) para controlar ese `GainNode` y para armar el manifiesto de mute (5.3).
  - Que una extensión comparable (Fireflies, inspeccionada localmente) use exactamente esta misma técnica de mezcla (un `AudioContext`, un `MediaStreamAudioDestinationNode`, un solo archivo de salida) como su mecanismo principal es evidencia de que el enfoque es viable en general — no es una demostración de que esta implementación específica lo haga correctamente, incluyendo el gate del `GainNode` durante mute o reuniones concurrentes; eso se valida con los criterios de aceptación de la sección 8.
  - Es más frágil que una API pública documentada, porque depende de cómo Meet arma internamente sus conexiones WebRTC (pueden ser varias, renegociarse) — se acepta como parte del riesgo de mantenimiento ya mencionado.
- **Limitación conocida — eco leve usando speaker + micrófono integrados sin audífonos (5.2):** cuando el usuario graba usando el altavoz y el micrófono integrados de su equipo (en vez de audífonos), la voz de los demás participantes puede filtrarse acústicamente por el altavoz y volver a entrar por el micrófono mientras está abierto — la cancelación de eco (AEC) que el navegador aplica automáticamente a la pista de micrófono reduce esto pero no lo elimina del todo, sobre todo con altavoz y micrófono de laptop muy cercanos entre sí. Como el archivo combinado (5.2) mezcla la copia limpia del audio remoto (recibida directamente por WebRTC) junto con la pista de micrófono (que arrastra ese residuo de eco), el archivo grabado puede sonar con un eco leve aunque en la llamada en vivo casi no se note. Se confirmó empíricamente que usando audífonos (sin acoplamiento acústico altavoz→mic posible) el problema desaparece por completo. No es un defecto del mecanismo de mezcla ni algo corregible ajustando la mezcla de audio — es una limitación física del setup de altavoz abierto, presente en cualquier herramienta que mezcle mic + audio remoto de esta misma forma (aplicaría igual al mecanismo de Fireflies descrito arriba). Se documenta como limitación conocida y se recomienda grabar con audífonos; no se investiga una mitigación de software (p. ej. atenuar el mic mientras habla el resto) salvo que se decida abordarla más adelante.
- **Mecanismo de captura de transcripción (5.1):** sigue siendo por `MutationObserver` sobre el panel de subtítulos de Meet (no hay, contra lo que se pensó en un momento durante este proyecto, un canal de datos WebRTC separado e interceptable para esto — se confirmó revisando directamente el código de Fireflies que ellos también leen ese mismo panel del DOM). La mejora adoptada de Fireflies es usar selectores basados en el atributo `jsname` de Meet (p. ej. el botón de subtítulos por `button[jsname="RrG0hf"]`) en vez de el texto del `aria-label`, que cambia según el idioma de la interfaz — más robusto. También se adopta mantener los subtítulos de Meet siempre activados durante toda la grabación (nunca desactivarlos) y ocultar el panel visualmente con CSS en vez de apagar el control nativo, para no perder eventos de subtítulos y no estorbar la vista del usuario.
- **Mecanismo de almacenamiento (5.6):** OPFS (`navigator.storage.getDirectory()`) desde el offscreen document, con el permiso de manifiesto `"unlimitedStorage"` declarado para evitar límites de cuota o evicción bajo presión de almacenamiento del navegador — sin esto, Chrome podría tratar el almacenamiento de la extensión como el de cualquier origen normal (con cuota y evicción posibles, aunque poco frecuente). La estructura de carpetas por reunión y los nombres de archivo se mantienen iguales a como estaban con el directorio externo; lo único que cambia es la raíz sobre la que se escriben. Exportar una reunión a una ubicación real del sistema es una acción explícita del usuario desde el historial (5.7), vía `chrome.downloads.download()` (permiso de manifiesto `"downloads"`), no algo automático durante la grabación.
- **Restricción dura de Chrome sobre video (5.4):** se confirmó, tanto contra la documentación oficial de `chrome.tabCapture` como probando empíricamente `getDisplayMedia({preferCurrentTab: true})` con Chrome arrancado con `--auto-select-desktop-capture-source`, que ese diálogo nativo de confirmación no desapareció — targeteó correctamente la pestaña, pero igual exigió un clic de "Allow". Para las combinaciones de permisos y parámetros de arranque efectivamente probadas, no hay forma de evitar ese diálogo. Esto se trata como una restricción cerrada de la plataforma para el diseño de este producto (no se debe volver a investigar sin evidencia técnica nueva y concreta), aunque no equivale a una prueba exhaustiva de cada configuración posible de Chrome.

## 7. Salida e integración futura

El producto debe dejar los archivos capturados (transcripción, audio, video) disponibles y accesibles para que, en una fase posterior, puedan ser enviados o consumidos por otro sistema (por ejemplo, para generar resúmenes o análisis adicionales). El diseño de esa integración no forma parte de este documento.

Como parte de esa evolución posterior, se contempla agregar un adaptador de subida que envíe lo capturado (o lo suba desde el almacenamiento local ya organizado) a un sistema de storage propio del usuario vía webhook, evitando así solicitudes repetidas de permisos de filesystem. Este adaptador se construye sobre la captura y organización local ya definidas en la sección 5.6, sin necesidad de rediseñar el pipeline de captura para incorporarlo.

## 8. Riesgos y preguntas abiertas

**Resueltos durante el diseño (documentados para no reabrirlos sin nueva evidencia):**
- ~~Existe riesgo de que la captura simultánea de audio y video de una misma reunión tenga limitaciones técnicas no confirmadas~~ — resuelto: audio/transcripción usan un mecanismo distinto (interceptación de WebRTC) al de video (`getDisplayMedia`), por lo que no compiten entre sí ni comparten la misma restricción.
- ~~¿Se puede eliminar el diálogo de confirmación de Chrome para capturar video con algún permiso o parámetro de arranque?~~ — se probó explícitamente con `--auto-select-desktop-capture-source` y `getDisplayMedia({preferCurrentTab: true})`: el navegador siempre exige un clic de "Allow" del usuario en un diálogo nativo, sin excepción. No investigar más esta vía.
- ~~¿Alcanza con un directorio del sistema elegido por el usuario (File System Access API) como almacenamiento?~~ — no: en uso real, el permiso sobre ese directorio se venció repetidamente y de forma impredecible, causando pérdida silenciosa de grabaciones justo en el caso más importante (inicio 100% automático sin que el usuario haya interactuado antes con el popup). Se reemplazó por OPFS (ver sección 6), que no depende de ningún permiso. No volver a esa vía sin evidencia nueva de que el problema de vencimiento de permiso se resolvió.

**Abiertos:**
- La dependencia de la interfaz de Google Meet implica un riesgo de mantenimiento continuo si la plataforma cambia su estructura visual (subtítulos, botones de mic/colgar). Esto no depende de nosotros y no tiene solución permanente — se acepta como mantenimiento continuo, con el fallback de 5.1 (si falla la transcripción, no bloquea audio/video) como mitigación, no como arreglo.
- La interceptación de WebRTC (5.2, 5.3, sección 6) depende de detalles internos de cómo Meet arma sus conexiones `RTCPeerConnection` (pueden ser varias, renegociarse, etc.) — es un riesgo de la misma familia que la dependencia del DOM, pero sobre una superficie distinta (JavaScript interno en vez de HTML/CSS), y debe validarse con una reunión real antes de darlo por confiable.
- El diseño concreto de la integración con sistemas externos (sección 7) queda deliberadamente sin definir por ahora — no se aborda en esta fase.
- Para las decisiones de implementación que este documento no cubre en detalle, la referencia por defecto es cómo lo resuelve Fireflies (extensión ya inspeccionada localmente, ver sección 6) — no como una obligación de replicar todo su comportamiento, sino como guía cuando haya ambigüedad y no valga la pena abrir una nueva decisión de producto por cada detalle menor.
