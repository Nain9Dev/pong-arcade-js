# ADR 0002 — Dominio determinista y RNG inyectado

- **Estado:** aceptada
- **Fecha:** 2026-02
- **Ámbito:** `src/domain/rng.ts`, `Match`, `AiOpponent`

## Contexto

La v1 llamaba a `Math.random()` en el saque y en las partículas, y leía el reloj
del sistema dentro del bucle. Con eso, dos ejecuciones nunca son iguales:

- un fallo reportado ("la bola se quedó atascada en la pared") no se puede
  reproducir,
- las pruebas basadas en propiedades no pueden reducir un contraejemplo, porque
  cada re-ejecución genera un mundo distinto,
- no existe forma de verificar una partida a posteriori.

La física de la v2 es lo bastante rica (colisión continua, efecto Magnus,
transferencia de velocidad de la pala) como para que los fallos interesantes
aparezcan solo en configuraciones raras. Necesitamos poder capturarlos.

## Decisión

**El dominio no tiene acceso a ninguna fuente de no-determinismo.**

- Todo el azar pasa por el puerto `Rng` (`next`, `range`, `bool`, `state`),
  implementado con **mulberry32**: un PRNG de 32 bits, sin dependencias, rápido y
  con estado explícito e inspeccionable.
- `Match` y `AiOpponent` reciben el `Rng` por constructor. No importan
  `Math.random` ni `Date.now`.
- El tiempo entra siempre como parámetro `dt` en `step(dt, intents)`. El dominio
  no pregunta la hora.
- `randomSeed()` existe, pero se usa **solo en el composition root**, donde ya no
  hay reglas de negocio.

Consecuencia formal: **una partida queda determinada por la tupla
`(semilla, traza de intents)`**.

## Alternativas consideradas

**A. `Math.random()` directo.**
Cero código. Se descarta: es exactamente el problema que motiva el ADR.

**B. Singleton global con semilla (`seedRandom()` al arrancar).**
Da reproducibilidad, pero introduce estado global compartido: dos partidas en la
misma pestaña, o un test que se ejecuta en paralelo con otro, se contaminan. La
inyección cuesta un parámetro y elimina la clase entera de problemas.

**C. `crypto.getRandomValues()`.**
Mejor calidad estadística, pero no es reproducible y no está disponible en todos
los contextos de ejecución. La calidad criptográfica no aporta nada al ángulo de
un saque.

**D. Determinismo total *sin* azar** (saques con patrón fijo).
Máxima reproducibilidad y peor juego: los saques idénticos se memorizan en cinco
minutos. El azar acotado es un requisito de producto.

## Consecuencias

**Positivas**

- `fast-check` puede generar miles de partidas, encontrar un contraejemplo y
  **reducirlo** hasta el caso mínimo, porque re-ejecutar la semilla reproduce el
  fallo bit a bit.
- Las invariantes se pueden afirmar como propiedades: "la bola nunca sale de la
  arena", "la velocidad nunca supera `maxSpeed`", "tras un golpe la bola se aleja
  de la pala que la tocó".
- Abre la puerta, sin cambios de diseño, a repeticiones compartibles y a
  verificación de resultados en servidor: basta con guardar semilla e inputs.
- `rng.state` permite serializar y reanudar el flujo exacto.

**Negativas y riesgos**

- **Un único flujo de RNG es un acoplamiento sutil.** `GameSession` construye
  `Match` y `AiOpponent` con la *misma* instancia de `Rng`. Como la IA consume
  números en cada replanificación, **cambiar la frecuencia de decisión de la IA
  desplaza el flujo y altera los ángulos de saque**. Las partidas siguen siendo
  reproducibles, pero no son comparables entre versiones de la IA. Si en algún
  momento se quieren comparar builds o versionar repeticiones, habrá que dar un
  flujo derivado independiente a cada consumidor (por ejemplo,
  `createRng(seed ^ 0x9e3779b9)` para la IA).
- Mulberry32 tiene un periodo de 2³² y no es criptográficamente seguro. Es
  irrelevante para el uso actual, pero **no debe reutilizarse** para nada que no
  sea jugabilidad.
- Toda característica futura con azar (efectos, cámaras dinámicas, variaciones de
  arena) debe recibir el `Rng` explícitamente, o romperá la propiedad. Es
  disciplina permanente, no una decisión que se toma una vez.
- El determinismo es sobre **la misma implementación**: la aritmética de coma
  flotante en JavaScript es IEEE-754 y estable entre motores para estas
  operaciones, pero cualquier cambio en el orden de las operaciones de la física
  invalida las repeticiones antiguas.
