# Cookbook recipes

Recipes that exercise realistic surface area, intended as starting points for
adopters whose first non-toy attempt to use WP Codebox is "test my plugin
against bbPress" or "drive my theme against seeded content."

These are not internal correctness fixtures (the recipes in
`examples/recipes/*.json` cover that). They are product fixtures: each one
mounts a target plugin or theme, seeds a realistic host context via Playground
blueprint steps, and is intended to be paired with `--preview-hold` for visual
smoke testing.

## Site seed planning boundary

Recipe authors can use `inputs.siteSeeds` to describe fixture or parent-site
content shapes for dry-run review, but the current cookbook recipes still seed
runtime content through explicit fixture scripts. WP Codebox does not snapshot a
parent site, read private production rows, copy uploads, or import site seed
records from `inputs.siteSeeds` in this slice.

Treat parent-site seed declarations as a reviewable manifest only: opt in to
bounded scopes, name exact option keys, keep user data anonymized, and keep
secrets, credentials, private post bodies, raw option values, and upload files
out of recipe files and dry-run evidence.

## Available recipes

### `multisite-network.json`

Converts the Playground install to multisite with WP-CLI, mounts your plugin
under test, network-activates it when a plugin file is present, seeds two child
sites through a WP-CLI `eval-file` seed, and emits network, site, and admin URLs
from the seed step.

**Replace** the `inputs.mounts[0].source` value in the recipe with the path to
the plugin you want to exercise in network mode. The default points at
`../simple-plugin` so the recipe runs out of the box.

```bash
# Edit examples/recipes/cookbook/multisite-network.json:
#   "source": "../../path/to/your-plugin"
#
# Then:
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/cookbook/multisite-network.json \
  --preview-hold 30m \
  --json
```

The seed step's JSON output includes `network_admin_url`, `main_site_url`, and a
`sites` array with two child-site URLs and admin URLs. Pair with
`--preview-hold` to click through network admin and child-site screens while the
Playground preview stays alive.

#### Why this exists

Many WordPress plugins only break when they are network-active, read network
options, or run across multiple sites. This recipe gives plugin authors a
repeatable first smoke test for that surface without requiring a local multisite
install.

#### Extending

The seed step is intentionally small. Add more sites, roles, options, or content
in `multisite-network-seed.php` before the JSON output line if your plugin needs
a richer network shape.

### `theme-block-editor.json`

Boots a Playground with a theme mounted at
`/wordpress/wp-content/themes/theme-under-test`, activates that mounted theme,
seeds a page with common block-editor surfaces, and auto-logs in as admin. Pair
with `--preview-hold` and open the seed output's `frontend_url` or
`block_editor_url` to review the theme in both rendered and editor contexts.

**Replace** the `inputs.mounts[0].source` value in the recipe with the path to
the theme you want to exercise. The default points at the adjacent
`theme-block-editor-theme` fixture so the recipe runs out of the box.

```bash
# Edit examples/recipes/cookbook/theme-block-editor.json:
#   "source": "../../path/to/your-theme"
#
# Then:
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/cookbook/theme-block-editor.json \
  --preview-hold 30m \
  --json
```

The seed step's JSON output includes the seeded page's frontend URL, the front
page URL, the block editor URL, and admin URLs for page review.

#### Why this exists

Theme and editor-facing changes often fail only after WordPress boots with real
block markup, editor styles, and admin routing. This recipe gives theme authors
and plugin authors a fast visual smoke surface before installing a change on a
real site.

#### Extending

Edit `theme-block-editor-seed.php` to add blocks, templates, patterns, custom
post types, or additional admin/editor URLs that match your product surface. If
you need to test an editor-facing plugin instead of a theme, add a second mount
under `/wordpress/wp-content/plugins/<plugin-slug>` and activate it from the
seed step before emitting URLs.

### `seeded-content.json`

Boots a Playground with Twenty Twenty-Five active, mounts your plugin under
test, and seeds a compact editorial fixture: published pages, a posts page,
published and draft posts, categories, tags, an editor user, and an author
user. Pair with `--preview-hold` and use the seed step's JSON output to open
the home page, blog index, first post, category archive, author archive, or
admin list tables.

**Replace** the `inputs.mounts[0].source` value in the recipe with the path
to the plugin you want to exercise against seeded content. The default points
at `../simple-plugin` so the recipe runs out of the box.

```bash
# Edit examples/recipes/cookbook/seeded-content.json:
#   "source": "../../path/to/your-plugin"
#
# Then:
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/cookbook/seeded-content.json \
  --preview-hold 30m \
  --json
```

The seed step emits object IDs plus useful preview and admin URLs. This recipe
intentionally creates fixture data with WP APIs; it does not import or snapshot
content from a parent site.

#### Extending

Edit `seeded-content-seed.php` when you need more fixture shape: additional
post statuses, custom post types registered by your plugin, taxonomy terms,
menus, options, or block combinations. Keep any production or private content
out of this recipe; parent-site snapshots belong to a separate workflow.

### `bbpress-reply-editor.json`

Boots a Playground with bbPress installed from `wordpress.org/plugins`, mounts
your plugin under test, seeds one forum and one topic, and auto-logs in as
admin. Pair with `--preview-hold` and navigate the preview URL from the seed
output to land on the bbPress reply form.

**Replace** the `inputs.mounts[0].source` value in the recipe with the path
to the plugin you want to exercise against bbPress. The default points at
`../../simple-plugin` so the recipe runs out of the box, but the interesting
mount target is whatever editor-or-reply-handling plugin you're debugging.

```bash
# Edit examples/recipes/cookbook/bbpress-reply-editor.json:
#   "source": "../../path/to/your-plugin"
#
# Then:
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/cookbook/bbpress-reply-editor.json \
  --preview-hold 30m \
  --json
```

The seed step's JSON output includes the preview URLs for the seeded reply
form.

#### Why this exists

The motivating use case was debugging a runtime regression in
[Extra-Chill/blocks-everywhere](https://github.com/Extra-Chill/blocks-everywhere)
after a major refactor (removing the bundled isolated-block-editor dependency).
Two production deploys to extrachill.com broke the bbPress reply editor because
the change had never been runtime-tested against a real bbPress host page. A
sandbox recipe that boots bbPress + the plugin under test + a seeded topic is
exactly the smoke-test surface that would have caught the regression before
release.

This recipe is the generalized version of that smoke test. Drop in any plugin
that hooks the bbPress reply editor surface and the preview URL gives you a
real reply form to click into.

#### Extending

The seed step is intentionally small. If you need additional bbPress shape
(multiple forums, nested replies, custom user roles, additional topics with
varying content shapes), edit `bbpress-reply-editor-seed.php` to add them
before the JSON output line, or fork the recipe entirely.

### `browser-actions-demo.json`

The reference example for the **`wordpress.browser-actions` interaction probe**
(shipped in wp-codebox #311). Where the other cookbook recipes seed a host shape
and pair with `--preview-hold` for *manual* clicking, this recipe *drives* a
real React component with an ordered interaction script and asserts that it
still **works** — not just that the page renders.

It boots WordPress **trunk** (so the editor stack runs on **React 19**), mounts
a tiny vendor-neutral demo plugin (`browser-actions-demo-plugin/`) that renders
a real `@wordpress/element` widget — a click counter and a bound range slider —
into a Tools admin page, then drives it:

- clicks the **Increment** button three times and asserts the counter advanced
  to `3` and a "threshold reached" message appeared;
- moves the **slider** to `80` and asserts the bound output value updated.

```bash
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/cookbook/browser-actions-demo.json \
  --json
```

The demo plugin uses `@wordpress/element` (the React WordPress already ships) so
the fixture needs **no build step** — the recipe mounts the plugin directory
as-is.

The recipe's `wordpress.browser-actions` step records its evidence under
`artifacts/<runtime>/files/browser/`:

- `steps.jsonl` — per-step index/kind/selector/timing/ok-fail
- `action-summary.json` — the machine-readable `assertions` block
  (`total`/`passed`/`failed`) plus each `expect`/`evaluate` result
- `screenshot-*.png` — named captures: `demo-loaded`, `after-increment`,
  `after-slider`

A green run reports **6/6 assertions passed, 0 failed, 0 page errors**.

#### Why this exists

A render-only smoke test ("the component mounts") would not catch a regression
where a component renders but its interaction is dead — the exact failure mode
that bites when a third-party React widget breaks on a major React bump (React
18 → 19 changed effect timing, `ref` semantics, and Strict Mode
double-invocation). The interaction probe drives the real component and asserts
behavior, which is the difference between "it renders" and "it works."

#### Adapting it to your plugin

Swap `inputs.mounts[0].source` to your plugin and rewrite the `steps-json` to
drive your own UI: `click`/`hover`/`fill`/`type`/`select`/`drag` to interact,
`expect`/`evaluate` to assert state, and `screenshot` to capture named frames.
Keep `steps-json` inline (not `@file`) if it contains an `evaluate` step so the
recipe auto-grants the `wordpress.browser-actions.evaluate` policy capability.

A worked, plugin-specific consumer of this capability — driving the
[data-machine-socials](https://github.com/Extra-Chill/data-machine-socials)
`react-easy-crop` modal under React 19 — lives in that plugin's own repository,
where the recipe sits next to the code it guards.

### `woocommerce-store.json`

Boots a Playground with WooCommerce installed from `wordpress.org/plugins`,
mounts your plugin under test, seeds a small store, and auto-logs in as admin.
The fixture data includes standard store pages, three simple products, one
customer, and one processing order so product, cart, checkout, order, and common
WooCommerce hook integrations have real data to inspect.

**Replace** the `inputs.mounts[0].source` value in the recipe with the path to
the plugin you want to exercise against WooCommerce. The default points at
`../../simple-plugin` so the recipe runs out of the box, but the interesting
mount target is whatever WooCommerce integration you're debugging.

```bash
# Edit examples/recipes/cookbook/woocommerce-store.json:
#   "source": "../../path/to/your-plugin"
#
# Then:
npm run wp-codebox -- recipe-run \
  --recipe ./examples/recipes/cookbook/woocommerce-store.json \
  --preview-hold 30m \
  --json
```

The seed step's JSON output includes storefront URLs for the shop, cart,
checkout, account page, first product, and admin URLs for orders. Use the shop
URL for storefront smoke testing, the checkout URL for payment/cart flows, and
the order admin URL for integrations that render order meta or admin hooks.

#### Why this exists

WooCommerce is a high-value non-toy host shape for WordPress plugin authors.
Many integrations need products, carts, checkout pages, orders, customers, and
WooCommerce hooks before their runtime behavior is visible. This recipe gives
that shape without parent-site snapshots or production data.

#### Extending

The seed step is fixture-only and intentionally small. If you need additional
WooCommerce shape (variable products, coupons, subscriptions, custom gateways,
tax classes, shipping zones, or more order statuses), edit
`woocommerce-store-seed.php` to add them before the JSON output line, or fork
the recipe entirely.
