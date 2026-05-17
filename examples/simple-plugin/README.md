# Simple Plugin Fixture

Tiny WordPress plugin fixture for `npm run hello-runtime`.

The demo mounts this directory into a disposable WordPress Playground-shaped runtime at:

```text
/wordpress/wp-content/plugins/simple-plugin
```

Use it to verify the v0 runtime contract:

```bash
npm run hello-runtime -- ./examples/simple-plugin
```

The current backend is a foundation stub. It records mounts, command output, logs, and observations in an artifact bundle so product surfaces can link users to the evidence they would review before applying sandboxed work.
