# Sandbox Runtime WordPress Plugin

Registers the WordPress ability surface for launching isolated Sandbox Runtime
agent sandboxes from a parent site.

## Ability

- `sandbox-runtime/run-agent-task`

The ability runs `sandbox-runtime agent-sandbox-run`, which boots a disposable
WordPress Playground runtime, mounts the agent stack components, executes the
task, and returns artifact metadata.

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
