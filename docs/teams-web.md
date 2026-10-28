# Teams web en Chrome

Esta rama añade Teams web al flujo local de Ariadne: detección de llamada, audio mezclado, estado del micrófono, subtítulos por hablante, historial y exportación. Google Meet conserva su adaptador y sus modos de subtítulos actuales.

## Instalación

```sh
git clone https://github.com/CarlosPolo019/ariadne.git
cd ariadne
git switch feat/teams-web-support
npm ci
npm run build
```

En `chrome://extensions`, activa **Modo de desarrollador**, selecciona **Cargar descomprimida** y elige la carpeta del proyecto que contiene `manifest.json`. Recarga las pestañas de Teams y Meet después de instalar o actualizar la extensión: la captura de audio se prepara al cargar la página.

Si el popup dice **Listo** y muestra un error genérico aunque ya estés dentro de Teams, comprueba que hayas recargado la pestaña después de instalar la extensión. Entrar a otra llamada sin recargar la página no carga los scripts en una pestaña que ya estaba abierta antes de la instalación. Recargar Teams interrumpe brevemente la llamada; vuelve a entrar cuando puedas hacerlo.

## Uso

1. Abre Teams en `https://teams.cloud.microsoft`, `https://teams.microsoft.com` o `https://teams.live.com` y entra a la llamada desde Chrome.
2. Ariadne espera a que aparezca el control para abandonar la llamada; no graba la pantalla de ingreso ni la sala de espera.
3. Con el inicio automático activado, comienza la captura. Con el inicio automático desactivado, usa el botón de Ariadne o el popup.
4. Ariadne intenta activar los subtítulos. Si el estado sigue en **Preparando**, actívalos desde **Más > Idioma y voz > Subtítulos** (el nombre puede variar según la versión), o desde el control **Subtítulos**. Comprueba en Teams que el idioma hablado sea el correcto.
5. Puedes desactivar los subtítulos manualmente; Ariadne respeta la pausa y vuelve a capturarlos cuando los activas.
6. Detén la captura desde Ariadne o abandona la llamada. El audio y la transcripción aparecen en **Historial**, igual que con Meet. El video conserva el flujo existente de selección y permiso de Chrome.

Todo se guarda localmente mediante el almacenamiento de la extensión. Esta integración no necesita Graph, Azure, un bot ni credenciales adicionales. Los subtítulos proceden de Teams; si el administrador los bloquea, Ariadne no puede generarlos. Los nombres anónimos u ocultos se conservan tal como aparecen; no se deducen identidades a partir de otras partes de la interfaz.

## Límites y validación pendiente

La aplicación de escritorio de Teams queda fuera del alcance de esta extensión. El adaptador depende del DOM del cliente web; Microsoft no ofrece un contrato estable para estos selectores. Los controles localizados de respaldo cubren inglés, español y francés.

Las pruebas automatizadas usan estructuras representativas de Teams y audio sintetizado. **La detección de llamada, los subtítulos por hablante y el guardado de audio MP3 y transcripción en Historial se comprobaron en Teams web real el 27 de octubre de 2026.** Siguen pendientes las comprobaciones reales con dos participantes, silencio/reactivación del micrófono y captura de video. No se afirma compatibilidad con clientes gubernamentales o dominios diferentes a los tres indicados.

Las nuevas grabaciones guardan la plataforma en su estado persistente, manifiesto e historial, incluso después de recuperar el almacenamiento. Las grabaciones anteriores que no tienen ese dato omiten la etiqueta de plataforma; no se deduce a partir del título.

Antes de integrar la rama, realiza esta comprobación con dos participantes:

- Abre Teams después de recargar la extensión y entra a una llamada; comprueba que el banner aparece después de ingresar.
- Hablen por turnos, revisen los nombres y el texto guardados y prueben una pausa y reanudación de subtítulos.
- Alterna silenciar/reactivar tu micrófono; comprueba que el archivo exportado conserva la voz remota y omite tu micrófono mientras está silenciado.
- Abandona la llamada, reproduce el audio en Historial y descarga la transcripción.
- Entra a otra llamada en la misma pestaña y comprueba el inicio automático. Repite con el inicio automático desactivado y el inicio manual.
- Prueba una llamada de Google Meet para confirmar el flujo existente. Si necesitas video, valida también la selección de pestaña y reproducción del archivo.

## Pruebas de desarrollo

```sh
npm test
npm run build
npm run test:teams:browser
```

La integración de navegador carga el manifiesto real de la extensión en un perfil temporal de Chrome y sirve una interfaz local simulada bajo un origen de Teams. Verifica el grabador real, la pausa con clics de usuario, las revisiones finales, los cambios de panel, la persistencia OPFS, el MP3, el micrófono silenciado, el cierre desde el popup y una segunda llamada sin recargar. No accede a la cuenta de Microsoft ni a sesiones personales de Chrome.

Referencias: [subtítulos en Teams](https://support.microsoft.com/en-gb/teams/meetings/use-live-captions-in-microsoft-teams-meetings), [políticas de subtítulos](https://learn.microsoft.com/en-us/microsoftteams/meeting-transcription-captions), [dominio teams.cloud.microsoft](https://devblogs.microsoft.com/microsoft365dev/action-required-ensure-your-microsoft-teams-apps-are-ready-for-upcoming-domain-changes/).
