# Sandbox Runtime

Portable TypeScript substrate for isolated application runtimes. WordPress Playground is the first backend.

## Thesis

Sandbox Runtime is not an app, an agent framework, or a CI harness. It is a small runtime contract for app and agent platforms that need to create isolated environments, mount inputs, execute controlled actions, observe state, and export artifacts.

```text
App or agent platform
  -> Sandbox Runtime contract
  -> Backend adapter
  -> Isolated environment
  -> Artifact bundle
```

The flagship use case is real-time, sandboxed coding inside application environments. A product can let a user chat with an agent, run the work inside a disposable sandbox, stream observations, and apply only the resulting artifact to a real project or site.

For WordPress, this means a control plane such as Studio, Data Machine, or WordPress.com can run agents against WordPress Playground sandboxes instead of granting broad access to production sites, local machines, or CI-only harnesses.

## Packages

- `@chubes4/sandbox-runtime-core`: backend-agnostic runtime interfaces and shared types.
- `@chubes4/sandbox-runtime-playground`: first backend adapter shaped around WordPress Playground.

## v0 Demo

```bash
npm install
npm run hello-runtime -- ./examples/simple-plugin
```

Expected output:

```text
Sandbox Runtime hello
Thesis: product surfaces can create disposable WordPress sandboxes, run work there, and apply only the artifact bundle.
WordPress inception: WordPress can safely orchestrate a WordPress Playground runtime instead of writing directly to a live site.

Created runtime: wordpress-playground
Mounted: simple-plugin
Executed: inspect-mounted-inputs
Collected artifacts:
- Directory: ./artifacts/runtime-...
- Open: file:///.../sandbox-runtime/artifacts/runtime-...
- Manifest: ./artifacts/runtime-.../manifest.json
- Metadata: ./artifacts/runtime-.../metadata.json
- Events: ./artifacts/runtime-.../events.jsonl
- Runtime log: ./artifacts/runtime-.../logs/runtime.log
- Commands log: ./artifacts/runtime-.../logs/commands.log
- Mounts: ./artifacts/runtime-.../files/mounts.json
- Observations: ./artifacts/runtime-.../observations.json
Destroyed runtime
```

The Playground backend mounts the local plugin directory into WordPress Playground and boots lazily on the first `execute()` call. The demo command runs a controlled PHP probe through `server.playground.run()`, collects artifacts, and disposes the Playground server when the runtime is destroyed. The `Open` line is a clickable local artifact URL, and the file paths point to the evidence files a product UI could expose after a sandbox run.

The fixture plugin is documented in [`examples/simple-plugin/README.md`](examples/simple-plugin/README.md).

## v0 Runtime Policy

`RuntimePolicy` is a portable declaration that every backend receives with `RuntimeCreateSpec`. The core package exposes `validateRuntimePolicy()`, `assertRuntimePolicy()`, and `assertRuntimeCommandAllowed()` so backends and control planes can validate the v0 policy shape before work starts.

```ts
const result = validateRuntimePolicy({
  network: "deny",
  filesystem: "readwrite-mounts",
  commands: ["inspect-mounted-inputs"],
  secrets: "none",
  approvals: "never",
})
```

Policy fields are split between **enforced now** and **declared for backend/control-plane enforcement**:

| Field | v0 values | Status |
| --- | --- | --- |
| `commands` | string command allow-list | Enforced by `assertRuntimeCommandAllowed()`; the Playground stub rejects commands outside the list. |
| `network` | `allow`, `deny`, `{ allowHosts }` | Validated in core; declared for real backend enforcement. |
| `filesystem` | `sandbox`, `readonly-mounts`, `readwrite-mounts` | Validated in core; declared for mount/backend enforcement. |
| `secrets` | `none`, `connector-scoped` | Validated in core; declared for control planes that inject credentials. |
| `approvals` | `never`, `on-write`, `on-command` | Validated in core; declared for product/control-plane approval UX. |

Disallowed commands throw `RuntimeCommandPolicyViolationError`. The error includes a stable `code`, denied `command`, `allowedCommands`, and the full `policy`, and serializes cleanly with `toJSON()` for artifact capture.

## Non-Goals

- Replace Homeboy.
- Replace Agents API.
- Replace WP AI Client.
- Implement provider auth or Codex integration in v0.
- Couple the top-level contract to WordPress-specific concepts.

## Product Direction

Sandbox Runtime should make isolated app sandboxes usable from real-time products, not only CI or operator tools.

```text
User request
  -> control plane creates sandbox task
  -> backend boots isolated runtime
  -> agent or workflow acts inside the sandbox
  -> runtime collects evidence and artifacts
  -> user/app applies, exports, or discards the result
```

The first backend is WordPress Playground. Future consumers can include Studio, Data Machine Code, wp-gym, world-of-wordpress, WordPress.com product surfaces, and CI/eval runners.

## Related Issues

- https://github.com/chubes4/sandbox-runtime/issues/1
- https://github.com/chubes4/sandbox-runtime/issues/2
- https://github.com/chubes4/sandbox-runtime/issues/3
- https://github.com/chubes4/sandbox-runtime/issues/4
- https://github.com/chubes4/sandbox-runtime/issues/5
- https://github.com/chubes4/sandbox-runtime/issues/6
- https://github.com/chubes4/sandbox-runtime/issues/7
