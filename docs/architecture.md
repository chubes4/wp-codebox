# Architecture Vision

WP Codebox is the portable sandbox boundary for WordPress coding-agent work. It
lets a parent product start a disposable WordPress Playground runtime, mount the
target code and agent stack, collect reviewable artifacts, then apply or discard
those artifacts outside the sandbox.

```text
Parent control plane
  owns users, auth, durable jobs, review UX, and apply-back policy
    -> WP Codebox
      owns sandbox lifecycle, mounts, execution policy, and artifact capture
        -> disposable WordPress Playground runtime
          may mount Agents API, Data Machine, Data Machine Code, providers
          runs controlled commands or sandboxed agent tasks
        <- artifact bundle: patch, changed files, tests, preview, provenance
    <- reviewed apply, export, replay, or discard
```

## Product Shape

The core use case is safe code generation for WordPress products without giving
the agent production access. A site owner, Studio user, CI job, eval runner, or
chat surface can ask for a change; WP Codebox runs the work in Playground and
returns evidence that the parent product can review.

Example control planes include WordPress.com, Studio, self-hosted WordPress,
Frontend Agent Chat, Homeboy Extensions, wp-gym, GitHub Actions, and other host
applications. They consume WP Codebox; they do not change the sandbox contract.

## Landed Contracts

- **Sandbox session contract:** parent control planes pass caller-owned
  `sandbox_session_id` and optional `orchestrator` metadata to correlate runs.
  WP Codebox echoes a `wp-codebox/sandbox-session/v1` envelope and artifact refs,
  but durable queued/running/cancelled/expired lifecycle remains external. See
  [`sandbox-session-contract.md`](./sandbox-session-contract.md).
- **Apply-back contract:** sandbox execution returns artifacts only. Reviewed
  apply validates `artifact_id`, `approved_files[]`, the canonical changed-file
  manifest, and the artifact content digest before delegating to the
  `wp_codebox_apply_approved_artifact` adapter. PR creation, bot identity,
  deployment, and package export stay in parent adapters. See
  [`external-apply-adapter-contract.md`](./external-apply-adapter-contract.md).
- **Batch/fan-out primitive:** `wp-codebox/run-agent-task-batch` launches one
  isolated sandbox per task sequentially and returns per-task artifact ids,
  preview URLs, statuses, and errors. Homeboy audit fan-out and similar
  orchestrators should own parent-side parallelism, track their own parent jobs,
  pass correlation metadata into each sandbox run, and store the returned
  artifact ids as audit evidence.

## Ownership Boundaries

WP Codebox owns:

- Disposable Playground lifecycle.
- Mount normalization and sandbox workspace layout.
- Controlled command and agent-task execution.
- Artifact bundles, provenance, previews, patch surfaces, and replay metadata.
- WordPress plugin abilities that expose those sandbox operations to a host site.

Parent control planes own:

- Users, permissions, quotas, billing, durable jobs, retries, cancellation, and
  retention.
- Human review UX, approval records, and apply-back policy.
- Branch pushes, pull requests, deploys, package export, or direct apply.
- Bot identities and credentials used outside the sandbox.

In-sandbox Data Machine and Data Machine Code own only the tools mounted into a
disposable run. DMC may expose sandbox-scoped read/write/diff helpers for the
mounted workspace; parent-only operations such as worktree lifecycle, pushes,
GitSync, PR mutation, comments, deploys, and cleanup remain outside the sandbox.

## Design Rule

Keep the seams small and consumer-agnostic: session correlation, sandbox
lifecycle, command execution, artifact capture, and reviewed apply-back are
separate contracts. Integrations can add product policy around those seams
without making WP Codebox depend on a specific queue, review UI, deploy system,
or agent framework.
