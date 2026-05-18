# Portable WP Codebox With WordPress Playground Backend

## Problem

Homeboy proves that isolated WordPress environments are powerful for CI, benchmarks, evidence capture, and repeatable investigations. Studio and other real-time applications need the same principle in an embeddable TypeScript shape: start a sandbox now, stream/observe work, collect artifacts, and let the user apply or discard results without waiting for CI.

## Proposal

Define a small backend-agnostic runtime contract:

```text
create -> mount -> execute -> observe -> snapshot -> collect artifacts -> destroy
```

WordPress Playground is the first backend because it provides a cheap, portable, reproducible application runtime for WordPress workloads. The contract remains broader than WordPress so future backends can implement the same interface.

## Boundary

- **Homeboy** remains the operator/CI/evidence harness.
- **Agents API** owns agent identity, sessions, tools, and run loops.
- **WP AI Client** owns model/provider prompt execution.
- **Connectors API** owns external service auth and credential configuration.
- **WP Codebox** owns isolated environments, mounts, execution policy, observations, snapshots, and artifacts.

## First Milestone

Hello Runtime:

1. Define runtime-core interfaces.
2. Implement a Playground-shaped backend stub.
3. Mount a sample plugin directory.
4. Execute a controlled action.
5. Write an artifact bundle.
6. Destroy the runtime.

This milestone proves the API and artifact shape before integrating real Playground execution.

## v0 Policy Semantics

The v0 policy is intentionally small and backend-agnostic. Core validation proves that the declared policy has the expected shape; individual backends and control planes decide how much of each field can be enforced in their environment.

| Field | Enforced in v0 | Declared in v0 |
| --- | --- | --- |
| `commands` | Yes. Backends can call `assertRuntimeCommandAllowed()` before execution. Disallowed commands raise `RuntimeCommandPolicyViolationError` with structured `toJSON()` output for artifacts. | The complete command allow-list requested by the control plane. |
| `network` | Shape only. `allow`, `deny`, and host allow-lists are validated. | The network boundary that a real runtime backend must enforce. |
| `filesystem` | Shape only. Mount and write behavior still belongs to backend implementations. | The intended filesystem boundary for sandbox-local writes and mounted inputs. |
| `secrets` | Shape only. No secret injection is implemented in the runtime stub. | Whether future control planes may inject no secrets or connector-scoped secrets. |
| `approvals` | Shape only. No approval UI is implemented in the runtime stub. | The approval posture expected by a product surface before writes or commands. |

This keeps the v0 contract honest: `commands` are actively denied by the stub, while the remaining fields are explicit declarations that can be carried into artifacts and enforced as backends become real.
