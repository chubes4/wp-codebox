# WP Codebox

WP Codebox runs disposable WordPress Playground sandboxes, executes bounded work inside them, and saves replayable artifacts before the sandbox is destroyed. It runs WordPress inside the sandbox, but the host that calls it can be anything: a CLI script, CI job, Node app, WordPress plugin, Data Machine flow, Homeboy workflow, or another control plane.

It is the runtime boundary for agent-built or workflow-built outputs. It is not the agent framework, the review UI, the deploy system, or the production site mutator. The WordPress plugin in this repo is an optional host adapter that exposes WP Codebox through WordPress abilities; the core CLI/runtime works without installing that plugin on a parent site.

```text
Any host: CLI, CI, Node app, WordPress plugin, Data Machine, Homeboy, Studio
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

## Why A WordPress Plugin?

The WordPress plugin is useful when the host experience should live inside a
WordPress site. It turns WP Codebox into a WordPress-native control plane for
reviewed coding workflows without asking users to run a terminal.

Good fits include:

- Letting non-technical site owners request, review, and approve bounded coding changes from a WordPress UI or chat surface.
- Running a managed coding community where users submit tasks and maintainers approve sandboxed artifacts before anything reaches real code.
- Supporting WordPress contributors with disposable reproduction, patch, review, and test-result artifacts that can be shared before commit or PR creation.

These are host-product use cases. The core runtime still works anywhere the CLI
can run.

## Repo Components

These are local workspace components in this repo. The CLI and WordPress plugin
now have package artifact validation, but publication and release automation are
still explicit release-manager steps.

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

## Distribution Artifacts

The CLI package is prepared as `@chubes4/wp-codebox-cli` and exposes the
`wp-codebox` binary from `packages/cli/dist/index.js`.

```bash
npm run build
npm pack --workspace @chubes4/wp-codebox-cli --dry-run --json
```

The WordPress plugin zip is built from `packages/wordpress-plugin` with only the
installable plugin files under a top-level `wp-codebox/` directory.

```bash
npm run package:wordpress-plugin
unzip -Z1 packages/wordpress-plugin/dist/wp-codebox.zip
```

`npm run package-distribution-smoke` validates both artifact shapes. It checks
that the CLI pack includes `package.json`, `README.md`, and compiled `dist/`
files without TypeScript source, then builds the WordPress plugin zip and checks
that it contains the plugin bootstrap, README, and PHP sources without package
metadata or generated artifacts.

Release checklist:

1. Run `npm run check` from a clean checkout.
2. Review `npm pack --workspace @chubes4/wp-codebox-cli --dry-run --json` before publishing the CLI package.
3. Build `packages/wordpress-plugin/dist/wp-codebox.zip` with `npm run package:wordpress-plugin` and inspect `unzip -Z1 packages/wordpress-plugin/dist/wp-codebox.zip`.
4. Install the CLI in the target environment and configure the WordPress plugin `wp_codebox_bin` option or filter to the resolved `wp-codebox` binary path.
5. Install the plugin zip on the parent site and run the WordPress plugin smoke or equivalent ability registration check in that environment.

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
    "id": "artifact-bundle-sha256-...",
    "contentDigest": "...",
    "directory": "./artifacts/runtime-...",
    "manifestPath": "./artifacts/runtime-.../manifest.json",
    "blueprintAfterPath": "./artifacts/runtime-.../blueprint.after.json",
    "capturedMountsPath": "./artifacts/runtime-.../files/mounted-files.json",
    "diffsPath": "./artifacts/runtime-.../files/diffs.json",
    "changedFilesPath": "./artifacts/runtime-.../files/changed-files.json",
    "patchPath": "./artifacts/runtime-.../files/patch.diff",
    "testResultsPath": "./artifacts/runtime-.../files/test-results.json"
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

### `bench-run`

Run plugin `tests/bench/*.php` workloads in a disposable WP Codebox runtime and emit the Homeboy-compatible `BenchResults` envelope.

```bash
npm run wp-codebox -- bench-run \
  --component ./examples/bench-plugin \
  --component-id bench-plugin \
  --iterations 3 \
  --json
```

Each workload file returns a callable. The callable may return numeric metrics directly or a payload with `metrics` and `metadata` keys. The command reports duration percentiles, custom metric aggregates, peak memory, runtime artifacts, and the parsed `benchResults` object in JSON output.

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

`--code` and `--code-file` still exist on the CLI for operator/debug use after the agent stack boots. They are not accepted by the parent-site `wp-codebox/run-agent-task` ability.

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

- `manifest.json`: artifact index with content types and the content digest used for the bundle id.
- `metadata.json`: runtime, policy, mounts, and caller metadata.
- `blueprint.after.json`: partial WordPress Playground replay blueprint for captured text files.
- `blueprint.after-notes.json`: replay limitations and next capture targets.
- `events.jsonl`, `commands.jsonl`, `observations.jsonl`: runtime evidence streams.
- `logs/runtime.log`, `logs/commands.log`: human-readable logs.
- `files/mounts.json`: mounted input list.
- `files/mounted-files.json`: captured readwrite mount files with size, SHA-256, target path, and replayability metadata.
- `files/changed-files.json`: canonical changed-files manifest for review and apply-back consumers.
- `files/patch.diff`: canonical combined text patch for changed readwrite mounts that declare a baseline.
- `files/test-results.json`: normalized test-results artifact with schema, summary counts, suites, and raw log references. When WP Codebox has not run test-aware commands, the artifact is present with `status: "unknown"`, zero counts, an empty `suites` array, and pointers to raw command logs instead of inferred pass/fail data.
- `files/review.json`: frontend-oriented review payload with summary, progress labels, changed file labels, evidence links, and approval actions.
- `files/diffs.json`: diff index for readwrite mounts that declare a baseline.
- `files/diffs/<mount>.patch`: unified text diff from a seeded baseline to the sandbox output.
- `files/mounts/<index>/...`: copied file contents from readwrite mounts.

`metadata.json` points to the canonical changed-files, patch, test-results, review, and mount-diff artifact paths under `artifacts`. It also includes `provenance` derived from data WP Codebox already has: task input/context where available, WP Codebox runtime version, WordPress version, mounted component/mount metadata, and agent/provider/model fields passed to the sandbox runner. `files/diffs/<mount>.patch` remains available for per-mount detail; `files/patch.diff` is the combined review/apply-back patch surface.

### `files/test-results.json`

`files/test-results.json` is the normalized contract for future test-aware commands. The artifact exists even when no command produced structured test output, so artifact consumers can read one stable path and treat `status: "unknown"` as "no structured test result was captured."

```json
{
  "schema": "wp-codebox/test-results/v1",
  "status": "unknown",
  "summary": { "total": 0, "passed": 0, "failed": 0, "skipped": 0, "unknown": 0 },
  "suites": [],
  "rawLogReferences": [
    { "path": "commands.jsonl", "kind": "commands-jsonl" },
    { "path": "logs/commands.log", "kind": "commands-log" }
  ]
}
```

Artifact bundle ids are content-addressed for the apply-back contract. The runtime writes `manifest.id` as `artifact-bundle-sha256-<digest>`, where `<digest>` is SHA-256 over the exact bytes of `files/changed-files.json` and `files/patch.diff` with the `wp-codebox/artifact-content/v1` domain separator. The same value is exposed as `manifest.contentDigest.value`, `metadata.contentDigest.value`, the CLI `artifacts.contentDigest` field, and `files/review.json` evidence. Approval and apply-back consumers must recompute it before trusting an approved artifact.

### `files/review.json`

`files/review.json` is the frontend contract for chat and owner review flows. It is derived from canonical artifacts and should be safe for a generic frontend to render without parsing unified diffs.

```json
{
  "schema": "wp-codebox/artifact-review/v1",
  "artifactId": "artifact-bundle-...",
  "provenance": {
    "task": { "kind": "agent-sandbox-run", "input": "Add a Dry Rub filter..." },
    "runtime": {
      "backend": "wordpress-playground",
      "version": "0.0.0",
      "wordpressVersion": "7.0"
    },
    "agent": { "agent": "sandbox-agent", "provider": "openai", "model": "gpt-5.5" },
    "mounts": [
      {
        "type": "directory",
        "source": "/path/to/data-machine-code",
        "target": "/wordpress/wp-content/plugins/data-machine-code",
        "mode": "readonly",
        "metadata": { "kind": "component", "slug": "data-machine-code" }
      }
    ]
  },
  "summary": "Sandbox produced changes in 1 file.",
  "stats": { "added": 1, "modified": 0, "deleted": 0, "total": 1 },
  "changedFiles": [
    {
      "path": "/wordpress/wp-content/plugins/example/generated.txt",
      "status": "added",
      "label": "added generated.txt",
      "mountTarget": "/wordpress/wp-content/plugins/example",
      "relativePath": "generated.txt"
    }
  ],
  "progress": [
    { "type": "boot", "label": "Spinning up a test copy of your site..." },
    { "type": "artifact", "label": "Saving the result for review..." },
    { "type": "complete", "label": "Ready for your review." }
  ],
  "actions": [
    { "kind": "approve", "label": "Approve all changes", "requiresApprovedFiles": true },
    { "kind": "approve-files", "label": "Approve selected files", "requiresApprovedFiles": true },
    { "kind": "discard", "label": "Discard changes" },
    { "kind": "iterate", "label": "Request changes" }
  ],
  "evidence": {
    "patch": "files/patch.diff",
    "patchSha256": "...",
    "artifactContentDigest": "...",
    "changedFiles": "files/changed-files.json",
    "testResults": "files/test-results.json"
  },
  "riskFlags": []
}
```

Review actions are declarative. Frontends call `wp-codebox/apply-approved-artifact` with `artifact_id` and an explicit `approved_files[]` list for approve actions, call `wp-codebox/discard-artifact` for discard, and start a new sandbox task for iterate/request-changes flows.

Binary files and oversized files are copied when allowed by capture limits but are not embedded into `blueprint.after.json`. Database exports, option diffs, uploaded media, active plugin/theme state, screenshots, parsed test command output, and redaction guarantees are still future artifact targets.

## WordPress Plugin

The WordPress plugin registers parent-site abilities:

- `wp-codebox/run-agent-task`
- `wp-codebox/run-agent-task-batch`
- `wp-codebox/list-artifacts`
- `wp-codebox/get-artifact`
- `wp-codebox/discard-artifact`
- `wp-codebox/apply-approved-artifact`
- `wp-codebox/stage-artifact-apply`

These abilities shell out to the local `wp-codebox` CLI, boot disposable Playground sandboxes, mount the configured agent stack, invoke the sandbox agent through `agents/chat`, and return artifact metadata.

`wp-codebox/run-agent-task` accepts the stable task input contract below. Existing callers that still send `task` as a string are normalized to the same shape with `goal` populated from `task`. It rejects raw `code` and `code_file` fields so frontend/chat callers cannot pass arbitrary PHP through the product ability path. Operators can still use CLI debug commands directly when they need raw PHP probes.

```json
{
  "schema": "wp-codebox/task-input/v1",
  "goal": "Add a focused product feature and return a reviewable patch.",
  "target": {
    "kind": "plugin",
    "path": "wp-content/plugins/example"
  },
  "allowed_tools": ["workspace.read", "workspace.write", "tests.run"],
  "expected_artifacts": ["patch", "tests", "review"],
  "policy": {
    "applyBack": "reviewed"
  },
  "context": {
    "issue": "https://github.com/chubes4/wp-codebox/issues/29"
  }
}
```

`target.kind` is caller-defined but should use `repo`, `site`, `plugin`, or `theme` when possible. `allowed_tools` and `expected_artifacts` are advisory contract fields for the product caller and sandboxed agent loop; the host runner still decides the private CLI invocation and returns the normalized `task_input` alongside the string `task` it passed into the current CLI bridge.

Component paths can come from ability input, the `wp_codebox_component_paths` option, or the `wp_codebox_component_paths` filter.

Expected component keys:

- `agents_api`
- `data_machine`
- `data_machine_code`
- `provider_plugins` (optional list)

The CLI binary can come from ability input, the `wp_codebox_bin` option, or the `wp_codebox_bin` filter.

Data Machine Code is a mounted coding-tools component inside the sandbox. It provides workspace/file/GitHub tools to the sandboxed agent. WP Codebox owns the parent-site ability surface, sandbox lifecycle, and artifact capture boundary.

Apply-back is intentionally not part of `run-agent-task`. Sandbox execution returns proposed outputs and evidence. `list-artifacts`, `get-artifact`, and `discard-artifact` manage captured artifact bundles under the configured artifact root. `apply-approved-artifact` validates `artifact_id` plus an explicit `approved_files[]` list against canonical `changed-files.json`, recomputes the artifact content digest from `changed-files.json` and the exact `patch.diff` the reviewer approved, and delegates to the `wp_codebox_apply_approved_artifact` filter. PR creation, direct deploy, package export, and bot identity policy live in adapters behind that reviewed boundary.

When Data Machine is present, `stage-artifact-apply` stages that same apply input as a Data Machine pending action with kind `wp_codebox_apply_back`. Its preview includes `files/review.json`, canonical changed files, normalized test results, and the explicit approved file list. Accepting the pending action resolves through Data Machine's generic resolver and calls the existing `apply-approved-artifact` path; rejecting it leaves the artifact untouched. This keeps approval lifecycle in Data Machine without making WP Codebox depend on Homeboy or any site-specific apply adapter.

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

- Define redaction guarantees.
- Define multi-user sandbox session lifecycle, retention, quotas, cancellation, and audit records.
- Define reviewed apply-back adapters for bot-authored PRs, direct apply, and package export.
- Add visual previews, parsed test command output, and richer risk flags to frontend review payloads.

## Development Notes

- Keep the runtime contract consumer-agnostic. Data Machine, Homeboy, Studio, wp-gym, and WordPress.com are consumers or mounted tools, not owners of the core artifact contract.
- Prefer small seams: runtime lifecycle, command handlers, artifact capture, recipes, WordPress integration, and apply-back should stay separate.
- When adding a new command or artifact type, update this README and `npm run check`.
