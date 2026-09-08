# ADR 0003 — Timestep fijo con interpolación de render

- **Estado:** aceptada
- **Fecha:** 2026-02
- **Ámbito:** `src/application/game-loop.ts`, `FIXED_TIMESTEP`, `RenderFrame`

## Contexto

La v1 ejecutaba la física dentro de `requestAnimationFrame`, limitada por un
contador de milisegundos. El resultado práctico:

- en un monitor de 144 Hz la simulación avanzaba con `dt` distintos a los de uno
  de 60 Hz, así que **el juego no era el mismo en las dos máquinas**;
- las velocidades estaban expresadas en píxeles por frame (`player1.dy = -7`), no
  en unidades por segundo, de modo que la velocidad real dependía del hardware;
- si el navegador se congelaba un instante, el `dt` acumulado atravesaba palas y
  paredes.

La v2 necesita, además, que `Match.step(dt, ...)` reciba siempre el mismo `dt`:
el determinismo del ADR 0002 se rompe con pasos variables, porque la integración
semi-implícita del efecto Magnus y la decadencia del spin (`exp(-decay * dt)`) no
son invariantes frente a la subdivisión del tiempo.

## Decisión

Bucle de **timestep fijo con acumulador e interpolación en el render**
(el patrón clásico de *Fix Your Timestep*):

- `FIXED_TIMESTEP = 1/120` s. La simulación **siempre** avanza en incrementos
  exactos de 8,33 ms.
- `GameLoop.frame(delta, elapsed)` acumula el tiempo real, ejecuta `update()`
  tantas veces como pasos completos quepan, y entrega el resto como `alpha` en
  `[0, 1)`.
- El renderer recibe un `RenderFrame` con `previous`, `current` y `alpha`, y
  dibuja el estado interpolado. La imagen es suave a cualquier frecuencia de
  refresco sin que la física lo sepa.
- `maxFrameTime = 0,25` s acota el tiempo simulado en un solo frame (máximo 30
  pasos), lo que evita la *espiral de la muerte* al volver de una pestaña en
  segundo plano.

## Alternativas consideradas

**A. Paso variable (`dt` real en cada frame).**
Es lo más simple y lo que hacía la v1. Se descarta: rompe el determinismo, hace
la física dependiente del hardware y convierte cualquier hipo del navegador en un
salto de posición.

**B. Fijar el bucle a 60 Hz e ignorar el resto.**
Determinista, pero desperdicia los monitores de alta frecuencia y produce
*judder* visible cuando 60 no divide la frecuencia del panel.

**C. Timestep fijo *sin* interpolación.**
Elimina la duplicación de snapshots, pero el movimiento se ve a saltos cuando la
frecuencia de render no es múltiplo de 120 Hz: la bola avanza dos pasos en un
frame y uno en el siguiente.

**D. Simulación en un Web Worker a 120 Hz.**
Aísla la física del jitter del hilo principal. Se descarta por ahora: añade
serialización de estado por frame y complejidad de arranque, para un problema que
todavía no tenemos. La arquitectura del ADR 0001 permite hacerlo después sin
tocar el dominio.

## Consecuencias

**Positivas**

- El resultado de una partida no depende del monitor ni de la carga del sistema.
- Todas las velocidades del dominio están en unidades por segundo y son
  auditables: `serveSpeed: 22`, `maxSpeed: 62`, `paddle.maxSpeed: 26`.
- La interpolación desacopla por completo la frecuencia de render de la de
  simulación: 30, 60, 120 o 165 Hz dibujan el mismo juego.
- Tras una pausa larga el juego **ralentiza el tiempo** en vez de teletransportar
  la bola. Es una degradación elegida, no un accidente.

**Negativas y costes reales**

- **120 pasos por segundo se pagan siempre**, incluso en una pantalla de 60 Hz
  donde se ejecutan dos por frame. Es el precio de tener margen frente al
  *tunneling* (ADR 0004) y de una integración estable del spin.
- El renderer debe **conservar dos snapshots** e interpolar entre ellos: más
  memoria y una copia por frame del estado del dominio al grafo de escena.
- La interpolación introduce hasta **un paso de latencia visual** (8,3 ms): lo que
  se ve está, por construcción, ligeramente por detrás de lo que se simula.
- Si la máquina no llega a sostener 120 pasos/s, el acumulador crece y el juego
  se ralentiza en lugar de perder precisión. Hay que vigilarlo con el contador de
  FPS del `RendererPort` y bajar calidad antes de bajar el timestep.
- El bucle nunca debe alimentarse con `dt` variable "para ir más suave": es la
  tentación recurrente y anula los ADR 0002 y 0003 a la vez.
