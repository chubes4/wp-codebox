import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/recipe-site-seed-smoke")
const recipePath = resolve(workspace, "recipe.json")
const fixtureSeedPath = resolve(workspace, "fixture-seed.json")
const customSeedPath = resolve(workspace, "custom-seed.fixture")
const importerPluginDir = resolve(workspace, "test-seed-importer")
const importerPluginPath = resolve(importerPluginDir, "test-seed-importer.php")
const unknownFormatRecipePath = resolve(workspace, "unknown-format-recipe.json")

mkdirSync(workspace, { recursive: true })
mkdirSync(importerPluginDir, { recursive: true })
writeFileSync(fixtureSeedPath, `${JSON.stringify({
  posts: [
    {
      post_type: "page",
      slug: "site-seed-smoke-page",
      title: "Site Seed Smoke Page",
      content: "Seeded by WP Codebox siteSeeds.",
      status: "publish",
    },
    {
      post_type: "page",
      slug: "site-seed-smoke-excluded-page",
      title: "Excluded Site Seed Page",
      status: "publish",
    },
  ],
  options: {
    blogname: "WP Codebox Seeded Sandbox",
    admin_email: "private@example.test",
  },
  activePlugins: ["simple-plugin/simple-plugin.php"],
  activeTheme: "twentytwentyfive",
  terms: [
    {
      taxonomy: "category",
      slug: "site-seed-smoke-category",
      name: "Site Seed Smoke Category",
    },
  ],
  users: [
    {
      user_login: "site-seed-smoke-user",
      user_email: "site-seed-smoke-user@example.invalid",
      display_name: "Site Seed Smoke User",
      roles: ["editor"],
    },
  ],
  media: [
    {
      post_name: "site-seed-smoke-media",
      post_title: "Site Seed Smoke Media",
      post_mime_type: "image/png",
    },
  ],
}, null, 2)}\n`)
writeFileSync(customSeedPath, "site-seed-smoke-registry-page\n")
writeFileSync(importerPluginPath, `<?php
/**
 * Plugin Name: WP Codebox Test Site Seed Importer
 */

add_filter('wp_codebox_site_seed_importers', function (array $importers): array {
    $importers['test-fixture'] = array(
        'label' => 'WP Codebox test fixture importer',
        'callback' => function (array $request): array {
            $slug = trim((string) ($request['source_contents'] ?? ''));
            if ('' === $slug) {
                throw new RuntimeException('Test fixture source was empty.');
            }

            $post_id = wp_insert_post(array(
                'post_type' => 'page',
                'post_status' => 'publish',
                'post_name' => $slug,
                'post_title' => 'Registry Site Seed Smoke Page',
                'post_content' => 'Seeded by a registered WP Codebox site seed importer.',
            ), true);
            if (is_wp_error($post_id)) {
                throw new RuntimeException($post_id->get_error_message());
            }

            return array(
                'counts' => array('posts' => 1, 'scopedPostTypes' => count($request['scopes']['posts']['postTypes'] ?? array())),
                'warnings' => array('registry importer smoke warning'),
                'provenance' => array(
                    'requestName' => $request['name'] ?? '',
                    'sourceBasename' => $request['source_basename'] ?? '',
                ),
            );
        },
    );
    return $importers;
});
`)

writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "recipe-site-seed-smoke",
    wp: "7.0",
    blueprint: { steps: [] },
  },
  inputs: {
    mounts: [
      {
        source: "../../examples/simple-plugin",
        target: "/wordpress/wp-content/plugins/simple-plugin",
        mode: "readonly",
      },
    ],
    extraPlugins: [
      {
        source: "./test-seed-importer",
        slug: "test-seed-importer",
        pluginFile: "test-seed-importer/test-seed-importer.php",
      },
    ],
    siteSeeds: [
      {
        type: "fixture",
        name: "site-seed-smoke-fixture",
        source: "./fixture-seed.json",
        format: "json",
        scopes: {
          posts: { postTypes: ["page"], slugs: ["site-seed-smoke-page"], maxRecords: 1 },
          options: { names: ["blogname"], maxRecords: 1 },
          terms: { taxonomies: ["category"], slugs: ["site-seed-smoke-category"], maxRecords: 1 },
          users: { names: ["site-seed-smoke-user"], anonymize: true, maxRecords: 1 },
          media: { slugs: ["site-seed-smoke-media"], maxRecords: 1 },
          activePlugins: true,
          activeTheme: true,
        },
      },
      {
        type: "fixture",
        name: "site-seed-registry-fixture",
        source: "./custom-seed.fixture",
        format: "test-fixture",
        scopes: {
          posts: { postTypes: ["page"], slugs: ["site-seed-smoke-registry-page"], maxRecords: 1 },
        },
      },
      {
        type: "parent_site",
        name: "bounded-parent-declaration",
        scopes: {
          posts: { postTypes: ["page"], slugs: ["front-page"], maxRecords: 1 },
          options: { names: ["blogname"], maxRecords: 1 },
        },
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: [
          "code=$page = get_page_by_path('site-seed-smoke-page', OBJECT, 'page'); if (!$page) { throw new RuntimeException('seeded page missing'); } $registry_page = get_page_by_path('site-seed-smoke-registry-page', OBJECT, 'page'); if (!$registry_page) { throw new RuntimeException('registry seeded page missing'); } if (get_page_by_path('site-seed-smoke-excluded-page', OBJECT, 'page')) { throw new RuntimeException('unscoped page imported'); } if (get_option('blogname') !== 'WP Codebox Seeded Sandbox') { throw new RuntimeException('seeded option missing'); } if (!term_exists('site-seed-smoke-category', 'category')) { throw new RuntimeException('seeded term missing'); } if (!username_exists('site-seed-smoke-user')) { throw new RuntimeException('seeded user missing'); } $media = get_page_by_path('site-seed-smoke-media', OBJECT, 'attachment'); if (!$media) { throw new RuntimeException('seeded media missing'); } if (!is_plugin_active('simple-plugin/simple-plugin.php')) { throw new RuntimeException('seeded plugin not active'); } if (!is_plugin_active('test-seed-importer/test-seed-importer.php')) { throw new RuntimeException('importer plugin not active'); } if (get_stylesheet() !== 'twentytwentyfive') { throw new RuntimeException('seeded theme not active: ' . get_stylesheet()); } echo wp_json_encode(array('page' => $page->post_name, 'registryPage' => $registry_page->post_name, 'blogname' => get_option('blogname'), 'user' => username_exists('site-seed-smoke-user'), 'media' => $media->post_name, 'pluginActive' => is_plugin_active('simple-plugin/simple-plugin.php'), 'stylesheet' => get_stylesheet()));",
        ],
      },
    ],
  },
}, null, 2)}\n`)

writeFileSync(unknownFormatRecipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "recipe-site-seed-unknown-format-smoke",
    wp: "7.0",
    blueprint: { steps: [] },
  },
  inputs: {
    siteSeeds: [
      {
        type: "fixture",
        name: "unknown-format-fixture",
        source: "./custom-seed.fixture",
        format: "missing-importer",
        scopes: {
          posts: { postTypes: ["page"], maxRecords: 1 },
        },
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: ["code=echo 'should not run';"],
      },
    ],
  },
}, null, 2)}\n`)

const result = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  recipePath,
  "--artifacts",
  resolve(workspace, "artifacts"),
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(result.status, 0, result.stderr || result.stdout)
const output = JSON.parse(result.stdout)
assert.equal(output.success, true)
assert.equal(output.siteSeeds.length, 3)
assert.equal(output.siteSeeds[0].action, "imported")
assert.equal(output.siteSeeds[0].privacy.importsIntoSandbox, true)
assert.equal(output.siteSeeds[0].counts.posts, 1)
assert.equal(output.siteSeeds[0].counts.options, 1)
assert.equal(output.siteSeeds[0].counts.terms, 1)
assert.equal(output.siteSeeds[0].counts.users, 1)
assert.equal(output.siteSeeds[0].counts.media, 1)
assert.equal(output.siteSeeds[0].counts.activePlugins, 1)
assert.equal(output.siteSeeds[0].counts.activeTheme, 1)
assert.equal(output.siteSeeds[0].counts.fixturePostsExcluded, 1)
assert.equal(output.siteSeeds[0].counts.fixtureActivePluginsIncluded, 1)
assert.equal(output.siteSeeds[0].counts.fixtureActiveThemeIncluded, 1)
assert.equal(output.siteSeeds[0].provenance.importer, "json")
assert.equal(output.siteSeeds[1].action, "imported")
assert.equal(output.siteSeeds[1].importer, "test-fixture")
assert.equal(output.siteSeeds[1].counts.posts, 1)
assert.equal(output.siteSeeds[1].counts.scopedPostTypes, 1)
assert.equal(output.siteSeeds[1].warnings[0], "registry importer smoke warning")
assert.equal(output.siteSeeds[1].provenance.importer, "test-fixture")
assert.equal(output.siteSeeds[1].provenance.requestName, "site-seed-registry-fixture")
assert.equal(output.siteSeeds[1].provenance.sourceBasename, "custom-seed.fixture")
assert.equal(output.siteSeeds[2].action, "skipped")
assert.equal(output.siteSeeds[2].bounded, true)
assert.equal(output.siteSeeds[2].privacy.exportsParentSiteData, false)
assert.equal(output.executions.length, 4)

const workflowResult = JSON.parse(output.executions[3].stdout)
assert.equal(workflowResult.page, "site-seed-smoke-page")
assert.equal(workflowResult.registryPage, "site-seed-smoke-registry-page")
assert.equal(workflowResult.blogname, "WP Codebox Seeded Sandbox")
assert.equal(typeof workflowResult.user, "number")
assert.equal(workflowResult.media, "site-seed-smoke-media")
assert.equal(workflowResult.pluginActive, true)
assert.equal(workflowResult.stylesheet, "twentytwentyfive")

const unknownFormatResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  unknownFormatRecipePath,
  "--artifacts",
  resolve(workspace, "unknown-format-artifacts"),
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(unknownFormatResult.status, 1, unknownFormatResult.stderr || unknownFormatResult.stdout)
const unknownFormatOutput = JSON.parse(unknownFormatResult.stdout)
assert.equal(unknownFormatOutput.success, false)
assert.match(unknownFormatOutput.error.message, /No WP Codebox site seed importer registered for format: missing-importer/)

console.log("recipe site seed smoke passed")
