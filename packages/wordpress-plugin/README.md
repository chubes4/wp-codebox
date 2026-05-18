# Sandbox Runtime WordPress Plugin

Registers the WordPress ability surface for launching isolated Sandbox Runtime
agent sandboxes from a parent site.

## Ability

- `sandbox-runtime/run-agent-task`
- `sandbox-runtime/run-agent-task-batch`

The ability runs `sandbox-runtime agent-sandbox-run`, which boots a disposable
WordPress Playground runtime, mounts the agent stack components, invokes the
configured sandbox agent through the canonical `agents/chat` ability, and returns
artifact metadata.

The batch ability runs `sandbox-runtime agent-sandbox-batch`, accepts a list of
task descriptions, and launches one isolated sandbox per task with bounded
concurrency. This is the parent-site primitive for fan-out workflows such as
assigning several GitHub issues to separate sandbox coding agents.

Both abilities accept optional `provider` and `model` fields. These seed the
disposable sandbox's Data Machine agent configuration for the selected execution
mode. Provider credentials continue to resolve through the provider's normal
scoped mechanism, such as `OPENAI_API_KEY` for the OpenAI provider.

## Configuration

Component paths can be supplied by ability input, the
`sandbox_runtime_component_paths` option, or the `sandbox_runtime_component_paths`
filter.

Expected component keys:

- `agents_api`
- `data_machine`
- `data_machine_code`
- `openai_provider`

The CLI binary can be supplied by ability input, the `sandbox_runtime_bin` option,
or the `sandbox_runtime_bin` filter.

## Boundary

Data Machine Code is the mounted coding-tools component for file-editing agent
sandboxes. It provides workspace/file/GitHub tools inside the isolated runtime.
This plugin owns the parent-site ability surface and sandbox lifecycle boundary;
DMC does not own that control plane.
