# ADR 0006 — IA predictiva en lugar de seguimiento

- **Estado:** aceptada
- **Fecha:** 2026-02
- **Ámbito:** `src/domain/ai/**`

## Contexto

La IA de la v1 cabía en cinco líneas: `targetY = ball.y` y moverse hacia ahí a
`aiSpeed` píxeles por frame, con cuatro dificultades que se diferenciaban
únicamente en esa velocidad y en un factor de "reacción".

Ese enfoque no sobrevive al salto a 3D por tres motivos:

1. **Dos ejes en vez de uno.** Seguir la bola en `x` e `y` a la vez produce un
   movimiento diagonal errático y muy legible como artificial.
2. **Rebotes en pared.** Con una arena de 18×11 unidades, la bola cambia de
   dirección varias veces antes de llegar; seguir su posición actual lleva la
   pala justo al lado equivocado.
3. **Efecto Magnus.** Con spin, la trayectoria es curva: la posición actual no
   predice nada.

Y hay un problema de diseño anterior a lo técnico: **una IA que solo es más
rápida no es más difícil, es más injusta**. El jugador percibe una pala
teletransportándose, no un rival.

## Decisión

La IA **resuelve la trayectoria** y la dificultad se modela como **limitaciones
humanas**.

- `predictIntercept(arena, rules, ball, side, horizon)` integra hacia delante una
  *copia* de la bola —incluyendo Magnus, decaimiento del spin y reflexiones en
  pared— hasta que cruza el plano de la pala, y devuelve `{x, y, time, bounces}`.
  Ignora deliberadamente las palas: la pregunta es "si nadie interviene, ¿dónde
  llega?".
- `AiOpponent` es **una fuente de input más**: produce el mismo `PaddleIntent`
  que un teclado o un mando. El motor no distingue humano de máquina, lo que hace
  gratis el modo demo CPU contra CPU.
- El perfil de dificultad (`AiProfile`) se expresa en términos humanos:
  `reactionDelay`, `aimError`, `horizon`, `anticipation`, `lapseChance`,
  `aggression` y `speedFactor`.
- Entre replanificaciones el rival **se compromete** con su decisión, que es lo
  que produce los momentos de "la ha leído mal" en vez de una corrección
  instantánea.
- `anticipation` mezcla entre la posición actual de la bola y el intercepto
  predicho: los perfiles débiles *siguen* la bola, los fuertes *confían* en su
  lectura. La v1 es, literalmente, el caso `anticipation = 0`.

## Alternativas consideradas

**A. Seguir la bola (v1).**
Sobrevive como caso degenerado dentro de `anticipation`, pero no como estrategia:
en 3D produce un rival simultáneamente torpe y frustrante.

**B. Solución analítica cerrada** (desplegar la arena por reflexiones especulares
y resolver el cruce del plano de una vez).
Es exacta y O(1)... pero solo con velocidad constante y sin fuerzas. El efecto
Magnus curva la trayectoria y la anula. Descartada por incompatibilidad con la
física del ADR 0004.

**C. Política aprendida (red neuronal, aprendizaje por refuerzo).**
Impresionante en una demo, pésima aquí: pesos que servir, comportamiento no
determinista (choca con el ADR 0002), imposible de razonar y desproporcionado
para un Pong.

**D. Dificultad por velocidad de pala** (la de la v1, mantenida).
Barata de implementar y mala como producto: convierte "difícil" en "imposible de
leer". Se conserva solo como un factor secundario (`speedFactor`), no como el eje
de la dificultad.

## Consecuencias

**Positivas**

- El rival se comporta de forma **legible**: se posiciona pronto, ataja rebotes y
  falla de manera plausible. Se percibe como un jugador, no como un límite.
- La dificultad es afinable en dimensiones independientes; se puede hacer un
  rival lento pero certero, o rápido y precipitado.
- Al ser la IA un productor de `PaddleIntent`, el modo demo (atracción) y un
  futuro modo entrenamiento salen sin código adicional.
- Toda la IA vive en el dominio puro, así que se puede evaluar sin navegador:
  simular 1.000 partidas y medir el porcentaje de victorias por perfil es un
  test, no una sesión de juego manual.

**Negativas y costes reales**

- **Coste de cálculo acotado pero no trivial.** `predictIntercept` integra a
  1/120 s hasta el `horizon`: en el perfil `singularity` (horizonte 4,5 s,
  `reactionDelay` 0,03 s) el peor caso son ~540 iteraciones por replanificación y
  hasta ~33 replanificaciones por segundo. Es el componente más caro del dominio
  y el primero a vigilar si aparecen caídas de FPS en móviles.
- **Duplicación de la integración.** El predictor reimplementa el Magnus, el
  clamp de velocidad y las reflexiones de `advanceBall`, y además resuelve las
  paredes por espejo en vez de por tiempo de impacto. Son dos implementaciones de
  la misma física que hay que **mantener en sincronía a mano**: si alguien cambia
  `physics.ts` y no `predictor.ts`, la IA empieza a fallar sin que ningún test lo
  note. Mitigación recomendada: una prueba de propiedad que acote la divergencia
  entre predicción y simulación real.
- La predicción **ignora las palas** por diseño; con dos rivales de IA (modo
  demo) eso es correcto, pero significa que la IA no planifica jugadas, solo
  intercepta.
- El jitter de `aimError` consume el mismo flujo de RNG que el saque, con la
  consecuencia descrita en el **ADR 0002**: cambiar la frecuencia de decisión de
  la IA altera los ángulos de saque de partidas con la misma semilla.
- `singularity` (`speedFactor` 1, `aimError` 0,08, `lapseChance` 0) es
  deliberadamente casi imbatible; su función es de vitrina, no de dificultad
  jugable. Conviene que la interfaz lo comunique.
