# WP Codebox

Portable TypeScript substrate for isolated application runtimes. WordPress Playground is the first backend.

## Thesis

WP Codebox is not an app, an agent framework, or a CI harness. It is a small runtime contract for app and agent platforms that need to create isolated environments, mount inputs, execute controlled actions, observe state, and export artifacts.

```text
App or agent platform
  -> WP Codebox contract
  -> Backend adapter
  -> Isolated environment
  -> Artifact bundle
```

The flagship use case is real-time, sandboxed coding inside application environments. A product can let a user chat with an agent, run the work inside a disposable sandbox, stream observations, and apply only the resulting artifact to a real project or site.

For WordPress, this means a control plane such as Studio, Data Machine, or WordPress.com can run agents against WordPress Playground sandboxes instead of granting broad access to production sites, local machines, or CI-only harnesses.

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
    "eventsPath": "./artifacts/runtime-.../events.jsonl",
    "commandsPath": "./artifacts/runtime-.../commands.jsonl",
    "observationsPath": "./artifacts/runtime-.../observations.jsonl"
  }
}
```

WP Codebox mounts the local plugin directory into WordPress Playground and boots lazily on the first `execute()` call. The CLI command runs PHP from `--arg code-file=...` through `server.playground.run()`, collects artifacts, and disposes the Playground server when the runtime is destroyed. Machine-readable JSON gives consumers such as Data Machine Code, Homeboy Extensions, Studio, and CI runners a stable integration seam.

`wordpress.run-php` accepts either `--arg code-file=<path>` or `--arg code=<php>`. It loads `/wordpress/wp-load.php` before running the supplied PHP so WordPress functions are available by default. Use `--arg bootstrap=none` for raw PHP execution without WordPress bootstrap.

Use `--wp trunk`, `--wp nightly`, or a numeric WordPress version when a mounted plugin stack requires a version other than Playground's default.

The fixture plugin is documented in [`examples/simple-plugin/README.md`](examples/simple-plugin/README.md).

## WordPress Ability Surface

The WordPress plugin in `packages/wordpress-plugin` registers:

- `wp-codebox/run-agent-task`
- `wp-codebox/run-agent-task-batch`

This is the parent-site control-plane surface for frontend/chat integrations. A chat agent can be granted this ability without receiving raw shell or parent-site filesystem access. The ability launches `wp-codebox agent-sandbox-run`, which boots a disposable WordPress Playground runtime, mounts the configured agent stack, invokes the sandbox agent through `agents/chat`, and returns artifact metadata.

For parallel cooking, `wp-codebox agent-sandbox-batch` and `wp-codebox/run-agent-task-batch` accept multiple tasks and run each task in its own isolated Playground sandbox with a bounded concurrency limit. This is the first coordinator primitive for issue fan-out: a parent can turn several GitHub issues into separate sandbox agent runs, and each sandbox agent is responsible for doing its own branch/test/PR work through the mounted coding tools.

Parent control planes can pass `provider` and `model` to seed the disposable sandbox's Data Machine agent configuration for the requested execution mode. Provider plugins are mounted through generic `--provider-plugin` CLI arguments or `provider_plugin_paths` ability input; WP Codebox does not know about specific providers. Provider credentials still resolve through the mounted provider's normal scoped mechanism, so raw API keys do not need to appear in task payloads. Use `--secret-env <NAME>` or ability input `secret_env: ["NAME"]` to allow-list a parent process environment variable for injection into the sandbox PHP process; artifacts record the env name, not the value.

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

The first backend is WordPress Playground. Future consumers can include Studio, Data Machine Code, wp-gym, world-of-wordpress, WordPress.com product surfaces, and CI/eval runners.

## Related Issues

- https://github.com/chubes4/wp-codebox/issues/1
- https://github.com/chubes4/wp-codebox/issues/2
- https://github.com/chubes4/wp-codebox/issues/3
- https://github.com/chubes4/wp-codebox/issues/4
- https://github.com/chubes4/wp-codebox/issues/5
- https://github.com/chubes4/wp-codebox/issues/6
- https://github.com/chubes4/wp-codebox/issues/7
