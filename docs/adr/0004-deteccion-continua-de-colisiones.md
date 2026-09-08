# ADR 0004 — Detección continua de colisiones

- **Estado:** aceptada
- **Fecha:** 2026-02
- **Ámbito:** `src/domain/physics.ts` (`advanceBall`)

## Contexto

En la arena por defecto la bola alcanza **62 unidades/s**, la pala tiene **0,35
unidades de grosor** y el radio de la bola es **0,45**. Con el paso fijo de
1/120 s (ADR 0003), la bola recorre unas **0,52 unidades por paso**, frente a una
ventana de contacto de **1,25 unidades** (grosor de la pala más el diámetro de la
bola).

El margen existe, pero es de apenas 2,4×, y desaparece en cuanto se toca
cualquiera de las variables:

- bajar la simulación a 60 Hz deja el margen en 1,2×;
- subir `maxSpeed` en un preset de dificultad futuro lo elimina;
- el propio movimiento lateral de la pala (hasta 26 u/s) desplaza el rectángulo
  de contacto mientras la bola lo atraviesa.

Y el coste de fallar no es cosmético: la línea de gol está solo **2,05 unidades**
por detrás del plano de contacto (`paddleInset` 1,6 más el radio). Una colisión
perdida no es un artefacto visual, **es un punto encajado**.

A eso se suma un problema de orden: dentro de un mismo paso pueden ocurrir un
rebote en pared y un golpe de pala. Una detección discreta los resuelve en el
orden en que estén escritos los `if`, no en el orden en que ocurren.

## Decisión

`advanceBall` implementa **detección continua** (*swept* / tiempo de impacto):

1. Se calcula analíticamente el **tiempo de impacto** contra cada plano candidato
   — las cuatro paredes y los dos planos de pala.
2. Se avanza la bola **solo hasta el primer contacto**, se resuelve ese contacto
   y se repite con el tiempo restante.
3. El bucle está acotado por `MAX_SUBSTEPS = 8` contactos por paso fijo.
4. Al final se aplica un `clamp` de seguridad numérica en `x` e `y`, porque tras
   muchas reflexiones el error de coma flotante puede dejar la bola una fracción
   de unidad fuera.

Los eventos (`wall-bounce`, `paddle-hit`, `paddle-miss`) se emiten **en orden
cronológico real**, que es lo que consumen el renderer y el audio.

## Alternativas consideradas

**A. Detección discreta (mover y luego comprobar solapamiento).**
Es lo que hacía la v1 y funciona bien a velocidades bajas. Se descarta porque su
corrección depende de que nadie toque el timestep ni la velocidad máxima: es una
propiedad frágil disfrazada de código simple.

**B. Sub-pasos fijos (dividir cada paso en N trozos).**
Reduce la probabilidad de atravesar la pala pero no la elimina, y multiplica el
coste por N aunque no haya ningún contacto. Cambia una garantía por una
estadística.

**C. Barrido esfera–OBB completo.**
Sería necesario si las palas rotaran o si el contacto en las aristas tuviera que
ser físicamente correcto. Aquí las palas son rectángulos alineados a los ejes en
un plano `z` constante, así que el problema se reduce a "cruce de plano más test
de rectángulo": mucho más simple y exacto para esta geometría.

**D. Motor de física externo (`cannon-es`, `rapier`).**
Resuelve esto y mucho más, pero introduce una dependencia pesada en el núcleo,
determinismo dependiente de terceros (y de WASM en el caso de `rapier`) y una
capa de traducción entre su modelo y el nuestro. Para tres cuerpos y seis planos,
la física propia es más pequeña, más rápida y completamente auditable.

## Consecuencias

**Positivas**

- **No hay tunneling, con independencia de la velocidad.** La garantía es
  estructural, no una consecuencia afortunada del tuning actual.
- El `maxSpeed` y el `FIXED_TIMESTEP` vuelven a ser parámetros de *sensación de
  juego*, no restricciones de corrección.
- Los eventos llegan ordenados, así que el sonido del rebote en pared precede
  siempre al del golpe de pala si eso es lo que pasó.
- Es la propiedad más valiosa que verifican las pruebas: para cualquier estado
  inicial y cualquier posición de pala generados por `fast-check`, la bola nunca
  aparece al otro lado de una superficie sólida.

**Negativas y costes reales**

- **Más código y más difícil de leer** que un test de solapamiento. La
  complejidad está concentrada en una función de ~160 líneas que hay que tratar
  como código crítico: cualquier cambio ahí necesita pruebas.
- El límite `MAX_SUBSTEPS = 8` es un **corte duro**: en un caso patológico con
  más de ocho contactos en 8,33 ms, el movimiento restante se descarta. Es
  inalcanzable con los parámetros actuales, pero es una suposición que un preset
  futuro podría violar en silencio.
- El modelo trata la pala como **plano infinito más test de rectángulo**: una
  bola que roza el canto no rebota en la arista, o pasa de largo o se devuelve
  como si hubiera tocado la cara. Es una simplificación deliberada; el jugador no
  la percibe y ahorra el caso más complejo del barrido esfera–OBB.
- `PADDLE_FORGIVENESS = 0,35` amplía el rectángulo de contacto por encima de la
  geometría que se dibuja: es una **mentira intencionada** a favor del jugador. Si
  el renderer dibuja la pala con su tamaño exacto, habrá golpes que se vean
  "fuera". Conviene que el adaptador visual insinúe ese margen (glow, campo de
  fuerza) para que la lectura visual y la física coincidan.
- El coste por paso es variable (de 1 a 8 iteraciones). En el peor caso realista
  —rally rápido con rebote en pared y golpe en el mismo paso— son dos o tres
  iteraciones; no es un problema, pero sí una razón más para no bajar de los 120
  pasos/s con el ordenador ya cargado.
