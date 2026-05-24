# WP Codebox CLI

CLI entrypoint for running disposable WP Codebox sandboxes and collecting
reviewable artifact bundles. **Secure coding environments inside WordPress** — every command runs against a fresh WordPress Playground instance that can't touch your host site.

## Install

```bash
npm install -g @chubes4/wp-codebox-cli
wp-codebox --help
```

The package exposes the `wp-codebox` binary and includes the compiled
`dist/` entrypoint only. Build from source with `npm run build` before running
local package validation.

## Smoke

```bash
npm run build
npm run package-distribution-smoke
```

The distribution smoke runs `npm pack --dry-run --json` and verifies the package
contains `package.json`, `README.md`, and the compiled CLI entrypoint used by the
published binary.

## Recipe Planning

- `wp-codebox recipe validate --recipe <path> [--json]` validates recipe shape, paths, commands, and arguments without resolving a full execution plan.
- `wp-codebox recipe-run --recipe <path> --dry-run --json` validates the recipe and emits the resolved plan without booting Playground, creating temp workspaces, mutating files, or writing artifacts.
- `wp-codebox recipe-run --recipe <path> [--json]` boots Playground, mounts inputs, executes workflow steps, and captures artifacts.
