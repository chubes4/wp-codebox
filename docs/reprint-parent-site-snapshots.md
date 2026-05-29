# Reprint Parent-Site Snapshot Evaluation

Issue #162 evaluated Reprint as a parent-site snapshot backend for WP Codebox.

## Recommendation

Use Reprint later as a full/essential-site snapshot backend under a WP Codebox-owned policy layer. Do not use Reprint for the first bounded `siteSeeds` implementation.

## Why

Reprint already owns the hard migration mechanics: authenticated source-site export, resumable streaming, database import, URL rewriting, status/state/audit files, and Playground-oriented runtime output.

WP Codebox issue #147 needs a different public contract first: explicit scopes, record caps, option allow-lists, anonymized users, media-file exclusion by default, and artifact provenance that says what was included or excluded. Reprint does not currently expose those WP Codebox-specific selectors as a small Node/CLI API.

## Current Slice

The current implementation keeps bounded seeds inside WP Codebox:

- Local `fixture` seeds import scoped JSON into the sandbox before workflow steps run.
- The WordPress host ability can export explicit `parent_site` scopes to a temporary JSON fixture and pass it to `recipe-run`.
- Users are anonymized and media file bytes are not exported.
- Full database state, comments, revisions, arbitrary meta, uploads, secrets, and filesystem state are intentionally out of scope.

## Future Reprint Shape

A future Reprint integration should be explicit and separate from bounded seeds:

- Add a recipe field for full/essential parent-site snapshots, not overload bounded fixture seeds.
- Shell out to a user-installed or managed `reprint.phar` instead of vendoring Reprint internals.
- Start with `preflight` and state/status/audit artifact capture.
- Keep `essential-files` and no upload replay as the default policy.
- Record Reprint version, command phases, exit codes, status files, audit files, source URL origin, URL rewrite settings, and runtime output paths in artifact provenance.

## Close Or Keep Open

Issue #162 should remain open as a future-backend tracker unless maintainers decide this evaluation is enough and open a narrower implementation issue for the eventual Reprint adapter.
