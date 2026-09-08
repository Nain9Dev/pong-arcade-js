# Architecture Decision Records

Decisiones estructurales del proyecto, con su contexto, las alternativas que se
descartaron y las consecuencias —incluidas las malas— que se aceptan al tomarlas.

Formato: Contexto / Decisión / Alternativas consideradas / Consecuencias.
Una ADR no se edita cuando cambia de opinión: se escribe otra que la sustituya.

| # | Decisión | Estado |
|---|----------|--------|
| [0001](0001-arquitectura-hexagonal.md) | Arquitectura hexagonal (puertos y adaptadores) | Aceptada |
| [0002](0002-dominio-determinista-y-rng-inyectado.md) | Dominio determinista y RNG inyectado | Aceptada |
| [0003](0003-timestep-fijo-con-interpolacion.md) | Timestep fijo con interpolación de render | Aceptada |
| [0004](0004-deteccion-continua-de-colisiones.md) | Detección continua de colisiones | Aceptada |
| [0005](0005-three-js-como-adaptador-de-render.md) | Three.js como adaptador de render | Aceptada |
| [0006](0006-ia-predictiva-en-lugar-de-seguimiento.md) | IA predictiva en lugar de seguimiento | Aceptada |

Ver también [`../architecture.md`](../architecture.md) para la vista C4 del
sistema y el diagrama de secuencia de un tick de simulación.
