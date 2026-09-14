# Reglas del proyecto Asterion

## Modelo de trabajo: Claude orquesta, Codex construye

En este proyecto Claude actúa como tech lead / orquestador y Codex (vía el agente `codex:codex-rescue`, corriendo `gpt-5.6-terra` con esfuerzo `medium` salvo que se indique otro modelo/esfuerzo) es el implementador principal. La mayor parte del código lo escribe Codex; Claude se enfoca en definir bien el trabajo, revisar lo que vuelve, y hacer ajustes puntuales — no en reescribir tareas completas por su cuenta salvo que sea genuinamente más rápido que redirigir a Codex (un typo, un import faltante, algo trivial).

Reparto de responsabilidades:

- **Claude decide y define:** arquitectura, alcance, el documento de PRD, el plan de implementación (`docs/superpowers/plans/*.md`), en qué orden se ejecutan las tareas, y qué hacer con lo que Codex devuelve (aceptar, pedir un ajuste, o corregirlo directamente si es menor).
- **Codex implementa:** la mayoría de las tareas del plan — escribir el código, correr los tests, hacer los commits de cada tarea — siguiendo exactamente lo que el plan describe.
- **Claude revisa y ajusta:** después de cada tarea (o lote de tareas) que Codex entrega, Claude revisa el resultado contra el plan y el PRD, y hace los ajustes puntuales que hagan falta antes de seguir a la siguiente tarea.

## Cómo delegar una tarea a Codex

Codex no tiene memoria de esta conversación ni de las anteriores. Cada delegación tiene que ser autocontenida y darle exactamente el contexto que necesitaría alguien que nunca vio el proyecto:

1. **Siempre referenciar el archivo del plan** (`docs/superpowers/plans/<nombre>.md`) y el número de tarea exacto a ejecutar (p. ej. "Task 7"), no una paráfrasis de lo que hay que hacer.
2. **Siempre listar los archivos exactos** que la tarea crea o modifica (ya vienen declarados en cada tarea bajo `**Files:**`) — pasárselos explícitamente en el prompt, no asumir que Codex los va a inferir del plan.
3. Si la tarea depende de decisiones o resultados de tareas anteriores que no están 100% reflejados en el plan (por ejemplo, un selector de DOM que se ajustó a mano durante la verificación manual de una tarea previa), incluir ese contexto explícitamente en el prompt — no asumir que Codex va a leer entre líneas.
4. Pedirle a Codex que siga los pasos de la tarea tal como están escritos (test primero si aplica, implementación, verificación, commit), y que reporte qué verificó y qué no pudo verificar (por ejemplo, pasos de verificación manual que requieren una reunión real de Meet).
5. Cuando la tarea implica un ajuste de arquitectura no cubierto explícitamente por el plan, pedirle a Codex su recomendación en vez de que decida en silencio — esa decisión la cierra Claude (y, si es una decisión de producto, se deja al usuario).

## Seguir consultando a Codex en las decisiones de fondo

Esta regla sigue vigente además del reparto de trabajo anterior:

- Antes de cerrar cualquier documento de alcance/PRD, siempre pedirle una revisión a Codex y confluir sus observaciones con las propias antes de presentar conclusiones al usuario.
- Antes de ejecutar (no solo escribir) cualquier plan de implementación, pedirle a Codex que revise el plan — arquitectura, tareas, riesgos — y ajustar el plan con lo que aporte antes de empezar a ejecutar tareas.
- Al tomar decisiones de arquitectura no triviales (captura, almacenamiento, concurrencia, etc.), presentar la postura propia junto con la de Codex, señalando donde coinciden y donde difieren, y dejar la decisión final al usuario cuando sea una decisión de producto.
- No se debe presentar un análisis, plan o decisión como "final" si Codex no lo revisó todavía.
