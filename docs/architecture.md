# Arquitectura — Neon Pong 3D

Vista del sistema siguiendo el **modelo C4** (niveles 1 a 3) y el recorrido
completo de un tick de simulación.

Las decisiones que justifican esta estructura están en los
[ADR](adr/README.md); este documento describe **qué hay**, no **por qué**.

---

## Nivel 1 — Contexto

Quién usa el sistema y de qué depende.

```mermaid
flowchart TB
    player(["Jugador<br/>persona"])

    game["Neon Pong 3D<br/>Juego 3D que se ejecuta<br/>íntegramente en el navegador"]

    browser["Navegador web<br/>WebGL2, Web Audio,<br/>Gamepad API, localStorage"]
    pages["GitHub Pages<br/>Hosting estático del<br/>bundle compilado"]

    player -->|"Teclado, ratón o mando"| game
    game -->|"Imagen, sonido y HUD"| player
    game -->|"Renderiza, sintetiza audio<br/>y persiste récords"| browser
    pages -->|"Sirve HTML, JS y assets"| browser

    classDef system fill:#0f766e,stroke:#0d9488,color:#f0fdfa
    classDef external fill:#334155,stroke:#475569,color:#f8fafc
    classDef person fill:#7c3aed,stroke:#8b5cf6,color:#f5f3ff
    class game system
    class browser,pages external
    class player person
```

No hay backend, ni cuentas, ni telemetría: todo el estado vive en la pestaña del
navegador.

---

## Nivel 2 — Contenedores

Qué unidades desplegables componen el sistema y cómo se comunican.

```mermaid
flowchart TB
    player(["Jugador"])

    subgraph pages["GitHub Pages"]
        static["Bundle estático<br/>HTML + CSS + JS<br/>generado por Vite"]
    end

    subgraph tab["Pestaña del navegador"]
        app["App chunk<br/>TypeScript<br/>dominio + aplicación + adaptadores"]
        vendor["Vendor chunk<br/>Three.js<br/>aislado vía manualChunks"]
        canvas["Canvas WebGL<br/>Escena 3D"]
        audio["Grafo Web Audio<br/>Síntesis en tiempo real,<br/>sin archivos de sonido"]
        dom["Capa DOM<br/>Menús, HUD y overlays"]
        store[("localStorage<br/>Récords y preferencias")]
    end

    player -->|"Eventos de entrada"| dom
    static -.->|"Descarga inicial"| app
    static -.->|"Descarga inicial"| vendor
    app -->|"importa"| vendor
    app -->|"dibuja en"| canvas
    app -->|"programa nodos en"| audio
    app -->|"actualiza"| dom
    app -->|"lee / escribe"| store
    canvas --> player
    audio --> player

    classDef container fill:#0f766e,stroke:#0d9488,color:#f0fdfa
    classDef db fill:#1e40af,stroke:#3b82f6,color:#eff6ff
    classDef person fill:#7c3aed,stroke:#8b5cf6,color:#f5f3ff
    class static,app,vendor,canvas,audio,dom container
    class store db
    class player person
```

---

## Nivel 3 — Componentes

El interior del *app chunk*. **Todas las flechas apuntan hacia dentro**: ningún
componente de una capa interior conoce a los de las exteriores.

```mermaid
flowchart TB
    subgraph infra["Infraestructura — adaptadores"]
        renderer["ThreeRenderer<br/>implements RendererPort"]
        audioAd["WebAudioAdapter<br/>implements AudioPort"]
        input["InputAdapter<br/>teclado · ratón · gamepad<br/>implements InputPort"]
        clock["RafClock<br/>implements ClockPort"]
        storage["LocalStorageAdapter<br/>implements StoragePort"]
        ui["DomShell<br/>menús y HUD<br/>implements UiPort"]
    end

    main["main.ts<br/>composition root<br/>el único que conoce ambos lados"]

    subgraph application["Aplicación — orquestación"]
        ports["ports.ts<br/>RendererPort · AudioPort · InputPort<br/>ClockPort · StoragePort · UiPort"]
        session["GameSession<br/>modo, dificultad, pantallas,<br/>estadísticas"]
        loop["GameLoop<br/>acumulador de timestep fijo"]
    end

    subgraph domain["Dominio — puro y determinista"]
        match["Match<br/>aggregate root"]
        physics["physics.ts<br/>colisión continua"]
        rules["rules.ts · arena.ts<br/>entities.ts · math/vec3.ts"]
        events["events.ts<br/>DomainEvent"]
        rng["rng.ts<br/>mulberry32"]
        ai["ai/<br/>AiOpponent · predictIntercept<br/>AI_PROFILES"]
    end

    main --> renderer & audioAd & input & clock & storage & ui
    main --> session
    main --> loop
    renderer -.->|"implementa"| ports
    audioAd -.->|"implementa"| ports
    input -.->|"implementa"| ports
    clock -.->|"implementa"| ports
    storage -.->|"implementa"| ports
    ui -.->|"implementa"| ports
    session --> match
    session --> ai
    ports -.->|"usa tipos de"| events
    loop --> rules
    match --> physics
    match --> rules
    match --> events
    match --> rng
    ai --> physics
    ai --> rng

    classDef domainNode fill:#0f766e,stroke:#14b8a6,color:#f0fdfa
    classDef appNode fill:#1e40af,stroke:#3b82f6,color:#eff6ff
    classDef infraNode fill:#334155,stroke:#64748b,color:#f8fafc
    classDef rootNode fill:#b45309,stroke:#f59e0b,color:#fffbeb
    class match,physics,rules,events,rng,ai domainNode
    class ports,session,loop appNode
    class renderer,audioAd,input,clock,storage,ui infraNode
    class main rootNode
```

### Regla de dependencia

| Capa | Puede importar de | Prohibido |
|------|-------------------|-----------|
| `src/domain/**` | solo de `src/domain` | `three`, DOM, `window`, `Math.random`, `Date.now` |
| `src/application/**` | `src/domain` | `three`, DOM, `window` |
| `src/infrastructure/**` | `src/application` (puertos) y tipos de `src/domain` | escribir reglas de juego |
| `src/main.ts` | todas | — |

Una violación de esta tabla es un error de arquitectura verificable, no una
cuestión de estilo.

---

## Un tick de simulación

Recorrido de un frame real: el reloj despierta el bucle, el bucle drena el
acumulador en pasos fijos de 1/120 s y, al final, dibuja el estado interpolado.

```mermaid
sequenceDiagram
    autonumber
    participant Clock as ClockPort · rAF
    participant Main as main.ts
    participant Input as InputPort
    participant Loop as GameLoop
    participant Session as GameSession
    participant Ai as AiOpponent
    participant Match as Match
    participant Renderer as RendererPort
    participant Audio as AudioPort
    participant Ui as UiPort

    Clock->>Main: onFrame(delta, elapsed)
    Main->>Input: sample()
    Note right of Input: Se muestrea una sola vez por frame:<br/>las acciones son de flanco y se<br/>consumirían dos veces dentro del bucle.
    Input-->>Main: InputFrame {near, far, actions}
    Main->>Main: aplica actions (pausa, cámara, audio)
    Main->>Loop: frame(delta, elapsed)

    loop mientras acumulador >= 1/120 s
        Loop->>Main: update(dt)
        Main->>Session: step(dt, intents)
        Session->>Ai: intent(ball, paddle, dt)
        Note right of Ai: Solo replanifica cada reactionDelay;<br/>entre medias se compromete con su lectura.
        Ai-->>Session: PaddleIntent
        Session->>Match: step(dt, intents resueltos)
        Match->>Match: advancePaddle · advanceBall (CCD)
        Match-->>Session: DomainEvent[]
        Session->>Session: actualiza récords y pantalla
        Session-->>Main: DomainEvent[]
        Main->>Renderer: handleEvents(events)
        Main->>Audio: handleEvents(events)
    end

    Loop->>Main: render(alpha, delta, elapsed)
    Main->>Renderer: render({previous, current, alpha, time, delta, dimmed})
    Main->>Ui: render(HudView)
    Renderer-->>Main: fps
```

Puntos que el diagrama hace explícitos:

- El **dominio nunca es llamado por la infraestructura**. `main.ts` recoge los
  eventos y los reparte; el `Match` no sabe que existe un renderer.
- Los `DomainEvent` son el **único** canal de notificación. Si el audio necesita
  saber que hubo un golpe en el borde de la pala, ese dato viaja en el evento
  (`edge: true`), no se deduce inspeccionando la física.
- El render ocurre **una vez por frame**, con `alpha`; la simulación ocurre
  **0..n veces por frame**, siempre con el mismo `dt`.

---

## Máquina de estados de pantalla

`GameSession` es la dueña de esta transición; `UiPort` solo la refleja.

```mermaid
stateDiagram-v2
    [*] --> menu
    menu --> playing: start(mode, difficulty)
    playing --> paused: pause()
    paused --> playing: resume()
    playing --> over: match-won
    over --> playing: restart()
    over --> menu: quitToMenu()
    paused --> menu: quitToMenu()
    note right of over
        En modo demo el evento match-won
        reinicia la partida en lugar de
        terminarla: la atracción no acaba.
    end note
```
