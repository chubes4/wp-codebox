# WP Codebox WordPress Plugin

Registers the WordPress ability surface for launching isolated WP Codebox
agent sandboxes from a parent site. The sandbox may produce WordPress-specific
or non-WordPress artifacts; the plugin returns the artifact bundle metadata to
the parent control plane for review, replay, or apply-back.

## Ability

- `wp-codebox/run-agent-task`
- `wp-codebox/run-agent-task-batch`
- `wp-codebox/list-artifacts`
- `wp-codebox/get-artifact`
- `wp-codebox/discard-artifact`
- `wp-codebox/apply-approved-artifact`
- `wp-codebox/stage-artifact-apply`

The ability runs `wp-codebox agent-sandbox-run`, which boots a disposable
WordPress Playground runtime, mounts the agent stack components, invokes the
configured sandbox agent through the canonical `agents/chat` ability, and returns
artifact metadata.

The task ability accepts `wp-codebox/task-input/v1` fields: `goal`, `target`,
`allowed_tools`, `expected_artifacts`, `policy`, and `context`. Legacy callers
may still pass `task` as a string; the runner normalizes it into `goal` and
returns the normalized `task_input` in the ability response. Raw PHP `code` and
`code_file` fields remain rejected on this product ability path.

When `allowed_tools` includes Data Machine ability names, the parent-side runner
enforces the sandbox allow-list before launching the CLI. Parent-only abilities
such as workspace worktree, Git push, GitSync, GitHub mutation, and code-task
creation fail closed with `wp_codebox_tool_not_allowed`; hosts can narrow the
safe Data Machine tool set with the `wp_codebox_allowed_sandbox_tools` option or
filter. Non-Data-Machine labels remain descriptive task hints for the sandbox
agent.

```json
{
  "schema": "wp-codebox/task-input/v1",
  "goal": "Fix the failing settings save flow.",
  "target": { "kind": "plugin", "path": "wp-content/plugins/example" },
  "allowed_tools": ["workspace.read", "workspace.write", "tests.run"],
  "expected_artifacts": ["patch", "tests", "review"],
  "policy": { "applyBack": "reviewed" },
  "context": { "issue": "https://github.com/chubes4/wp-codebox/issues/29" }
}
```

The batch ability accepts a list of task descriptions or structured task inputs
and launches one isolated sandbox per task sequentially. Each task returns its
own status, artifact id, preview URL, and error payload when the task fails. This
is the parent-site primitive for fan-out workflows such as assigning several
GitHub issues to separate sandbox coding agents; parent orchestrators own any
parallelism above WP Codebox.

Parent control planes that need durable job/session state should own that state
outside WP Codebox and pass a caller-owned `sandbox_session_id`. WP Codebox
returns a `wp-codebox/sandbox-session/v1` envelope with that id, optional
`orchestrator` correlation metadata, and artifact references, but it does not
create host-site job tables or depend on a specific queue. See
`docs/sandbox-session-contract.md`.

Both abilities accept optional `provider` and `model` fields. These seed the
disposable sandbox's Data Machine agent configuration for the selected execution
mode. Provider plugins are supplied with `provider_plugin_paths`; WP Codebox
mounts and activates them without knowing provider-specific behavior. Provider
credentials continue to resolve through the provider's normal scoped mechanism.
Pass `secret_env` as a list of environment variable names to expose selected
parent process credentials inside the sandbox; values are read from the process
environment and are not accepted in the ability payload. For example, pass
`"secret_env": ["GITHUB_TOKEN"]` after the host process has `GITHUB_TOKEN` in
its environment; do not pass token values through ability input.

Callers may also pass an `inherit` declaration to request parent-environment
connectors or settings by name:

```json
{
  "inherit": {
    "connectors": ["primary-ai"],
    "settings": ["mode_models"]
  }
}
```

The parent site resolves that declaration through the
`wp_codebox_resolve_inheritance` filter. The resolver may return connector
status, `provider`, `model`, and `secret_env` names. WP Codebox records the
requested names and sanitized resolution status in the generated recipe/artifact
metadata and merges inherited `secret_env` names into the sandbox secret-env
allowlist. Secret values and setting values are not serialized into recipe JSON,
artifact metadata, logs, or patches by this transport slice.

Product callers may pass `mounts` to add editable or readonly host directories
to the generated recipe. Each mount may include opaque `metadata` such as
`repo`, `default_branch`, `repo_root_relative_to_mount`, and `editable` so tools
inside the sandbox can map changed sandbox paths back to source repositories.
WP Codebox preserves the metadata but does not interpret product-specific repo
topology.

The stable in-sandbox coding workspace root is `/workspace`. Repo-backed mode
mounts a repository there with its repository layout preserved. Site-backed mode
mounts a snapshot of a site's files, usually with `wp-content` under
`/workspace/wp-content`, and produces changed-file artifacts for reviewed
apply-back. If WordPress also needs to load a plugin or theme, callers can mount
the same source into `/wordpress/wp-content/plugins/<slug>` or
`/wordpress/wp-content/themes/<slug>` in addition to `/workspace/...`; both
mounts are captured in artifact metadata.

For browser review, callers may pass `preview_hold_seconds` to keep the live
Playground runtime available after artifact capture. The ability response's
`run.artifacts.preview.url` and the artifact's `files/review.json` `preview`
field point at the same live URL until the hold window expires. Without a hold
window, the preview field is still recorded as evidence but marked
`expired-on-completion` because the sandbox is destroyed when the command exits.

Returned artifact metadata includes the runtime manifest, replay blueprint,
after-state notes, captured readwrite mount index, event streams, and logs. WP
Codebox owns this capture boundary so the parent site can discard the disposable
sandbox while keeping durable evidence and outputs.

## Apply-Back Approval

Apply-back is a reviewed artifact flow, not part of sandbox execution.
`wp-codebox/apply-approved-artifact` validates the requested `artifact_id`, the
explicit `approved_files[]` list, and the artifact content digest before handing
the exact approved `files/patch.diff` to the `wp_codebox_apply_approved_artifact`
adapter filter.

When Data Machine is installed, `wp-codebox/stage-artifact-apply` stages the same
apply input as a Data Machine pending action with kind `wp_codebox_apply_back`.
The pending action preview includes `files/review.json`, canonical changed files,
normalized test results, and the approved file list. Accepting the pending action
calls the registered handler, which delegates back to
`wp-codebox/apply-approved-artifact`; rejecting it leaves the artifact untouched.

Without Data Machine pending actions, `stage-artifact-apply` fails closed with
`wp_codebox_datamachine_pending_actions_missing`. Direct reviewed apply remains
available through `apply-approved-artifact` for hosts that provide their own
approval surface.

See [External Apply Adapter Contract](../../docs/external-apply-adapter-contract.md)
for the parent-control-plane contract. The documented smoke fixture proves that
an external adapter can consume the verified artifact payload and record adapter
metadata, PR URL, branch, commit, and artifact digest without WP Codebox calling
Homeboy, Data Machine Code, or any other product-specific apply-back system.

## Configuration

Component paths can be supplied by ability input, the
`wp_codebox_component_paths` option, or the `wp_codebox_component_paths`
filter. On multisite, WP Codebox reads `wp_codebox_component_paths` from network
options because component paths are host-level configuration.

Expected component keys:

- `agents_api`
- `data_machine`
- `data_machine_code`
- `provider_plugins` (optional list)

The CLI binary can be supplied by ability input, the `wp_codebox_bin` option,
or the `wp_codebox_bin` filter. On multisite, WP Codebox reads `wp_codebox_bin`
from network options because the binary path is host-level configuration.

The artifact root can be supplied per request with `artifacts_path`, by the
`wp_codebox_artifacts_root` option, or by the `wp_codebox_artifacts_root`
filter. On multisite, WP Codebox reads `wp_codebox_artifacts_root` from network
options.

## Package Artifact

Build the installable plugin zip from the repository root:

```bash
npm run package:wordpress-plugin
```

The generated artifact is `packages/wordpress-plugin/dist/wp-codebox.zip`. It
contains a single top-level `wp-codebox/` directory with `wp-codebox.php`, this
README, and the `src/` PHP files. Generated build outputs and package metadata
are intentionally excluded from the plugin zip.

Validate the artifact shape with:

```bash
npm run package-distribution-smoke
```

## Boundary

Data Machine Code is the mounted coding-tools component for file-editing agent
sandboxes. It provides sandbox-scoped workspace and file tools inside the
isolated runtime. This plugin owns the parent-site ability surface and sandbox
lifecycle boundary; DMC does not own that control plane.

Sandbox-safe DMC abilities are an explicit allow-list:

- Workspace read/list/search/edit primitives: `datamachine/workspace-read`,
  `datamachine/workspace-ls`, `datamachine/workspace-grep`,
  `datamachine/workspace-write`, `datamachine/workspace-edit`, and
  `datamachine/workspace-apply-patch`.
- Local evidence primitives: `datamachine/workspace-git-status`,
  `datamachine/workspace-git-log`, and `datamachine/workspace-git-diff`.
- Read-only GitHub context primitives: issue, PR, PR file, check/status, tree,
  file, and repo list/get abilities.

Parent-only DMC abilities include workspace clone/adopt/remove/delete, worktree
lifecycle and cleanup, git pull/add/commit/push/rebase/reset, GitSync
bind/pull/submit/push/policy changes, issue/PR creation or mutation, comments,
review comments, merges, PR cleanup, GitHub file writes, and code-task creation.
Those abilities must not be exposed through the sandbox agent bundle. The sandbox
produces artifact metadata, changed files, patches, and review evidence; the
parent control plane performs reviewed apply-back, branch pushes, deploys, and PR
creation.

The WordPress runner validates any requested `datamachine/*` entries in
`allowed_tools` against that boundary before the sandbox process starts. The
default list matches the sandbox-safe DMC abilities above; installations can
narrow it with `wp_codebox_allowed_sandbox_tools` while parent-only abilities are
always removed from the effective allow-list.

Data Machine, Data Machine Code, Homeboy Extensions, wp-gym, and other systems
are consumers or mounted tools. They do not own WP Codebox's artifact contract.
