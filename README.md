# WP Codebox

WP Codebox runs disposable WordPress Playground sandboxes, executes bounded work inside them, and saves replayable artifacts before the sandbox is destroyed.

It is the runtime boundary for agent-built or workflow-built outputs. It is not the agent framework, the review UI, the deploy system, or the production site mutator.

```text
Parent app, CI job, or WordPress control plane
  -> WP Codebox
    -> disposable WordPress Playground runtime
      -> mounted inputs, plugins, tools, and optional agent stack
      -> controlled commands or agent task
      -> artifact bundle
  -> review, replay, apply, export, or discard outside the sandbox
```

## Current Use Cases

- Run a PHP or WP-CLI probe against mounted WordPress code.
- Execute a WordPress Ability inside a disposable Playground runtime.
- Run repeatable workspace recipes that mount plugins, seed workspaces, and capture outputs.
- Launch sandboxed Data Machine / Agents API coding-agent tasks from the CLI or WordPress ability surface.
- Fan out several task descriptions into separate isolated sandboxes.
- Produce artifact bundles that a parent product can review or consume later.

## Repo Components

These are local workspace components in this repo, not published packages yet:

- `packages/runtime-core`: backend-agnostic runtime interfaces and shared types.
- `packages/runtime-playground`: WordPress Playground backend adapter.
- `packages/cli`: source for the local `wp-codebox` CLI used through `npm run wp-codebox`.
- `packages/wordpress-plugin`: parent-site WordPress ability surface.

## Local Setup

```bash
npm install
npm run build
npm run check
```

`npm run check` runs the TypeScript build, policy validation smoke test, WordPress plugin smoke test, and a real Playground-backed CLI smoke test.

## Quick Start

Run PHP inside a disposable WordPress Playground runtime with a local plugin mounted:

```bash
npm run wp-codebox -- run \
  --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin \
  --command wordpress.run-php \
  --arg code-file=./examples/simple-plugin/probe.php \
  --artifacts ./artifacts \
  --json
```

Expected shape:

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
    "capturedMountsPath": "./artifacts/runtime-.../files/mounted-files.json",
    "diffsPath": "./artifacts/runtime-.../files/diffs.json"
  }
}
```

WP Codebox boots Playground lazily on the first command, captures artifacts after execution, and disposes the runtime when the run completes.

## CLI Commands

### `run`

Run one command in a disposable runtime.

```bash
npm run wp-codebox -- run \
  --mount <host-path>:<sandbox-path>[:readonly|readwrite] \
  --command <command> \
  --arg <key=value> \
  --json
```

Supported runtime commands today:

- `inspect-mounted-inputs`: list mounted input entries from inside Playground.
- `wordpress.run-php`: run PHP; accepts `code=<php>` or `code-file=<path>`.
- `wordpress.wp-cli`: run WP-CLI; accepts `command='wp option get home'` or plain args.
- `wordpress.ability`: execute a registered WordPress Ability; accepts `name=<ability>` and optional JSON `input=<object>`.

`wordpress.run-php` loads `/wordpress/wp-load.php` by default. Use `--arg bootstrap=none` for raw PHP.

`wordpress.wp-cli` automatically enables Playground's `wp-cli` extra library when the command is allowed by runtime policy.

WP Codebox defaults to WordPress `7.0` because the agent and AI plugin stacks need the modern WordPress AI surface. Override with `--wp trunk`, `--wp nightly`, or another supported Playground version.

### `recipe validate`

Validate a workspace recipe without launching Playground.

```bash
npm run wp-codebox -- recipe validate \
  --recipe ./examples/recipes/simple-plugin.json \
  --json
```

Validation checks schema, source paths, extra plugin entrypoints, workspace seeds, supported workflow commands, JSON ability inputs, and command arguments.

### `recipe-run`

Run a repeatable recipe.

```bash
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/simple-plugin.json \
  --json
```

Recipes are JSON declarations for a sandbox setup plus workflow steps. They can mount existing directories, create disposable plugin/theme workspaces, activate extra plugins, allow-list selected secret environment variable names, and capture the output as artifacts.

Example recipes:

- `examples/recipes/simple-plugin.json`: mount and probe the fixture plugin.
- `examples/recipes/wp-cli.json`: prove WP-CLI commands mutate the same runtime observed by later steps.
- `examples/recipes/seeded-plugin-workspace.json`: create a disposable plugin scaffold, mutate it, and capture diffs.
- `examples/recipes/datamachine-agent-bundle.json`: mount Agents API and Data Machine, then import a bundle through `wordpress.ability`.

Supported workspace seeds:

- `plugin_scaffold`: creates `<slug>.php` and `README.md`, mounted by default at `/wordpress/wp-content/plugins/<slug>`.
- `theme_scaffold`: creates `style.css`, `index.php`, and `README.md`, mounted by default at `/wordpress/wp-content/themes/<slug>`.
- `directory`: copies `seed.source` into a disposable workspace and requires an explicit sandbox `target`.

### `agent-runtime-probe`

Boot a sandbox with Agents API, Data Machine, and Data Machine Code mounted, then verify the stack loads.

```bash
npm run wp-codebox -- agent-runtime-probe \
  --agents-api ../agents-api \
  --data-machine ../data-machine \
  --data-machine-code ../data-machine-code \
  --json
```

### `agent-sandbox-run`

Run one natural-language task through a sandboxed agent stack.

```bash
npm run wp-codebox -- agent-sandbox-run \
  --agents-api ../agents-api \
  --data-machine ../data-machine \
  --data-machine-code ../data-machine-code \
  --agent sandbox-agent \
  --task "Add a Dry Rub filter to the wing locations map" \
  --provider openai \
  --model gpt-5.5 \
  --json
```

Useful options:

- `--provider-plugin <path>`: mount an AI provider plugin. Repeatable.
- `--secret-env <NAME>`: expose a parent process environment variable by name. Repeatable. Values are read from the process environment and are not accepted in JSON payloads.
- `--mount <host:vfs[:mode]>`: mount extra task inputs.
- `--session-id <id>`: continue an existing sandbox conversation session.
- `--max-turns <n>`: bound the agent loop.

`--code` and `--code-file` still exist for operator/debug use after the agent stack boots. Product-facing task APIs should treat natural-language `--task` as the stable input shape and keep raw code execution gated away from untrusted frontend callers.

### `agent-sandbox-batch`

Run several task descriptions, one isolated sandbox per task, with bounded concurrency.

```bash
npm run wp-codebox -- agent-sandbox-batch \
  --agents-api ../agents-api \
  --data-machine ../data-machine \
  --data-machine-code ../data-machine-code \
  --task "Fix issue A" \
  --task "Investigate issue B" \
  --concurrency 2 \
  --json
```

Use `--tasks-json` or `--tasks-file` when the task list is generated by another system.

## Artifact Bundles

Artifact capture is owned by WP Codebox because WP Codebox knows what was mounted, what executed, and what must survive teardown.

Current bundles include:

- `manifest.json`: artifact index with content types.
- `metadata.json`: runtime, policy, mounts, and caller metadata.
- `blueprint.after.json`: partial WordPress Playground replay blueprint for captured text files.
- `blueprint.after-notes.json`: replay limitations and next capture targets.
- `events.jsonl`, `commands.jsonl`, `observations.jsonl`: runtime evidence streams.
- `logs/runtime.log`, `logs/commands.log`: human-readable logs.
- `files/mounts.json`: mounted input list.
- `files/mounted-files.json`: captured readwrite mount files with size, SHA-256, target path, and replayability metadata.
- `files/diffs.json`: diff index for readwrite mounts that declare a baseline.
- `files/diffs/<mount>.patch`: unified text diff from a seeded baseline to the sandbox output.
- `files/mounts/<index>/...`: copied file contents from readwrite mounts.

Binary files and oversized files are copied when allowed by capture limits but are not embedded into `blueprint.after.json`. Database exports, option diffs, uploaded media, active plugin/theme state, screenshots, normalized test results, and canonical apply-back patch metadata are still future artifact targets.

## WordPress Plugin

The WordPress plugin registers parent-site abilities:

- `wp-codebox/run-agent-task`
- `wp-codebox/run-agent-task-batch`

These abilities shell out to the local `wp-codebox` CLI, boot disposable Playground sandboxes, mount the configured agent stack, invoke the sandbox agent through `agents/chat`, and return artifact metadata.

Component paths can come from ability input, the `wp_codebox_component_paths` option, or the `wp_codebox_component_paths` filter.

Expected component keys:

- `agents_api`
- `data_machine`
- `data_machine_code`
- `provider_plugins` (optional list)

The CLI binary can come from ability input, the `wp_codebox_bin` option, or the `wp_codebox_bin` filter.

Data Machine Code is a mounted coding-tools component inside the sandbox. It provides workspace/file/GitHub tools to the sandboxed agent. WP Codebox owns the parent-site ability surface, sandbox lifecycle, and artifact capture boundary.

Apply-back is intentionally not part of `run-agent-task`. Sandbox execution returns proposed outputs and evidence. Applying those outputs to a real site, opening a PR, exporting a package, approving files, or discarding artifacts should use separate reviewed abilities and policy.

## Runtime Policy

`RuntimePolicy` declares the intended sandbox boundary and command allow-list.

```ts
const policy = {
  network: "deny",
  filesystem: "readwrite-mounts",
  commands: ["wordpress.run-php"],
  secrets: "none",
  approvals: "never",
}
```

Current enforcement:

| Field | Status |
| --- | --- |
| `commands` | Enforced by `assertRuntimeCommandAllowed()` before backend execution. |
| `network` | Shape validated; real network enforcement is backend/control-plane work. |
| `filesystem` | Shape validated; mount/write enforcement is backend/control-plane work. |
| `secrets` | Shape validated; selected env var injection is allow-list based today. |
| `approvals` | Shape validated; product approval UX is still separate work. |

## Boundaries

WP Codebox owns:

- Disposable runtime lifecycle.
- Mounting inputs into Playground.
- Controlled command execution.
- Runtime event and artifact capture.
- Parent-site ability surface for launching sandbox tasks.

WP Codebox does not own:

- Agent identity, sessions, or model loop internals. Agents API and Data Machine own those.
- Model provider authentication. Provider plugins and parent control planes own credentials.
- Production mutation or deploy. Apply-back must be separate and reviewed.
- CI/eval orchestration. Homeboy, wp-gym, or other consumers can invoke WP Codebox.
- Frontend review UX. WP Codebox should produce renderable artifacts for those UIs.

## Near-Term Gaps

- Split raw operator/debug PHP execution away from product-facing task APIs.
- Define canonical `patch.diff`, `changed-files.json`, content-addressed artifact IDs, and redaction guarantees.
- Add list/get/discard/apply-approved artifact abilities to the WordPress plugin.
- Define multi-user sandbox session lifecycle, retention, quotas, cancellation, and audit records.
- Define reviewed apply-back adapters for bot-authored PRs, direct apply, and package export.
- Add frontend progress/review payloads for non-technical site owners.

## Development Notes

- Keep the runtime contract consumer-agnostic. Data Machine, Homeboy, Studio, wp-gym, and WordPress.com are consumers or mounted tools, not owners of the core artifact contract.
- Prefer small seams: runtime lifecycle, command handlers, artifact capture, recipes, WordPress integration, and apply-back should stay separate.
- When adding a new command or artifact type, update this README and `npm run check`.
