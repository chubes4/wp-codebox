# WP Codebox Roadmap

## North Star

WP Codebox is a portable TypeScript substrate for real-time, isolated application environments. It lets products create sandboxes, mount inputs, execute controlled actions, observe state, and collect artifacts.

The first backend is WordPress Playground. The first flagship workload is sandboxed WordPress coding agents.

## Why Now

Homeboy, world-of-wordpress, wp-site-generator, wp-gym, and Data Machine Code have already proven the pattern:

```text
isolated environment + controlled execution + evidence bundle
```

WP Codebox turns that repeated pattern into a stable application surface.

## Phases

### Phase 1: Contract and Hello Runtime

- Define `runtime-core` interfaces.
- Keep the core package backend-agnostic.
- Ship a Playground-shaped backend stub.
- Produce a structured artifact bundle.
- Keep the CLI independent from Studio, Data Machine, Homeboy, Codex, and Agents API.

### Phase 2: Real Playground Backend

- Boot an actual WordPress Playground runtime.
- Mount plugins, themes, and fixtures.
- Execute the smallest real action available through Playground.
- Preserve v0 policy and artifact contracts.

### Phase 3: Real-Time Runtime Events

- Add event streaming for lifecycle, mounts, commands, observations, and artifacts.
- Keep events suitable for product UIs and WordPress control planes.

### Phase 4: WordPress Control Plane Adapter

- Let Data Machine call WP Codebox from WordPress.
- Map Data Machine jobs, approvals, agents, and auth refs onto runtime tasks.
- Keep WP Codebox standalone; the WordPress integration is an adapter.

### Phase 5: Agent Actors

- Add an actor contract for Codex/OpenCode/Claude-like coding agents.
- Keep agents as actors inside sandboxes, not as the substrate.
- Support WordPress-native agent loops through Data Machine / Agents API / WP AI Client where appropriate.

### Phase 6: Studio / Product Spike

- Identify one Studio path that can consume the runtime contract.
- Replace one PI-harness-shaped path with WP Codebox for a focused demo.
- Show create, observe, artifact, and apply/discard UX.

## Boundaries

- Homeboy remains the operator/CI/evidence harness.
- Agents API owns agent identity, sessions, tool loops, and events.
- WP AI Client owns direct model calls.
- Connectors/Data Machine auth own provider/runtime credentials.
- WP Codebox owns isolated environments and artifacts.
