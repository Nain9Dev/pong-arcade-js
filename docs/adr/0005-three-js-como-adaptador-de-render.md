# ADR 0005 — Three.js como adaptador de render

- **Estado:** aceptada
- **Fecha:** 2026-02
- **Ámbito:** `RendererPort`, `src/infrastructure/**`, `vite.config.ts`

## Contexto

La v2 necesita 3D real: una arena en perspectiva, la bola viajando por el eje `z`
hacia la cámara, tres modos de cámara y efectos de impacto. Escribir eso a mano
sobre WebGL implica cámaras, matrices, gestión de materiales, luces y
redimensionado antes de dibujar el primer píxel de juego.

Restricciones del proyecto:

- **Coste cero de licencia** (es un proyecto de portafolio, publicado en GitHub
  Pages como sitio estático).
- **Sin backend**: todo se sirve como archivos estáticos.
- La regla de dependencia del ADR 0001: sea cual sea la librería, no puede
  aparecer en `src/domain` ni en `src/application`.

## Decisión

Usar **Three.js (MIT)** como implementación de `RendererPort`, confinada en
`src/infrastructure`.

- `ports.ts` define el contrato: `mount`, `resize`, `handleEvents`, `render`,
  `setCameraMode`, `setPerspective`, `setQuality`, `fps`, `dispose`. Ese
  contrato **no menciona Three.js**: habla de `Arena`, `MatchRules`,
  `MatchSnapshot` y `DomainEvent`.
- El adaptador traduce el `RenderFrame` (dos snapshots más `alpha`) a
  transformaciones del grafo de escena, y los `DomainEvent` a efectos: destellos
  de impacto, partículas, sacudida de cámara.
- `vite.config.ts` aísla Three.js en su propio chunk (`manualChunks`), para que
  el código del juego pueda invalidarse en caché sin arrastrar la librería.
- `setQuality` está en el puerto desde el principio para poder degradar efectos
  en máquinas lentas sin tocar el bucle ni el dominio.

## Alternativas consideradas

**A. WebGL2 a pelo.**
Control total y bundle mínimo. Se descarta por coste de desarrollo: escribir el
render sería la mayor parte del proyecto y desplazaría el foco, que es la
arquitectura y la simulación.

**B. Babylon.js.**
Motor más completo (física, sistema de materiales, editor). Aquí la física es
propia (ADR 0004) y no queremos un motor con opinión sobre el bucle de juego;
además su superficie de API es mayor de lo necesario.

**C. Canvas 2D con proyección en perspectiva "a mano".**
Suficiente para el aspecto de túnel y sin ninguna dependencia. Se descarta:
iluminación, profundidad y efectos volumétricos quedarían fuera de alcance, y el
objetivo declarado es un juego 3D real, no un truco de proyección.

**D. React Three Fiber.**
Ergonomía excelente para escenas declarativas, pero introduce React y su ciclo de
reconciliación en un bucle de 120 Hz que ya está gobernado por `GameLoop`. Dos
bucles compitiendo por el mismo frame es un problema que no queremos tener.

## Consecuencias

**Positivas**

- Cámaras, luces, materiales, post-proceso y redimensionado vienen resueltos: el
  esfuerzo se concentra en cómo se *ve* el juego, no en cómo se dibuja un
  triángulo.
- Licencia MIT y ecosistema grande: ejemplos, tipos (`@types/three`) y
  documentación abundante, sin coste ni suscripción.
- Como el renderer está detrás de un puerto, **es sustituible**. Un adaptador
  alternativo (WebGPU, o uno nulo para pruebas) no obliga a tocar el dominio.
- El `RendererPort` expone `fps`, así que la calidad adaptativa se decide con un
  dato real y no con detección de user-agent.

**Negativas y costes reales**

- **Three.js domina el peso del bundle.** Es la razón del chunk separado; en una
  conexión lenta, la primera carga la marca la librería, no el juego.
- **La API de Three.js cambia entre versiones menores.** Es una característica
  conocida del proyecto: subir de `0.180` a `0.19x` puede requerir cambios en el
  adaptador. El puerto acota el daño a un directorio, pero no lo elimina.
- **Estado duplicado**: cada frame hay que copiar posiciones interpoladas del
  dominio a los `Object3D`. Es el peaje de no usar el grafo de escena como modelo
  (ADR 0001, alternativa C).
- Los tipos `@types/three` van por detrás de la librería en algunos módulos de
  `examples/`; con `strict` y `noUncheckedIndexedAccess` activados eso se nota, y
  puede exigir envolturas locales en el adaptador.
- WebGL puede no estar disponible (contexto perdido, GPU en lista negra). El
  adaptador debe fallar de forma legible; el juego sigue simulándose, pero sin
  imagen no hay producto: es un caso a cubrir explícitamente en la
  infraestructura.
