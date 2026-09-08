# ADR 0001 — Arquitectura hexagonal (puertos y adaptadores)

- **Estado:** aceptada
- **Fecha:** 2026-02
- **Ámbito:** estructura global del proyecto

## Contexto

La versión 1 del juego era un único archivo HTML de 765 líneas
(`legacy/pong-2d-legacy.html`) en el que convivían, sin separación alguna:

- el bucle de juego y la física,
- el dibujado en un `<canvas>` 2D,
- la síntesis de sonido con Web Audio,
- la IA del rival,
- los menús, el marcador y los listeners del DOM.

Funcionaba, pero tenía tres consecuencias medibles:

1. **No era testable.** Cualquier prueba de la física exigía un DOM, un canvas y
   un `requestAnimationFrame`.
2. **La geometría dependía de la pantalla.** El tamaño de las palas y de la bola
   se derivaba de `canvas.width`, así que redimensionar la ventana cambiaba las
   reglas del juego.
3. **No se podía cambiar nada sin tocarlo todo.** Pasar de 2D a 3D implicaba
   reescribir el archivo entero, porque el estado del juego *era* el estado del
   dibujado.

El objetivo de la v2 es un Pong 3D real, con física continua, IA predictiva y una
suite de pruebas basada en propiedades. Eso exige poder ejecutar el juego sin
navegador.

## Decisión

Adoptamos **arquitectura hexagonal** con tres capas y una regla de dependencia
estricta: **las flechas apuntan siempre hacia dentro**.

| Capa | Ruta | Puede importar de |
|------|------|-------------------|
| Dominio | `src/domain/**` | solo de sí mismo |
| Aplicación | `src/application/**` | dominio |
| Infraestructura | `src/infrastructure/**` | aplicación (puertos) y dominio (tipos) |
| Composition root | `src/main.ts` | todas |

- El **dominio** contiene arena, entidades, reglas, física, eventos, RNG e IA. No
  conoce el DOM, ni Three.js, ni `window`, ni el reloj del sistema.
- La **aplicación** orquesta: `GameSession` (modo, dificultad, máquina de
  estados de pantalla), `GameLoop` (timestep fijo) y `ports.ts`, que declara
  como interfaces *todo* lo que el juego necesita del exterior:
  `RendererPort`, `AudioPort`, `InputPort`, `ClockPort`, `StoragePort`, `UiPort`.
- La **infraestructura** implementa esos puertos con Three.js, Web Audio,
  teclado/ratón/gamepad, `localStorage` y DOM.
- `main.ts` es el **único** archivo que conoce ambos lados y los conecta.

## Alternativas consideradas

**A. Modularizar el archivo único por funcionalidad** (`ai.js`, `render.js`,
`physics.js`) sin invertir dependencias.
Más barato y suficiente para el tamaño del proyecto, pero los módulos seguirían
importando el `canvas` y el DOM: no habríamos ganado testabilidad, que era el
motivo principal del cambio.

**B. ECS (Entity Component System).**
Es el patrón natural en juegos con muchas entidades heterogéneas. Aquí hay tres
entidades fijas (bola y dos palas) y ningún requisito de composición dinámica: el
coste conceptual del ECS no se amortiza.

**C. El grafo de escena de Three.js como modelo.**
Es lo más rápido de escribir: las posiciones viven en los `Object3D` y la física
los mueve. Se descartó porque ata la simulación al render (nada de pruebas sin
WebGL), impide el timestep fijo con interpolación (ADR 0003) y reproduce
exactamente el defecto que hacía imposible evolucionar la v1.

## Consecuencias

**Positivas**

- La física y la IA se ejecutan en Node, sin navegador: `vitest` con
  `environment: 'node'` y pruebas basadas en propiedades con `fast-check`.
- El render es sustituible. Cambiar Three.js por WebGPU, o añadir un adaptador
  "headless" para grabar partidas, es implementar una interfaz, no reescribir el
  juego.
- Los eventos de dominio (`DomainEvent`) son el único canal por el que la
  presentación se entera de que algo ha pasado; ni el renderer ni el audio
  inspeccionan la física para deducir "¿hemos rebotado?".
- La regla de dependencia es verificable de forma mecánica: si un archivo de
  `src/domain` importa algo de fuera, es un error de arquitectura, no una opinión.

**Negativas y costes reales**

- **Más archivos y más indirección.** Un cambio que en la v1 era una línea aquí
  puede tocar el puerto, el adaptador y el composition root.
- **Estado duplicado.** El dominio tiene su posición de la bola y Three.js tiene
  la suya. Cada frame hay que copiar del `MatchSnapshot` al grafo de escena; es
  un coste que la alternativa C no paga.
- **Riesgo de "hexagonal de escaparate".** La arquitectura solo aporta si la
  regla de dependencia se respeta; un único `import` de `three` dentro de
  `src/domain` anula todo el beneficio. Es el punto que hay que vigilar en
  revisión.
- Para un juego de este tamaño, la estructura es **deliberadamente más formal de
  lo estrictamente necesario**: se asume el sobrecoste porque el proyecto también
  funciona como muestra de diseño.
