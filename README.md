# WP Codebox

Disposable sandboxes for agent-built artifacts, with replayable evidence and reviewable outputs. WordPress Playground is the first backend.

## Thesis

WP Codebox is not an app, an agent framework, or a CI harness. It is a small runtime contract for platforms that need to create isolated environments, mount inputs, execute controlled actions, observe state, and export durable artifacts before the sandbox disappears.

```text
App or agent platform
  -> WP Codebox contract
  -> Backend adapter
  -> Isolated environment
  -> Replayable artifact bundle
```

The flagship use case is real-time, sandboxed agent work. A product can let a user chat with an agent, run the work inside a disposable sandbox, stream observations, and apply only the resulting artifact to a real project or site.

For WordPress, this means a control plane such as Studio, Data Machine, or WordPress.com can run agents against WordPress Playground sandboxes instead of granting broad access to production sites, local machines, or CI-only harnesses.

The produced artifact does not have to be WordPress-specific. A WordPress Playground sandbox can still produce a static site, source bundle, dataset, patch, docs export, eval fixture, or any other reviewable output.

## Packages

- `@chubes4/wp-codebox-core`: backend-agnostic runtime interfaces and shared types.
- `@chubes4/wp-codebox-playground`: first backend adapter shaped around WordPress Playground.
- `@chubes4/wp-codebox-cli`: `wp-codebox` command for external consumers.
- `packages/wordpress-plugin`: WordPress ability surface for parent sites that launch sandboxed agent tasks.

## CLI

```bash
npm install
npm run build
npm run wp-codebox -- run \
  --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin \
  --command wordpress.run-php \
  --arg code-file=./examples/simple-plugin/probe.php \
  --artifacts ./artifacts \
  --json
```

Expected output:

```json
{
  "success": true,
  "runtime": {
    "backend": "wordpress-playground",
    "status": "destroyed"
  },
  "execution": {
    "command": "wordpress.run-php",
    "exitCode": 0
  },
  "artifacts": {
    "directory": "./artifacts/runtime-...",
    "manifestPath": "./artifacts/runtime-.../manifest.json",
    "blueprintAfterPath": "./artifacts/runtime-.../blueprint.after.json",
    "blueprintAfterNotesPath": "./artifacts/runtime-.../blueprint.after-notes.json",
    "eventsPath": "./artifacts/runtime-.../events.jsonl",
    "commandsPath": "./artifacts/runtime-.../commands.jsonl",
    "observationsPath": "./artifacts/runtime-.../observations.jsonl",
    "capturedMountsPath": "./artifacts/runtime-.../files/mounted-files.json"
  }
}
```

WP Codebox mounts the local plugin directory into WordPress Playground and boots lazily on the first `execute()` call. The CLI command runs PHP from `--arg code-file=...` through `server.playground.run()`, collects artifacts, and disposes the Playground server when the runtime is destroyed. Machine-readable JSON gives consumers such as Data Machine Code, Homeboy Extensions, Studio, wp-gym, and CI runners a stable integration seam.

`wordpress.run-php` accepts either `--arg code-file=<path>` or `--arg code=<php>`. It loads `/wordpress/wp-load.php` before running the supplied PHP so WordPress functions are available by default. Use `--arg bootstrap=none` for raw PHP execution without WordPress bootstrap.

Use `--wp trunk`, `--wp nightly`, or a numeric WordPress version when a mounted plugin stack requires a version other than Playground's default.

The fixture plugin is documented in [`examples/simple-plugin/README.md`](examples/simple-plugin/README.md).

## Workspace Recipes

Recipes package a repeatable sandbox setup and workflow as JSON. They are the portable lab contract for workshops, contributor-day environments, isolated testing, evals, and reproducible bug kits.

```bash
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/simple-plugin.json \
  --json
```

Recipe shape:

```json
{
  "schema": "wp-codebox/workspace-recipe/v1",
  "runtime": {
    "backend": "wordpress-playground",
    "name": "simple-plugin-lab",
    "wp": "latest"
  },
  "inputs": {
    "mounts": [
      {
        "source": "../simple-plugin",
        "target": "/wordpress/wp-content/plugins/simple-plugin",
        "mode": "readwrite"
      }
    ],
    "secretEnv": []
  },
  "workflow": {
    "steps": [
      {
        "command": "wordpress.run-php",
        "args": ["code-file=./examples/simple-plugin/probe.php"]
      }
    ]
  },
  "artifacts": {
    "directory": "./artifacts"
  }
}
```

The first recipe schema intentionally maps to existing runtime primitives: WordPress version, mounted inputs, allow-listed environment variable names, workflow steps, and artifact directory. Relative mount paths resolve from the recipe file location. Workflow commands are used as the runtime command allow-list for that run.

## Artifact Bundles

Artifact capture is owned by WP Codebox because the runtime boundary knows what was mounted, what executed, and what must survive teardown. Agent frameworks and workspaces can mutate files inside the sandbox; WP Codebox captures the result from outside the sandbox before disposal.

Current bundles include:

- `manifest.json`: artifact index with content types.
- `metadata.json`: runtime, policy, mounts, and collection metadata.
- `blueprint.after.json`: WordPress Playground replay blueprint for WordPress-shaped runs.
- `blueprint.after-notes.json`: replay status, limitations, and next capture targets.
- `events.jsonl`, `commands.jsonl`, `observations.jsonl`: runtime evidence streams.
- `logs/runtime.log`, `logs/commands.log`: human-readable logs.
- `files/mounts.json`: mounted input list.
- `files/mounted-files.json`: captured readwrite mount files with size, SHA-256, target path, and replayability metadata.
- `files/mounts/<index>/...`: copied file contents from readwrite mounts.

For text files from readwrite mounts, `blueprint.after.json` includes `writeFile` steps so the files can be replayed into a fresh WordPress Playground runtime. Binary files and oversized files are copied into the artifact bundle but are not embedded in the blueprint yet. Database exports, option diffs, uploads, active theme/plugin state, and screenshots are planned capture targets.

`blueprint.after.json` is backend-specific. It matters when the output should replay in WordPress Playground. Non-WordPress outputs still use the generic artifact contract: manifest, metadata, copied files, hashes, event streams, command logs, observations, patches, and future generic replay recipes.

```text
Sandbox mutates files/content
  -> WP Codebox captures readwrite mounts and evidence
  -> Sandbox is destroyed
  -> Artifact bundle remains for review/replay/apply-back
```

## WordPress Ability Surface

The WordPress plugin in `packages/wordpress-plugin` registers:

- `wp-codebox/run-agent-task`
- `wp-codebox/run-agent-task-batch`

This is the parent-site control-plane surface for frontend/chat integrations. A chat agent can be granted this ability without receiving raw shell or parent-site filesystem access. The ability launches `wp-codebox agent-sandbox-run`, which boots a disposable WordPress Playground runtime, mounts the configured agent stack, invokes the sandbox agent through `agents/chat`, and returns artifact metadata.

For parallel cooking, `wp-codebox agent-sandbox-batch` and `wp-codebox/run-agent-task-batch` accept multiple tasks and run each task in its own isolated Playground sandbox with a bounded concurrency limit. This is the first coordinator primitive for issue fan-out: a parent can turn several GitHub issues into separate sandbox agent runs, and each sandbox agent is responsible for doing its own branch/test/PR work through the mounted coding tools.

Parent control planes can pass `provider` and `model` to seed the disposable sandbox's Data Machine agent configuration for the requested execution mode. Provider plugins are mounted through generic `--provider-plugin` CLI arguments or `provider_plugin_paths` ability input; WP Codebox does not know about specific providers. Provider credentials still resolve through the mounted provider's normal scoped mechanism, so raw API keys do not need to appear in task payloads. Use `--secret-env <NAME>` or ability input `secret_env: ["NAME"]` to allow-list a parent process environment variable for injection into the sandbox PHP process; artifacts record the env name, not the value.

Agent runtime commands also accept repeatable `--mount <host:vfs[:mode]>` values for additional task inputs. These mounts are generic WP Codebox inputs, not Homeboy/Data Machine concepts.

Component paths come from ability input, the `wp_codebox_component_paths` option, or the `wp_codebox_component_paths` filter. Data Machine Code is the mounted coding-tools component for file-editing agent sandboxes; it provides the workspace/file/GitHub tools inside the sandbox, while WP Codebox owns the parent-site control plane and sandbox lifecycle.

Apply-back is intentionally separate: sandbox task execution returns artifacts and proposed outputs, while applying changes to the real site should use a distinct reviewed permission path.

## v0 Runtime Policy

`RuntimePolicy` is a portable declaration that every backend receives with `RuntimeCreateSpec`. The core package exposes `validateRuntimePolicy()`, `assertRuntimePolicy()`, and `assertRuntimeCommandAllowed()` so backends and control planes can validate the v0 policy shape before work starts.

```ts
const result = validateRuntimePolicy({
  network: "deny",
  filesystem: "readwrite-mounts",
  commands: ["wordpress.run-php"],
  secrets: "none",
  approvals: "never",
})
```

Policy fields are split between **enforced now** and **declared for backend/control-plane enforcement**:

| Field | v0 values | Status |
| --- | --- | --- |
| `commands` | string command allow-list | Enforced by `assertRuntimeCommandAllowed()`; the Playground stub rejects commands outside the list. |
| `network` | `allow`, `deny`, `{ allowHosts }` | Validated in core; declared for real backend enforcement. |
| `filesystem` | `sandbox`, `readonly-mounts`, `readwrite-mounts` | Validated in core; declared for mount/backend enforcement. |
| `secrets` | `none`, `connector-scoped` | Validated in core; declared for control planes that inject credentials. |
| `approvals` | `never`, `on-write`, `on-command` | Validated in core; declared for product/control-plane approval UX. |

Disallowed commands throw `RuntimeCommandPolicyViolationError`. The error includes a stable `code`, denied `command`, `allowedCommands`, and the full `policy`, and serializes cleanly with `toJSON()` for artifact capture.

## Non-Goals

- Replace Homeboy.
- Replace Agents API.
- Replace WP AI Client.
- Implement provider auth or Codex integration in v0.
- Couple the top-level contract to WordPress-specific concepts.
- Couple runtime or artifact capture to Homeboy, Data Machine, wp-gym, or any other consumer.

## Product Direction

WP Codebox should make isolated app sandboxes usable from real-time products, not only CI or operator tools.

```text
User request
  -> control plane creates sandbox task
  -> backend boots isolated runtime
  -> agent or workflow acts inside the sandbox
  -> runtime collects evidence and artifacts
  -> user/app applies, exports, or discards the result
```

The first backend is WordPress Playground. Future consumers can include Studio, Data Machine Code, wp-gym, world-of-wordpress, WordPress.com product surfaces, and CI/eval runners. Homeboy Extensions is one adapter that can invoke WP Codebox in CI; WP Codebox itself remains consumer-agnostic.

## Related Issues

- https://github.com/chubes4/wp-codebox/issues/1
- https://github.com/chubes4/wp-codebox/issues/2
- https://github.com/chubes4/wp-codebox/issues/3
- https://github.com/chubes4/wp-codebox/issues/4
- https://github.com/chubes4/wp-codebox/issues/5
- https://github.com/chubes4/wp-codebox/issues/6
- https://github.com/chubes4/wp-codebox/issues/7
