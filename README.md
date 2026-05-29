# WP Codebox

**WP Codebox unlocks secure WordPress code execution from anywhere.** Run agents, accept untrusted patches, evaluate plugins, reproduce bugs, or experiment freely — every sandbox is a disposable WordPress Playground that can't touch its caller. Your host can be a CLI, CI job, mobile app, Node service, WordPress plugin, or anything else that can shell out or hit an API.

WordPress has historically lacked a clean scratch space for code execution. Modern dev workflows assume one — Node has `npm install` per project, Python has venvs, containers have ephemeral filesystems. WordPress Playground finally provides that primitive: real WordPress, PHP-in-WASM, fully ephemeral, no host filesystem access except via declared mounts. WP Codebox wraps Playground into a usable runtime contract so any product — WordPress or not — can offer code execution against a real WordPress instance without risking the caller.

WP Codebox is the runtime boundary for agent-built or workflow-built outputs. It is not the agent framework, the review UI, the deploy system, or the production site mutator. The WordPress plugin in this repo is one optional host adapter (useful when the host *is* a WordPress site); the core CLI/runtime works anywhere `node` can run.

For the durable architecture boundary, see [`docs/architecture.md`](./docs/architecture.md).

```text
Any host: CLI, CI, mobile, Node service, WP plugin, GitHub Action, ...
  -> WP Codebox
    -> disposable WordPress Playground sandbox
      -> mounted inputs, plugins, tools, and optional agent stack
      -> controlled commands or agent task
      -> artifact bundle
  -> review, replay, apply, export, or discard outside the sandbox
```

## Product Use Cases

What you can build on top of WP Codebox:

- **Agentic coding against a WordPress site.** Let users describe a change in chat — from any host: a WordPress plugin, a mobile app, a desktop tool, a Slack/Discord bot. Dispatch a sandbox with the target site's stack mounted, capture an artifact with a live Playground preview URL, then let the parent control plane review, apply, and open any PR. The contributor never needs shell access.
- **Agent training and evaluation.** Run the same WordPress task side by side across multiple models in isolated Playground workspaces. Capture each model's output, grade against hidden quality checks, and produce per-model PRs as review surface. See [wp-gym](https://github.com/Automattic/wp-gym).
- **Long-running terrariums.** Boot a Playground that an agent evolves over time — software, content, configuration — with day-cycle automation driven from CI. See [world-of-wordpress](https://github.com/chubes4/world-of-wordpress).
- **Static-site / WordPress-import factories.** Generate raw HTML/CSS sites in CI, validate them via Playground + WordPress import, post Playground preview links as PR evidence. See [wp-site-generator](https://github.com/chubes4/wp-site-generator).
- **Untrusted patch evaluation.** Plugin and theme authors can accept community-submitted patches, run them in a sandbox, capture artifacts (diffs, test results, screenshots), and review before merging. The reviewing tool can be anything.
- **"Try it in a sandbox first."** Before installing a plugin, theme, or update on a production site, run it in a disposable Playground and see what happens.
- **Reproduction harness for bug reports.** Ship a recipe with an issue so any contributor can replay the bug deterministically in a clean WordPress instance. The replay can be triggered from a CLI, a CI job, or a maintainer's IDE plugin.
- **Hosting provider integrations.** "Test this change in a sandbox" buttons in admin dashboards or hosting panels.
- **CI/CD safety net.** Dispatch a sandbox from a GitHub Action or other CI runner to evaluate a PR's runtime behavior against real WordPress before merging.
- **Mobile / native dev tools.** A mobile coding assistant or desktop dev tool can drive sandboxes for real WordPress execution without bundling PHP locally.
- **Education.** Real WordPress instances per student per exercise, fully disposable.
- **Security research.** Detonate suspicious plugins, themes, or patches in isolation.

## Runtime Capabilities

What WP Codebox provides for product use cases:

- Run a PHP or WP-CLI probe against mounted WordPress code.
- Validate raw WordPress Playground blueprints through the same runtime and artifact contract.
- Execute a WordPress Ability inside a disposable Playground runtime.
- Run repeatable workspace recipes that mount plugins, seed workspaces, and capture outputs.
- Drive stateful runtime episodes with reset, step, observe, snapshot, artifact, and close operations.
- Launch sandboxed Data Machine / Agents API coding-agent tasks from the CLI or WordPress ability surface.
- Fan out several task descriptions into separate isolated sandboxes.
- Produce artifact bundles — patches, diffs, test results, live Playground preview URLs — that a parent product can review, replay, apply, or discard.

## In-Sandbox Workspace Contract

WP Codebox reserves `/workspace` as the stable editable workspace root inside a
sandbox. Repo-backed tasks mount a repository at `/workspace` and preserve the
repository layout exactly, so `wing-map-display/blocks/map/render.php` in the
repo is `/workspace/wing-map-display/blocks/map/render.php` in the sandbox.
Site-backed tasks mount a site snapshot under the same root, normally with
`/workspace/wp-content/...` paths, and produce a changed-files bundle rather
than a git patch against a repo `HEAD`.

`wp-content` runtime mounts can coexist with `/workspace` mounts. A caller may
mount the same source into `/wordpress/wp-content/plugins/<slug>` so WordPress
loads it, and into `/workspace/<repo-relative-path>` so DMC tools edit it with
repo-relative paths. Artifact metadata records both mount targets and any opaque
mount metadata such as `repo`, `gitRef`, `default_branch`, `workspaceRef`,
`component`, `wpContentPath`, and `sourceMode`.

Artifact bundles include `metadata.json.provenance.workspace` with:

- `root`: always `/workspace` for the v1 contract.
- `defaultMode`: `repo-backed` unless a mount declares `sourceMode: site-backed`.
- `mounts`: normalized workspace mount refs for repo components and site
  snapshots.
- `dmc.safeAbilities`: the sandbox DMC ability allow-list.
- `dmc.parentOnlyAbilities`: DMC abilities reserved for the parent control plane.

Sandbox agents may read, write, edit, patch, grep, list, and diff files inside
the mounted workspace. Read-only GitHub abilities may be exposed for context.
Push, deploy, worktree lifecycle, GitSync, PR creation, issue mutation, comments,
merge, cleanup, and apply-back operations stay parent-only. The sandbox produces
artifacts; the parent site decides whether and how to apply them.

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

Versioning and release policy:

1. Release the workspace packages together from one git tag so
   `@chubes4/wp-codebox-cli`, `@chubes4/wp-codebox-core`, and
   `@chubes4/wp-codebox-playground` stay on the same version.
2. Keep `packages/wordpress-plugin/wp-codebox.php` `Version:` aligned with the
   package version used for the matching plugin zip.
3. Treat the npm package and plugin zip as one release unit: publish the CLI,
   build the plugin zip from the same commit, and attach the zip to the release.
4. Use conventional semver: patch for fixes and docs-only distribution updates,
   minor for new commands or artifact fields, major for runtime contract breaks.

Install notes by environment:

1. Self-hosted WordPress control planes should install the CLI on the same host
   that runs PHP, install `packages/wordpress-plugin/dist/wp-codebox.zip` as the
   parent-site plugin, then set `wp_codebox_bin` to the resolved `wp-codebox`
   binary path. Component paths can be supplied through
   `wp_codebox_component_paths` or the matching filter.
2. Studio or local development environments can run from a checkout with
   `npm install`, `npm run build`, and `npm run wp-codebox -- ...`; install the
   plugin zip into the local parent site and point `wp_codebox_bin` at either
   the global binary or the checkout wrapper command used by that site.
3. Hosted control planes should provide WP Codebox as managed infrastructure:
   deploy the vetted CLI package and plugin zip from the same release, configure
   the binary and component paths centrally with options or filters, and expose
   only the parent-site abilities to products.

CLI binary discovery from the plugin is intentionally host-configurable. The
runner resolves the binary from ability input first, then `wp_codebox_bin`, then
the `wp_codebox_bin` filter; multisite installs read the option from network
options because the executable path is host-level configuration.

Release checklist:

1. Run `npm run check` from a clean checkout.
2. Review `npm pack --workspace @chubes4/wp-codebox-cli --dry-run --json` before publishing the CLI package.
3. Build `packages/wordpress-plugin/dist/wp-codebox.zip` with `npm run package:wordpress-plugin` and inspect `unzip -Z1 packages/wordpress-plugin/dist/wp-codebox.zip`.
4. Confirm package and plugin versions are aligned on the release commit.
5. Install the CLI in the target environment and configure the WordPress plugin `wp_codebox_bin` option or filter to the resolved `wp-codebox` binary path.
6. Install the plugin zip on the parent site and run the WordPress plugin smoke or equivalent ability registration check in that environment.

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

## Runtime Evidence

Recipe runs write runtime evidence under `files/runtime-evidence/`. Every recipe
run includes `run-attestation.json`, a generic attestation with the WP Codebox
package identity, git commit when available, Playground backend package/version,
WordPress runtime version, command-policy hash, policy enforcement states,
references to workspace-policy and artifact-verifier results when configured,
and redacted secret-envelope metadata.

The attestation treats runtime command, network, filesystem, secrets, and
approval policies as sealed because WP Codebox enforces them while executing the
run. Workspace policy and artifact verification are sealed only when their
recipe options are enabled with `strict: true`; when enabled without strict mode,
their result artifacts are recorded as advisory/declarative evidence. Secret
values are never written to the attestation; it records only names, counts,
availability, and the redaction mode.

Workspace policy evidence rejects symlinks, special files, nested `.git`
metadata, hidden-policy paths, paths outside writable roots, gitlinks,
unmerged-index entries, ignored files in git-backed mode, and regular files with
more than one hard link. The hard-link check uses the host platform's
`lstat().nlink` value and fails closed if the link count cannot be determined,
because a hard-linked file under an allowed root is not independent evidence.

For interactive review, pass `--preview-hold <duration>` to keep the live Playground server available briefly after artifact capture. The command emits `artifacts.preview.url` and `files/review.json` includes a matching top-level `preview` object with lifecycle and expiry details.

```bash
npm run wp-codebox -- run \
  --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin \
  --command wordpress.run-php \
  --arg code-file=./examples/simple-plugin/probe.php \
  --artifacts ./artifacts \
  --preview-hold 15m \
  --json
```

The v1 preview is a held live Playground runtime. When `--preview-hold` is omitted, the preview field still records the URL observed during capture, but the runtime is destroyed on command completion and the URL is marked `expired-on-completion`. Artifact replay from `blueprint.after.json` remains partial and is a separate future preview mode.

For tunnel-first review, reserve the local port in the tunnel command and pass that same port to WP Codebox. `--preview-port <n>` makes WP Codebox expose Playground through a fixed local proxy port instead of reporting Playground's default random port, and `--preview-public-url <url>` reports the tunnel URL in `artifacts.preview.url`, `metadata.json`, and `files/review.json`.

```bash
kimaki tunnel -- sh -c 'npm run wp-codebox -- run \
  --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin \
  --command wordpress.run-php \
  --arg code-file=./examples/simple-plugin/probe.php \
  --artifacts ./artifacts \
  --preview-hold 15m \
  --preview-port 4173 \
  --preview-public-url "$TRAFORO_URL" \
  --json'
```

When a caller exposes the local Playground through a tunnel or proxy, pass `--preview-public-url <url>` to report that public URL in `artifacts.preview.url`, `metadata.json`, and `files/review.json`. WP Codebox also passes the same URL to Playground as `site-url` and defines `WP_HOME` / `WP_SITEURL` in the sandbox config, so WordPress-generated links and canonical redirects align with the public preview URL. The local proxy URL remains recorded as `preview.localUrl`. If the fixed port is already occupied, WP Codebox fails clearly with `EADDRINUSE` and the requested `--preview-port` value.

Remote-host previews can opt into `--preview-bind <host>` with `--preview-port`. The flag changes the WP Codebox preview proxy bind address only; the upstream Playground server remains loopback-bound because `@wp-playground/cli` does not expose host/bind control yet. The default stays `127.0.0.1`. Use `--preview-bind 0.0.0.0` only behind trusted firewall, tunnel, or reverse-proxy controls because the sandbox preview is reachable for the hold duration. Track the upstream Playground bind-host API gap in https://github.com/WordPress/wordpress-playground/issues/3681.

## Runtime Episodes

Use `createRuntimeEpisode()` when a caller needs a stateful sandbox loop instead
of a one-shot command or recipe. The episode wrapper is generic: it records reset
observations, step executions, optional per-step observations, snapshots, and
artifact bundles without knowing benchmark, reward, or scenario semantics.

```ts
import { createRuntimeEpisode } from "@chubes4/wp-codebox-core"
import { createPlaygroundRuntimeBackend } from "@chubes4/wp-codebox-playground"

const episode = await createRuntimeEpisode(
  {
    runtime: {
      backend: "wordpress-playground",
      environment: { kind: "wordpress", version: "7.0", blueprint: { steps: [] } },
      policy: {
        network: "deny",
        filesystem: "readwrite-mounts",
        commands: ["wordpress.wp-cli", "wordpress.run-php"],
        secrets: "none",
        approvals: "never",
      },
    },
    stepObservation: { type: "runtime-info" },
  },
  createPlaygroundRuntimeBackend(),
)

await episode.step({ command: "wordpress.wp-cli", args: ["command=post list"] })
const artifacts = await episode.collectArtifacts({ includeLogs: true })
const trace = await episode.trace()
await episode.close()
```

When `collectArtifacts()` runs for an episode, WP Codebox persists the trace into
the artifact bundle at `files/runtime-episode-trace.json` and writes a compact
stream form to `files/runtime-episode.jsonl`. The bundle manifest advertises
those files with `runtime-episode-trace` and `runtime-episode-events` kinds,
`metadata.json` lists them under `artifacts.runtimeEpisodeTrace` and
`artifacts.runtimeEpisodeEvents`, and `files/review.json` includes
`evidence.runtimeEpisodeTrace` for review tooling. `verifyArtifactBundle()`
checks the advertised trace file exists and validates against
`wp-codebox/runtime-episode-trace/v1`.

Artifact bundles also include `files/runtime-reference-manifest.json` using
schema `wp-codebox/runtime-reference-manifest/v1`. This manifest is a stable,
hashable index of runtime-related refs: the artifact-bundle id/digest,
bundle-relative artifact file refs with SHA-256 values, optional trace/events
refs, and snapshot refs. Its id is `runtime-reference-manifest-sha256-<digest>`,
where the digest is computed from the declared refs rather than presentation
fields such as `createdAt`. `verifyArtifactBundle()` validates the manifest
shape, referenced file hashes, artifact-bundle digest, and id/digest pairing.

Products such as eval harnesses can project this generic episode trace into their
own action, observation, reward, and report schemas outside WP Codebox.

The episode trace is a versioned machine-verifiable contract with schema
`wp-codebox/runtime-episode-trace/v1`. `@chubes4/wp-codebox-core` exports
`RUNTIME_EPISODE_TRACE_JSON_SCHEMA` for schema-aware consumers and
`validateRuntimeEpisodeTrace()` for lightweight runtime checks. The trace stays
generic: it carries runtime, reset, step, action, execution, observation,
snapshot, and artifact references only. Domain fields such as reward, grader,
scenario, benchmark, task-set, and model-eval belong in consumers that project
the trace into their own schemas.

Episode steps include stable ids and refs for the step, requested action,
runtime execution, optional observation, and collected artifact bundle. Actions
use the generic `wp-codebox/runtime-episode-action/v1` envelope with
`kind: "command" | "filesystem" | "http" | "browser"`, the underlying command
execution name, string args, optional replay intent fields such as `method`,
`url`, `path`, `operation`, `selector`, and a SHA-256 digest over that canonical
payload. Non-command action kinds preserve higher-level runtime intent while the
command execution remains the compatibility primitive.

Observations use the generic `wp-codebox/runtime-episode-observation/v1`
envelope with id, type, data, timestamp, optional artifact refs, and digest. The
Playground backend provides structured observation types for `runtime-info`,
`mounts`, `command-result`, `wordpress-state`, `http-response`,
`browser-result`, `runtime-events`, and `runtime-logs`. Large observation
payloads can be stored as bundle-relative artifacts and referenced by digest.
Refs carry matching digests so callers can compare action args, observations,
executions, snapshots, and artifacts without parsing presentation logs.

Replay is bounded to the generic runtime contract. A consumer can replay a step
by creating a compatible backend runtime, applying the same mounts/artifact
inputs, and executing the action envelope in order. WP Codebox intentionally
does not record rewards, scenario ids, benchmark metadata, model-eval fields, or
product-specific success semantics; those belong to the caller's projection of
the trace. Backend behavior still matters: command availability, WordPress
version, installed packages, mounted files, network policy, and secrets policy
must be reproduced by the replay harness.

Runtime snapshots are explicit about their semantics. The current Playground
backend returns `semantics: "metadata-only"`, which records runtime and mount
metadata for audit context but is not a full replayable WordPress state image.
These snapshots are trace markers, not database or filesystem checkpoints. Call
`collectArtifacts()` when the caller needs replay inputs, changed files, patches,
logs, observations, and artifact bundle refs. Future backends may emit stronger
snapshot semantics such as runtime-state artifacts, but replay consumers should
branch on the snapshot `semantics` field instead of assuming a portable restore
point.

The runtime reference manifest repeats each snapshot's `semantics` and adds an
explicit `replay.status`. For current Playground snapshots that status is
`metadata-only` with limitations explaining that replay must come from trace
actions and artifact files. This keeps full WordPress replay as an incremental
backend capability while giving consumers a concrete contract today.

## CLI Commands

### `commands`

Discover the supported runtime and recipe commands without launching Playground.

```bash
npm run wp-codebox -- commands --json
```

JSON output uses `wp-codebox/command-catalog/v1` and includes each command id, description, accepted args, known output shape, and runtime policy requirement. Human output is a concise command list.

### `schema recipe`

Print the JSON Schema for `wp-codebox/workspace-recipe/v1` without reading a recipe or launching Playground.
The canonical schema source is `createWorkspaceRecipeJsonSchema()` in `@chubes4/wp-codebox-core`, next to the `WorkspaceRecipe` TypeScript contract; the CLI injects its current recipe command ids into that shared schema factory.

```bash
npm run wp-codebox -- schema recipe --json
```

The schema covers `runtime`, `inputs.mounts`, `inputs.workspaces`, `inputs.extra_plugins` / `inputs.extraPlugins`, `inputs.secretEnv`, `workflow.steps`, and `artifacts`.

### `run`

Run one command in a disposable runtime.

```bash
npm run wp-codebox -- run \
  --mount <host-path>:<sandbox-path>[:readonly|readwrite] \
  --command <command> \
  --arg <key=value> \
  --preview-port <local-port> \
  --preview-bind 127.0.0.1 \
  --preview-public-url <public-tunnel-url> \
  --json
```

Supported runtime commands today:

- `inspect-mounted-inputs`: list mounted input entries from inside Playground.
- `wordpress.run-php`: run PHP; accepts `code=<php>` or `code-file=<path>`.
- `wordpress.wp-cli`: run WP-CLI; accepts `command='wp option get home'` or plain args.
- `wordpress.ability`: execute a registered WordPress Ability; accepts `name=<ability>` and optional JSON `input=<object>`.
- `wordpress.browser-probe`: boot the live preview, visit `url=<path-or-url>` with Playwright, and capture generic browser replay/audit evidence under `files/browser/`.

`wordpress.run-php` loads `/wordpress/wp-load.php` by default. Use `--arg bootstrap=none` for raw PHP.

`wordpress.wp-cli` automatically enables Playground's `wp-cli` extra library when the command is allowed by runtime policy.

`wordpress.browser-probe` accepts `wait-for=domcontentloaded|load|networkidle|selector:<selector>|duration`, `duration=<n>s`, and `capture=console,errors,html,network,screenshot`. It records machine-readable evidence refs such as `files/browser/console.jsonl`, `files/browser/errors.jsonl`, `files/browser/network.jsonl`, `files/browser/snapshot.html`, `files/browser/screenshot.png`, and `files/browser/summary.json` when those captures are enabled. The summary includes requested/final URLs, viewport/device metadata, HTML and screenshot hashes, network event counts, and a generic `artifact-backed|partial|diagnostic-only` replayability classification. WP Codebox intentionally keeps these browser evidence fields generic; consumers such as eval harnesses may interpret them without WP Codebox adding scoring, grading, or benchmark semantics.

WP Codebox defaults to WordPress `7.0` because the agent and AI plugin stacks need the modern WordPress AI surface. Override with `--wp trunk`, `--wp nightly`, or another supported Playground version.

`--preview-port` fixes the local WP Codebox proxy port for tunnel/proxy wiring. Omit it to keep the current random-port behavior from upstream Playground. `--preview-bind` changes that fixed-port proxy bind address and requires `--preview-port`; it does not change the upstream Playground server bind. `--preview-public-url` is metadata and site-url alignment only; it does not make a loopback-only preview reachable without a tunnel/proxy or explicit proxy bind.

### `boot`

Boot a disposable Playground runtime for interactive sandbox review without running a workflow step.

```bash
npm run wp-codebox -- boot \
  --mount <host-path>:<sandbox-path>[:readonly|readwrite] \
  --blueprint ./playground-blueprint.json \
  --artifacts ./artifacts \
  --hold 15m \
  --preview-port 4173 \
  --preview-public-url https://example-tunnel.test/ \
  --json
```

`boot` accepts the same mount, WordPress version, policy, artifact, fixed preview port, and public preview URL setup used by the runtime commands. `--blueprint` accepts inline JSON or a path to a Playground blueprint JSON file. `--hold` uses the same duration syntax and 3600-second maximum as `run --preview-hold`.

The JSON output uses `wp-codebox/boot/v1` and includes runtime information plus the collected artifact bundle. The artifact bundle includes preview metadata, mounted-file capture, diffs, review metadata, and lifecycle logs, but no `execution` object and no fake command entry.

### `validate-blueprint`

Validate a raw WordPress Playground blueprint through WP Codebox instead of calling `@wp-playground/cli` directly.

```bash
npm run wp-codebox -- validate-blueprint \
  --blueprint ./playground-blueprint.json \
  --wp 7.0 \
  --artifacts ./artifacts \
  --json
```

`--blueprint` accepts inline JSON or a path to a Playground blueprint JSON file. The command boots Playground with that blueprint, captures the normal artifact bundle, and returns `wp-codebox/blueprint-validation/v1` with runtime and artifact paths. Use it in CI when the desired contract is "this blueprint boots and produces reviewable WP Codebox artifacts" rather than a recipe workflow.

### `recipe validate`

Validate a workspace recipe without launching Playground.

```bash
npm run wp-codebox -- recipe validate \
  --recipe ./examples/recipes/simple-plugin.json \
  --json
```

Validation checks schema, source paths, extra plugin entrypoints, workspace seeds, supported workflow commands, JSON ability inputs, and command arguments.

Use `recipe validate` when you only need a pass/fail contract for authoring or CI. It does not resolve the execution plan beyond validation summaries.

### `recipe-run`

Run a repeatable recipe.

```bash
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/simple-plugin.json \
  --preview-hold 15m \
  --preview-port 4173 \
  --preview-public-url https://example-tunnel.test/ \
  --json
```

Recipes are JSON declarations for a sandbox setup plus workflow steps. They can mount existing directories, create disposable plugin/theme workspaces, activate extra plugins, allow-list selected secret environment variable names, and capture the output as artifacts.

Pass `--dry-run --json` to validate the same recipe and emit the resolved plan without booting Playground, creating temp workspaces, mounting files, executing commands, or writing artifacts:

```bash
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/simple-plugin.json \
  --dry-run \
  --json
```

Dry-run output uses `wp-codebox/recipe-run-dry-run/v1` and includes resolved mounts, planned workspaces, extra plugins, workflow steps with parsed and resolved command args, allowed secret environment variable names without values, and per-step policy status. Use `recipe-run` without `--dry-run` when you want the real Playground-backed execution and artifact bundle.

`inputs.extra_plugins` accepts existing local plugin directory paths and external HTTPS zip sources. Local paths keep the existing behavior: they are resolved relative to the recipe file and mounted read-only under `/wordpress/wp-content/plugins/<slug>`.

Set `loadAs` to `mu-plugin` for runtime substrate that should load as must-use infrastructure instead of appearing as a normal user-managed plugin. WP Codebox mounts those plugins under `/wordpress/wp-content/mu-plugins/wp-codebox-runtime/<slug>` and writes a `wp-codebox-runtime-loader.php` setup loader. Use this for sandbox/runtime plumbing such as Agents API, Data Machine, Data Machine Code, and AI provider bridges. Leave user-visible site plugins as the default `plugin` load mode.

External sources are explicit and CI-safe. WP Codebox validates URL-shaped sources before Playground boots, but it downloads them only when `WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS=1` is set. Supported first-slice forms are WordPress.org plugin zip URLs and generic HTTPS `.zip` URLs:

```json
{
  "inputs": {
    "extraPlugins": [
      {
        "source": "https://downloads.wordpress.org/plugin/bbpress.latest-stable.zip",
        "pluginFile": "bbpress/bbpress.php",
        "activate": false
      },
      {
        "source": "https://example.com/acme-helper.zip",
        "slug": "acme-helper",
        "pluginFile": "acme-helper/acme-helper.php"
      },
      {
        "source": "../agents-api",
        "slug": "agents-api",
        "pluginFile": "agents-api/agents-api.php",
        "activate": false,
        "loadAs": "mu-plugin"
      }
    ]
  }
}
```

WordPress.org plugin zip URLs infer the plugin slug from the zip filename. Generic HTTPS zip sources require `slug` so the sandbox mount target is deterministic. Dry-run plans and artifact provenance record the original source reference, resolved URL, source kind, and SHA-256 digest when a download occurs; temporary download paths are reported by category rather than as durable host paths.

`inputs.siteSeeds` supports bounded sandbox setup data before workflow steps run. Local `fixture` seeds import JSON objects with scoped `posts`, `terms`, `options`, anonymized `users`, media metadata, `activePlugins`, and `activeTheme`. Every record scope must be explicit through selectors and/or `maxRecords`; option scopes require a `names` allow-list; parent-site users are anonymized; media file bytes are not replayed.

The WordPress host ability also accepts `site_seeds` entries with `type: "parent_site"`. That path is opt-in: the host exports only the requested current-site scopes into a temporary JSON fixture, invokes `recipe-run`, then deletes the fixture. This is a bounded seed substrate, not a full migration engine. It does not replay full database state, comments, revisions, arbitrary meta, uploads, secrets, or source-site filesystem state.

Reprint remains a future backend candidate for full/essential parent-site snapshots. WP Codebox does not vendor or shell out to Reprint for bounded `siteSeeds` yet because Reprint is a site-scale migration engine, while this contract needs explicit per-scope limits and privacy defaults.

Mount entries may include opaque `metadata` that is preserved in runtime observations, artifact provenance, and captured mount files. Product-specific callers can use this to map sandbox paths back to source repositories without WP Codebox knowing about the caller's deployment environment:

```json
{
  "source": "/srv/site/wp-content/plugins/example",
  "target": "/wordpress/wp-content/plugins/example",
  "mode": "readwrite",
  "metadata": {
    "kind": "component",
    "slug": "example-plugin",
    "repo": "org/example-plugin",
    "default_branch": "main",
    "repo_root_relative_to_mount": ".",
    "editable": true
  }
}
```

Example recipes:

- `examples/recipes/simple-plugin.json`: mount and probe the fixture plugin.
- `examples/recipes/wp-cli.json`: prove WP-CLI commands mutate the same runtime observed by later steps.
- `examples/recipes/seeded-plugin-workspace.json`: create a disposable plugin scaffold, mutate it, and capture diffs.
- `examples/recipes/datamachine-agent-bundle.json`: mount Agents API and Data Machine, then import a bundle through `wordpress.ability`.
- `examples/recipes/cookbook/multisite-network.json`: convert Playground to multisite, mount a plugin under test, seed two child sites, and emit network/site/admin URLs.
- `examples/recipes/cookbook/woocommerce-store.json`: realistic WooCommerce dependency shape with seeded store pages, products, customer, and order fixtures.
- `examples/recipes/cookbook/theme-block-editor.json`: realistic theme/block-editor smoke surface with a mounted theme, seeded block page, and frontend/editor/admin URLs.
- `examples/recipes/cookbook/seeded-content.json`: realistic fixture content shape with pages, posts, categories, tags, editor/author users, and preview/admin URLs.
- `examples/recipes/cookbook/bbpress-reply-editor.json`: realistic bbPress dependency shape with a seeded forum/topic and reply form.

Supported workspace seeds:

- `plugin_scaffold`: creates `<slug>.php` and `README.md`, mounted by default at `/wordpress/wp-content/plugins/<slug>`.
- `theme_scaffold`: creates `style.css`, `index.php`, and `README.md`, mounted by default at `/wordpress/wp-content/themes/<slug>`.
- `directory`: copies `seed.source` into a disposable workspace and requires an explicit sandbox `target`.

### Bench Recipes

Run `wordpress.bench` from a recipe workflow to execute plugin `tests/bench/*.php` workloads in a disposable WP Codebox runtime and emit the Homeboy-compatible `BenchResults` envelope.

```bash
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/bench-plugin.json \
  --json
```

Each workload file returns a callable. The callable may return numeric metrics directly or a payload with `metrics` and `metadata` keys. The recipe output reports duration percentiles, custom metric aggregates, peak memory, runtime artifacts, and the parsed `benchResults` object in JSON output when a single `wordpress.bench` step runs.

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
- `--secret-env <NAME>`: expose a parent process environment variable by name, such as `--secret-env GITHUB_TOKEN`. Repeatable. Values are read from the process environment and are not accepted in JSON payloads.
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
- `files/runtime-reference-manifest.json`: stable runtime ref index with artifact-bundle, file, trace/events, and snapshot refs plus SHA-256 digests.
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

Every `manifest.files[]` entry also carries `sha256: { "algorithm": "sha256", "value": "..." }`. For regular files, `value` is the SHA-256 of that artifact file's bytes. For `manifest.json`, `value` is a canonical self-hash over the parsed manifest with the manifest entry's own hash replaced by 64 zeroes, using the `wp-codebox/artifact-manifest-self/v1` domain separator. `wp-codebox artifacts verify` rejects missing hashes and mismatched hashes for any declared file, so tampering with replay-critical or supporting artifacts is detected even when the top-level content digest inputs are unchanged.

`wp-codebox artifacts verify` also fails closed on unsafe bundle topology: all
declared file paths must be bundle-relative, non-duplicated, traversal-free,
listed in `manifest.files[]` when used as digest inputs or evidence refs, and
present as regular files under the bundle directory. Symlinks, special files, and
regular files with multiple hard links are rejected so downstream consumers do
not trust artifact evidence that may alias protected content outside the bundle.

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

Canonical agent-task execution paths are intentionally split by caller runtime:

- Server/host execution uses `wp-codebox/run-agent-task` or `wp-codebox/run-agent-task-batch`. These abilities shell out to local `wp-codebox recipe-run`, boot disposable Playground sandboxes, mount the configured agent stack, invoke the sandbox agent through `agents/chat`, and return artifact metadata.
- Portable CLI execution uses `wp-codebox recipe-run --recipe <path>`. Recipes use the `wp-codebox.agent-sandbox-run` helper step when they need the agent-task bridge; direct `agent-sandbox-run` remains an operator/debug command, not the product API for frontend callers.
- No-Node/browser execution uses `wp-codebox/create-browser-playground-session`. The host prepares a browser-executable Playground recipe and runner payload; the browser executes `wordpress.run-php` inside Playground instead of requiring host shell or Node access.

All three paths use the same `wp-codebox/task-input/v1` task input contract. Host and browser paths also emit the same `wp-codebox/sandbox-session/v1` session envelope so product callers can correlate prepared browser sessions and completed host runs without transport-specific metadata drift.

`wp-codebox/run-agent-task-batch` runs one isolated sandbox per task sequentially and returns per-task status, artifact id, preview URL, and error fields. Parent orchestrators own any parallel fan-out above this ability.

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

Product callers can opt into public preview wiring through `preview_port`, `preview_bind`, and `preview_public_url`. Omit them to keep the default loopback-only random-port preview behavior; `preview_bind` requires `preview_port`, and `preview_public_url` must be an `http` or `https` URL.

Expected component keys:

- `agents_api`
- `data_machine`
- `data_machine_code`
- `provider_plugins` (optional list)

The CLI binary can come from ability input, the `wp_codebox_bin` option, or the `wp_codebox_bin` filter.

Data Machine Code is a mounted coding-tools component inside the sandbox. It provides workspace/file/GitHub tools to the sandboxed agent. WP Codebox owns the parent-site ability surface, sandbox lifecycle, and artifact capture boundary.

Apply-back is intentionally not part of `run-agent-task`. Sandbox execution returns proposed outputs and evidence. `list-artifacts`, `get-artifact`, and `discard-artifact` manage captured artifact bundles under the configured artifact root. `apply-approved-artifact` is the lower-level adapter/test API: it validates `artifact_id` plus an explicit `approved_files[]` list against canonical `changed-files.json`, recomputes the artifact content digest from `changed-files.json` and the exact `patch.diff` the reviewer approved, delegates to the `wp_codebox_apply_approved_artifact` filter, and requires the adapter to return `wp-codebox/apply-result/v1`. PR creation, direct deploy, package export, and bot identity policy live in adapters behind that reviewed boundary.

When Data Machine is present, prefer `stage-artifact-apply` for user-facing apply flows. It stages that same apply input as a Data Machine pending action with kind `wp_codebox_apply_back`. Its preview includes `files/review.json`, canonical changed files, normalized test results, and the explicit approved file list. Accepting the pending action resolves through Data Machine's generic resolver and calls the existing `apply-approved-artifact` path; rejecting it leaves the artifact untouched. This keeps approval lifecycle in Data Machine without making WP Codebox depend on Homeboy or any site-specific apply adapter.

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
- Wire parent orchestrators to the external sandbox session contract for durable lifecycle, retention, quotas, cancellation, and audit records.
- Define reviewed apply-back adapters for bot-authored PRs, direct apply, and package export.
- Add visual previews, parsed test command output, and richer risk flags to frontend review payloads.

## Development Notes

- Keep the runtime contract consumer-agnostic. Data Machine, Homeboy, Studio, wp-gym, and WordPress.com are consumers or mounted tools, not owners of the core artifact contract.
- Prefer small seams: runtime lifecycle, command handlers, artifact capture, recipes, WordPress integration, and apply-back should stay separate.
- When adding a new command or artifact type, update this README and `npm run check`.
