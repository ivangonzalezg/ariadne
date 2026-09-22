# Landing page for Ariadne (docs/, GitHub Pages)

## Contexto

Ariadne es una extensión de Chrome (Manifest V3) que graba, transcribe y guarda
localmente las llamadas de Google Meet — sin nube, sin cuenta, sin
suscripción. El repo ya publica `docs/privacy-policy.html` en GitHub Pages
(`docs/.nojekyll` está presente). Falta una landing page real en
`docs/index.html` para enlazar desde la ficha de la Chrome Web Store y desde
el README.

**Decisiones ya tomadas con el usuario (no son abiertas a reinterpretación):**

- **CTA principal:** "Add to Chrome" apuntando a la Chrome Web Store. La
  extensión **todavía no tiene URL real de Web Store** (no hay
  `chrome.google.com/webstore` en el repo). El botón debe existir y verse
  como CTA principal, pero su `href` va a un placeholder
  `https://chrome.google.com/webstore/detail/PLACEHOLDER` con un comentario
  HTML `<!-- TODO: reemplazar con la URL real una vez aprobada la ficha -->`
  justo antes del `<a>`. No inventar un ID de extensión real.
- **Idioma:** inglés en todo el copy.
- **Layout:** C — página minimalista de conversión (corta, un solo CTA
  claro, sin storytelling largo tipo long form).
- **Assets disponibles:** `docs/icon128.png`,
  `docs/screenshots/meeting-banner.png`,
  `docs/screenshots/popup-recording.png`,
  `docs/screenshots/history-detail.png`.

## Alcance

Un único archivo estático `docs/index.html`, sin build step, consistente con
el resto de `docs/` (mismo patrón que `docs/privacy-policy.html`: HTML +
`<style>` inline con custom properties para dark/light, sin framework, sin
Tailwind real — solo respetando los *valores* de la escala tipográfica y de
espaciado del design system del proyecto). JS inline mínimo, vanilla.

**Excepción explícita a "sin dependencias externas":** el sistema visual
exige tipografía Geist/Manrope/Geist Mono/Poppins, y no hay ningún archivo
de fuente ya vendorizado en el repo. Está permitido (y es la única
dependencia externa permitida) un `<link>` a Google Fonts para cargar el
typeface elegido. Los iconos, en cambio, van como SVG inline en el propio
HTML (no CDN de iconos), para no abrir una segunda dependencia externa.

Repositorio de GitHub a enlazar (proof line, FAQ punto 7, footer):
`https://github.com/ivangonzalezg/ariadne`. Todo enlace externo (Web Store,
GitHub) debe llevar `rel="noopener noreferrer"` y `target="_blank"`.

No incluye: build step, analytics, cookie banner (no hay tracking, así que no
aplica), internacionalización de la landing (solo inglés), `docs/404.html`
(el alcance es un único archivo; si más adelante se quiere un 404 de marca,
es una tarea aparte).

## Especificación de contenido (ya definida por Claude, no a decidir por Codex)

### SEO / AEO
- Indexar (página evergreen).
- `<title>`: "Ariadne — Private, Local Google Meet Recorder for Chrome"
- meta description: "Ariadne is a free Chrome extension that records,
  transcribes, and saves your Google Meet calls locally. No cloud, no
  subscriptions, no account."
- `og:title`, `og:description`, `og:image` (usar `icon128.png` como en
  `privacy-policy.html`, mismo patrón de URL absoluta a GitHub Pages).
- `<link rel="icon" href="icon128.png">` (mismo favicon que
  `privacy-policy.html`).
- FAQ en formato pregunta/respuesta literal en el HTML (no solo visual).

### Hero
- Headline (con salto de línea en un punto con sentido):
  "Record every Google Meet call —
  without it ever leaving your laptop"
- Subheadline: "Ariadne captures audio, video, and a live transcript
  automatically, and stores all of it locally in your browser. No account,
  no cloud, no subscription."
- CTA primario: "Add to Chrome — it's free" → placeholder de Web Store
  (ver nota arriba).
- Proof line (texto chico bajo el CTA): "Open source · Google Meet only ·
  Nothing uploaded, ever" (el texto "Open source" enlaza al repo de GitHub).
- Hero visual: `docs/screenshots/meeting-banner.png` (el banner in-meeting es
  la imagen más autoexplicativa de las tres).

### Tagline reveal (obligatoria, sección propia, no pegada al hero)
Dos líneas, palabra por palabra se activan al hacer scroll (ver sección de
motion abajo):

"Every other meeting recorder asks you to trust a server you'll never see.
Ariadne just doesn't have one."

### Benefits (4, outcome-driven, negrita + detalle)
1. **Nothing leaves your device** — audio, video, and transcripts are
   written straight to your browser's private storage; there is no backend
   to send them to.
2. **Starts itself** — recording begins the moment you join a Google Meet
   call, no button to remember to press.
3. **One mixed track, not five** — your microphone and everyone else's
   voice are combined in real time into a single audio file, automatically.
4. **A transcript you can search** — every line is attributed to whoever
   said it, pulled live from Meet's own captions.

### How it works (3 pasos)
1. Install the extension from the Chrome Web Store.
2. Join a Google Meet call. Recording starts automatically.
3. Open History anytime to search, play back, or download any past meeting.

Usar `docs/screenshots/popup-recording.png` y/o
`docs/screenshots/history-detail.png` como apoyo visual de los pasos 2 y 3
(a criterio de layout, no es obligatorio usar ambas).

### FAQ (8 preguntas, formato Q/A literal)
1. **Does Ariadne upload my recordings anywhere?** No. There is no backend,
   no account system, and no analytics. Everything is written to your
   browser's own private storage (Origin Private File System and
   `chrome.storage`), and the only way a file leaves that storage is if you
   click download.
2. **Which meeting platforms are supported?** Google Meet only, for now.
   The architecture is not tied to a single platform, so support for others
   may follow.
3. **Do other participants know they are being recorded?** There is no
   visible indicator in the meeting. Ariadne is a personal note-taking
   tool, not a meeting bot — you are responsible for complying with your
   jurisdiction's recording consent laws when you use it.
4. **Is Ariadne free?** Yes. No subscription, no usage limits, no account
   to create.
5. **What happens to a recording if I uninstall the extension?** It is
   erased, since it only ever lived in the extension's own storage and
   nowhere else.
6. **Can I get video, not just audio?** Yes, one click on the in-meeting
   banner enables video for that meeting. Chrome requires that one
   confirmation for screen capture; there is no way around it.
7. **Is the code open source?** Yes — the full source is on GitHub (enlazar
   al repo).
8. **What permissions does it need, and why?** `storage` and
   `unlimitedStorage` to save recordings locally, `offscreen` to run local
   audio/video conversion, `downloads` so you can save a file to your
   computer, and host access limited to `meet.google.com` to detect
   meetings and read captions. Nothing else.

### Final CTA
Repetir headline corto + mismo botón "Add to Chrome — it's free".

### Footer
Enlace a `privacy-policy.html` (ya existe en `docs/`), enlace al repo de
GitHub, nota "A personal project — not affiliated with Google or Google
Meet." (mismo tono que el README).

## Sistema visual (obligatorio, del skill `landing-page-design`)

- Tipografía: Geist, Manrope, Geist Mono o Poppins vía Google Fonts. Nada de
  Inter/Roboto/Arial/Open Sans/Helvetica (`privacy-policy.html` usa Inter —
  **no** replicar eso acá, es una page vieja). Un solo typeface, sin
  itálicas, sin peso 900.
- Sin guiones `-` dentro de frases del copy.
- Tamaños de fuente y line-heights: solo los pasos de la tabla del skill
  (`text-xs` … `text-9xl`), sin valores arbitrarios.
- Espaciado: solo los tokens de la tabla del skill (0, 2, 4, 8, 12, 16, 24,
  32, 40, 48, 64, 80, 96px). Botones principales: 8px vertical / 12px
  horizontal de padding.
- Radios anidados: aplicar la fórmula `interior = exterior − gap` cuando el
  gap sea menor a 32px y el resultado mayor a 2px.
- Fondo dark mode: solo `#000000`, `#181818`, `#1F1F1F`, `#272727`,
  `#313131`, `#131209`. Soportar light/dark con `prefers-color-scheme`
  (mismo patrón que `privacy-policy.html`, pero paleta nueva conforme a esta
  regla).
- Heading del hero: gradiente de texto izquierda→derecha (`#FFFFFF→#9B9B9B`
  en dark, `#000000→#666666` en light). Es el único uso de gradiente en toda
  la página — nunca en fondos.
- Hero heading y subheading con `max-width: 680px` y saltos de línea en
  puntos con sentido (ya definidos arriba en el copy).
- Iconos si hacen falta: Phosphor, Solar o Iconamoon (vía SVG inline o CDN
  de iconos, no Material Icons).
- Bordes: nunca en un solo lado. Fondos: siempre planos, sin gradientes
  (excepto el heading del hero).
- Motion: transiciones con `cubic-bezier(0.32,0.72,0,1)`, nunca transiciones
  por default. Scroll reveals con `IntersectionObserver` o
  `whileInView`-style, nunca `window.addEventListener('scroll')` sin
  throttle. La sección de tagline reveal activa palabra por palabra al
  cruzar el viewport, empezando en 25–35% de opacidad hasta el color final.
- Estados: el botón CTA necesita hover, active (`scale(0.98)` o
  `translateY(1px)`), y focus visible. No hay formularios en esta página, así
  que no aplican estados de loading/empty/error de inputs.
- No enlaces muertos: el nav (si lo hay) o el footer no deben tener `href="#"`
  sueltos.

## Tareas

### Task 1 — Construir `docs/index.html`

**Files:** `docs/index.html` (nuevo)

Implementar la landing page completa en un solo archivo estático, siguiendo
exactamente el contenido y el sistema visual descritos arriba en este plan
(no inventar copy nuevo, no reordenar secciones, no cambiar el CTA de
placeholder). Reusar los assets ya existentes en `docs/`
(`icon128.png`, `screenshots/*.png`) — no generar ni descargar imágenes
nuevas. Sin build step: HTML/CSS/JS vanilla en un solo archivo, mismo
espíritu que `docs/privacy-policy.html` mas cumpliendo el design system de
este plan (tipografía, colores, espaciado, motion).

Tabla de tamaños de fuente permitidos (usar `font-size`/`line-height` en CSS
con estos valores exactos en px, no valores arbitrarios):

| Nombre | font-size | line-height |
|---|---|---|
| xs | 12px | 16px |
| sm | 14px | 20px |
| base | 16px | 24px |
| lg | 18px | 28px |
| xl | 20px | 28px |
| 2xl | 24px | 32px |
| 3xl | 30px | 36px |
| 4xl | 36px | 40px |
| 5xl | 48px | 1 (line-height: 1) |
| 6xl | 60px | 1 |
| 7xl | 72px | 1 |
| 8xl | 96px | 1 |
| 9xl | 128px | 1 |

Tokens de espaciado permitidos (px): 0, 2, 4, 8, 12, 16, 24, 32, 40, 48, 64,
80, 96. Botones principales: 8px vertical / 12px horizontal de padding.

Verificar al final:
- Abrir el archivo en un navegador (o servirlo) y confirmar que el hero, el
  tagline reveal, los benefits, how it works, FAQ y el CTA final se ven y
  funcionan (scroll reveal, hover/active del botón).
- Confirmar que todo `font-size`/`line-height` usado coincide exactamente
  con la tabla de arriba, y todo `margin`/`padding`/`gap` con los tokens de
  espaciado listados.
- Confirmar responsive en mobile (viewport angosto, ~375px) sin scroll
  horizontal.
- Confirmar que el placeholder de la URL de Web Store tiene el comentario
  TODO tal como se especifica arriba, y que el enlace al repo apunta a
  `https://github.com/ivangonzalezg/ariadne`.
- Confirmar que los tres enlaces externos (Web Store, GitHub en proof line,
  GitHub en FAQ, GitHub en footer) llevan `target="_blank"
  rel="noopener noreferrer"`.
- Confirmar `<title>`, meta description, `og:title`, `og:description`,
  `og:image` (URL absoluta) y el favicon (`icon128.png`), comparando con la
  sección SEO/AEO de este plan.
- Confirmar que la página respeta `prefers-color-scheme` (probar en modo
  claro y oscuro) usando solo los colores de fondo dark mode permitidos por
  el skill (`#000000`, `#181818`, `#1F1F1F`, `#272727`, `#313131`,
  `#131209`).
- Confirmar foco visible por teclado (Tab) en el CTA y en cualquier enlace,
  y que el scroll reveal respeta `prefers-reduced-motion: reduce`
  (mostrando el contenido sin animación en vez de dejarlo invisible).
- Confirmar que no hay enlaces muertos (`href="#"` sin comportamiento).

Commit: un solo commit para esta tarea.
