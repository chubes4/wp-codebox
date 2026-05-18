# Simple Plugin Fixture

Tiny WordPress plugin fixture for `wp-codebox run`.

The demo mounts this directory into a disposable WordPress Playground-shaped runtime at:

```text
/wordpress/wp-content/plugins/simple-plugin
```

Use it to verify the v0 runtime contract:

```bash
npm run wp-codebox -- run \
  --mount ./examples/simple-plugin:/wordpress/wp-content/plugins/simple-plugin \
  --command wordpress.run-php \
  --arg code-file=./examples/simple-plugin/probe.php \
  --artifacts ./artifacts \
  --json
```

The current backend records mounts, command output, logs, and observations in an artifact bundle so product surfaces can link users to the evidence they would review before applying sandboxed work.
