# Agent Runtime Stack Probe

This example proves the intended guest application surface: a WordPress Playground sandbox with the agent runtime stack mounted and activated.

Set local checkout paths, then run the preset:

```bash
AGENTS_API_PATH=/path/to/agents-api \
DATA_MACHINE_PATH=/path/to/data-machine \
DATA_MACHINE_CODE_PATH=/path/to/data-machine-code \
PROVIDER_PLUGIN_PATH=/path/to/ai-provider-plugin \
npm run wp-codebox -- agent-runtime-probe \
  --agents-api "$AGENTS_API_PATH" \
  --data-machine "$DATA_MACHINE_PATH" \
  --data-machine-code "$DATA_MACHINE_CODE_PATH" \
  --provider-plugin "$PROVIDER_PLUGIN_PATH" \
  --artifacts ./artifacts \
  --json
```

The preset mounts the plugins at their canonical slugs, uses WordPress `7.0` by default, activates the plugins in dependency order, and returns a JSON readiness packet. It intentionally does not require provider credentials or model calls.
