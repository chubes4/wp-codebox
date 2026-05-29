# Portable WP Codebox With WordPress Playground Backend

## Problem

Isolated WordPress environments are powerful for CI, benchmarks, evidence capture, and repeatable investigations. Real-time applications need the same principle in an embeddable TypeScript shape: start a sandbox now, stream/observe work, collect artifacts, and let the user apply or discard results without waiting for CI.

## Proposal

Define a small backend-agnostic runtime contract:

```text
create -> mount -> execute -> observe -> snapshot -> collect artifacts -> destroy
```

WordPress Playground is the first backend because it provides a cheap, portable, reproducible application runtime for WordPress workloads. The contract remains broader than WordPress so future backends can implement the same interface.

## Boundary

- **Parent control planes** own operator, CI, and evidence workflows.
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
| `secrets` | Connector-scoped names can be declared and redacted from artifacts. Secret values stay in parent environment variables and are not accepted in recipe, args, logs, or artifacts. | Whether a control plane may inject no secrets or connector-scoped secrets. |
| `approvals` | Shape only. No approval UI is implemented in the runtime stub. | The approval posture expected by a product surface before writes or commands. |

This keeps the v0 contract honest: `commands` are actively denied by the stub, while the remaining fields are explicit declarations that can be carried into artifacts and enforced as backends become real.

## Connector-Scoped Credential Envelope

Parent sites resolve connector credentials through an explicit envelope. The envelope is provenance, not transport: it names the connector scope and sandbox environment variable names, but never includes secret values.

```json
{
  "schema": "wp-codebox/connector-credentials/v1",
  "connector": "primary-ai",
  "scope": "connector",
  "status": "available",
  "secrets": [
    {
      "name": "OPENAI_API_KEY",
      "status": "available",
      "scope": "primary-ai",
      "source": "parent-env"
    }
  ]
}
```

Status values are `available`, `missing`, or `denied`. A parent WordPress runner fails closed before launching the sandbox when any requested connector credential envelope or secret reports `missing` or `denied`, returning `wp-codebox/connector-credential-failure/v1` with the same redacted connector/secret names and reasons.

Successful runs carry the sanitized envelope through `inputs.inheritance.connectors[].credentials` and artifact provenance. Artifact redaction treats configured secret names and values as redactable, so provenance, logs, patches, mounted files, and review metadata expose only names/status/source/scope.

## Heavyweight Plugin Runtime Recipes

Recipes can declare generic heavyweight plugin runtime needs with `inputs.pluginRuntime`. The block is intentionally consumer-neutral: it describes PHP/WP runtime tuning, ordered setup commands, and health probes for complex plugin stacks without naming a benchmark, grader, reward, or any specific downstream product.

```json
{
  "schema": "wp-codebox/workspace-recipe/v1",
  "runtime": { "wp": "7.0" },
  "inputs": {
    "extraPlugins": [
      {
        "source": "./plugins/page-builder",
        "slug": "page-builder",
        "pluginFile": "page-builder/page-builder.php"
      }
    ],
    "pluginRuntime": {
      "label": "visual-builder-stack",
      "php": {
        "memoryLimit": "512M",
        "maxExecutionTime": 120
      },
      "wpConfigDefines": {
        "WP_DEBUG": true
      },
      "setup": [
        { "command": "wordpress.wp-cli", "args": ["command=option update page_builder_ready yes"] }
      ],
      "healthProbes": [
        { "name": "builder-active", "type": "plugin-active", "pluginFile": "page-builder/page-builder.php" },
        { "name": "builder-option", "type": "wp-cli", "command": "option get page_builder_ready" },
        { "name": "builder-php", "type": "php", "code": "if (!defined('WP_DEBUG')) { throw new RuntimeException('WP_DEBUG missing'); } echo 'ok';" }
      ]
    }
  },
  "workflow": {
    "steps": [
      { "command": "wordpress.run-php", "args": ["code=echo get_option('page_builder_ready');"] }
    ]
  }
}
```

Execution order is stable:

1. Mount recipe workspaces and `extraPlugins`.
2. Install recipe-declared mu-plugin loaders.
3. Activate `extraPlugins` in recipe order.
4. Run `pluginRuntime.setup` steps in declared order.
5. Run `pluginRuntime.healthProbes` in declared order.
6. Import site seeds, then run normal workflow steps.

Failed setup steps or health probes return `diagnostics[]` entries using `wp-codebox/plugin-runtime-diagnostic/v1`. Artifact collection still captures runtime logs, command traces, and the run attestation when an artifact directory is configured.
