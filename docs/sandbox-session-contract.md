# Sandbox Session Contract

WP Codebox keeps sandbox execution generic and host-storage agnostic. It does not
create host-site database tables or own a queue. Parent control planes that need
durable sessions should create their own job/session record, then call WP Codebox
with a caller-owned `sandbox_session_id`.

## Boundary

```text
Parent control plane
  owns users, queues, jobs, retries, cancellation, retention, and UI history
    -> calls wp-codebox/run-agent-task with sandbox_session_id
      -> WP Codebox shells out to the CLI and captures artifacts
    <- returns wp-codebox/sandbox-session/v1 for correlation

Disposable Playground sandbox
  may mount Agents API, Data Machine, Data Machine Code, and provider plugins
  owns in-sandbox agent behavior only
```

The host WP Codebox plugin should not depend on a specific parent job system.
Data Machine, Homeboy, DMC, Studio, or a custom host app can all be external
orchestrators that consume the same abilities and artifact contracts.

## Request Fields

`wp-codebox/run-agent-task` and `wp-codebox/run-agent-task-batch` accept these
optional correlation fields:

```json
{
  "sandbox_session_id": "external-job-123",
  "session_id": "sandbox-agent-conversation-456",
  "orchestrator": {
    "type": "data-machine-job",
    "id": "parent-site-control-plane",
    "job_id": "123"
  }
}
```

- `sandbox_session_id` is caller-owned. WP Codebox echoes it in the response and
  does not persist it.
- `session_id` remains the in-sandbox agent conversation/session id passed to the
  mounted agent runtime.
- `orchestrator` is opaque correlation metadata for external job systems.

## Response Shape

The ability response includes a `wp-codebox/sandbox-session/v1` envelope:

```json
{
  "session": {
    "schema": "wp-codebox/sandbox-session/v1",
    "id": "external-job-123",
    "status": "completed",
    "persistence": "external-orchestrator",
    "agent_session_id": "sandbox-agent-conversation-456",
    "orchestrator": {
      "type": "data-machine-job",
      "id": "parent-site-control-plane",
      "job_id": "123"
    },
    "artifacts": {
      "path": "/srv/artifacts/run-123",
      "bundle_id": "artifact-bundle-sha256-...",
      "preview_url": "https://preview.example.test/abc"
    }
  },
  "agent_result": {
    "schema": "wp-codebox/agent-result/v1",
    "status": "completed",
    "actionable": true,
    "summary": "Agent sandbox produced 2 changed files and a 1842-byte patch.",
    "changedFiles": {
      "count": 2,
      "paths": ["plugin.php", "tests/plugin-test.php"],
      "artifact": "files/changed-files.json"
    },
    "patch": {
      "bytes": 1842,
      "artifact": "files/patch.diff"
    },
    "transcript": {
      "artifact": "files/transcript.json",
      "executionCount": 1
    }
  }
}
```

The `status` field describes the synchronous WP Codebox call result. Durable
queued/running/cancelled/expired transitions belong to the external orchestrator.

## Agent Result Evidence

Agent sandbox recipe runs also write these additive artifact files:

- `files/agent-result.json` uses `wp-codebox/agent-result/v1` and summarizes
  actionability, changed-file count, patch bytes, transcript location, failures,
  no-op reason, and workspace-tool diagnostics.
- `files/transcript.json` uses `wp-codebox/agent-transcript/v1` and captures the
  bounded stdout/stderr plus parsed JSON for each `wp-codebox.agent-sandbox-run`
  workflow step.

The recipe-run JSON exposes the same compact `agentResult` object, and the host
WordPress ability mirrors it as `agent_result`. Empty patches and empty
`changed-files.json` are explicit non-actionable no-op results even when the
process exits successfully.

## External Orchestrator Responsibilities

- Store durable job/session state and user ownership.
- Enforce quotas, cancellation, concurrency, and retention.
- Decide whether to retry failed runs.
- Store links to returned artifact ids and preview URLs.
- Call WP Codebox artifact abilities for review, discard, or approved apply-back.

WP Codebox owns the sandbox run and artifact contract. It intentionally does not
own the parent site's job tables or product lifecycle UI.
