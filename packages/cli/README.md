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

## Discovery

Tooling can discover the stable command and recipe-authoring surface without
booting WordPress Playground:

```bash
wp-codebox commands --json
wp-codebox schema recipe --json
```

`commands` emits `wp-codebox/command-catalog/v1` with command ids,
descriptions, accepted args, known output shape, and policy requirements.
`schema recipe` emits the JSON Schema for `wp-codebox/workspace-recipe/v1` from
the canonical `createWorkspaceRecipeJsonSchema()` contract exported by
`@chubes4/wp-codebox-core`.

## Recipe Planning

- `wp-codebox validate-blueprint --blueprint <json|file> [--json]` boots a raw WordPress Playground blueprint through WP Codebox and captures the normal artifact bundle.
- `wp-codebox recipe validate --recipe <path> [--json]` validates recipe shape, paths, commands, and arguments without resolving a full execution plan.
- `wp-codebox recipe-run --recipe <path> --dry-run --json` validates the recipe and emits the resolved plan without booting Playground, creating temp workspaces, mutating files, or writing artifacts.
- `wp-codebox recipe-run --recipe <path> [--json]` boots Playground, mounts inputs, executes workflow steps, and captures artifacts.

Recipes may declare `inputs.siteSeeds` for explicit content/site seed planning. This first slice is dry-run-only: WP Codebox validates bounded fixture or parent-site seed declarations and reports them under `plan.siteSeeds`, but it does not export data from a parent WordPress site and does not import seed records into Playground during normal `recipe-run` execution.

Parent-site-derived declarations must stay minimized: each scope needs explicit selectors or `maxRecords`, option scopes must name exact option keys, user scopes must stay anonymized, and parent-site media file copying is rejected. Dry-run output reports only names, selectors, bounds, fixture paths, and privacy flags; it does not include record bodies, option values, user emails, secrets, uploads, or database rows.

## Interactive Boot

- `wp-codebox boot [--mount <host>:<vfs>] --hold <duration> [--json]` boots Playground, captures preview/artifact metadata, holds the live preview with the same duration semantics as `run --preview-hold`, then tears down and collects artifacts without creating a workflow command.
- `boot` accepts the runtime setup options relevant to interactive previews: `--mount`, `--blueprint <json|file>`, `--wp`, `--artifacts`, `--policy <json|file>`, `--preview-port`, `--preview-bind`, and `--preview-public-url`.
