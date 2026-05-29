import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const cli = resolve(root, "packages/cli/dist/index.js")
const workspace = resolve(root, "artifacts/recipe-dry-run-smoke")
const recipePath = resolve(workspace, "recipe.json")
const invalidRecipePath = resolve(workspace, "invalid-recipe.json")
const externalRecipePath = resolve(workspace, "external-recipe.json")
const externalDisabledRecipePath = resolve(workspace, "external-disabled-recipe.json")
const externalUntrustedHostRecipePath = resolve(workspace, "external-untrusted-host-recipe.json")
const externalStrictDigestRecipePath = resolve(workspace, "external-strict-digest-recipe.json")
const invalidSiteSeedRecipePath = resolve(workspace, "invalid-site-seed-recipe.json")
const fixtureSeedPath = resolve(workspace, "fixture-seed.json")
const dryRunArtifacts = resolve(workspace, "dry-run-artifacts")
const multisiteCookbookRecipePath = resolve(root, "examples/recipes/cookbook/multisite-network.json")

mkdirSync(workspace, { recursive: true })
writeFileSync(fixtureSeedPath, `${JSON.stringify({ posts: [{ slug: "fixture-page" }] }, null, 2)}\n`)
writeFileSync(recipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "dry-run-smoke",
    wp: "7.0",
    blueprint: { steps: [] },
  },
  inputs: {
    secretEnv: ["DRY_RUN_TOKEN"],
    workspaces: [
      {
        sourceMode: "site-backed",
        seed: {
          type: "plugin_scaffold",
          slug: "dry-run-plugin",
        },
      },
    ],
    extraPlugins: [
      {
        source: "../../examples/simple-plugin",
        slug: "simple-plugin",
        pluginFile: "simple-plugin/simple-plugin.php",
      },
      {
        source: "../../examples/simple-plugin",
        slug: "simple-runtime",
        pluginFile: "simple-runtime/simple-plugin.php",
        activate: false,
        loadAs: "mu-plugin",
      },
    ],
    siteSeeds: [
      {
        type: "fixture",
        name: "fixture-editorial-shape",
        source: "./fixture-seed.json",
        format: "json",
        scopes: {
          posts: { slugs: ["fixture-page"], maxRecords: 1 },
        },
      },
      {
        type: "parent_site",
        name: "bounded-parent-shape",
        scopes: {
          posts: { postTypes: ["page"], slugs: ["sample-page"], maxRecords: 1 },
          options: { names: ["blogname"], maxRecords: 1 },
          users: { roles: ["administrator"], maxRecords: 1, anonymize: true },
          activePlugins: true,
          activeTheme: true,
        },
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: ["code=echo 'dry run';"],
      },
      {
        command: "wordpress.wp-cli",
        args: ["command=option get home"],
      },
    ],
  },
}, null, 2)}\n`)

writeFileSync(invalidRecipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: [],
      },
    ],
  },
}, null, 2)}\n`)

writeFileSync(invalidSiteSeedRecipePath, `${JSON.stringify({
  schema: "wp-codebox/workspace-recipe/v1",
  inputs: {
    siteSeeds: [
      {
        type: "parent_site",
        name: "unsafe-parent-users",
        scopes: {
          users: { roles: ["administrator"], anonymize: false },
        },
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: ["code=echo 'invalid seed';"],
      },
    ],
  },
}, null, 2)}\n`)

const externalRecipe = {
  schema: "wp-codebox/workspace-recipe/v1",
  runtime: {
    backend: "wordpress-playground",
    name: "external-source-dry-run-smoke",
    wp: "7.0",
  },
  inputs: {
    extraPlugins: [
      {
        source: "https://downloads.wordpress.org/plugin/bbpress.latest-stable.zip",
        pluginFile: "bbpress/bbpress.php",
        activate: false,
      },
      {
        source: "https://example.com/example-plugin.zip",
        slug: "example-plugin",
        pluginFile: "example-plugin/example-plugin.php",
        activate: false,
      },
    ],
  },
  workflow: {
    steps: [
      {
        command: "wordpress.run-php",
        args: ["code=echo 'external dry run';"],
      },
    ],
  },
}

writeFileSync(externalRecipePath, `${JSON.stringify(externalRecipe, null, 2)}\n`)
writeFileSync(externalDisabledRecipePath, `${JSON.stringify(externalRecipe, null, 2)}\n`)
writeFileSync(externalUntrustedHostRecipePath, `${JSON.stringify({
  ...externalRecipe,
  inputs: {
    extraPlugins: [
      {
        source: "https://evil.example/plugin.zip",
        slug: "evil-plugin",
        pluginFile: "evil-plugin/evil-plugin.php",
      },
    ],
  },
}, null, 2)}\n`)
writeFileSync(externalStrictDigestRecipePath, `${JSON.stringify({
  ...externalRecipe,
  inputs: {
    extraPlugins: [
      {
        source: "https://downloads.wordpress.org/plugin/bbpress.latest-stable.zip",
        pluginFile: "bbpress/bbpress.php",
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
  dryRunArtifacts,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8", env: { ...process.env, DRY_RUN_TOKEN: "redacted-value" } })

assert.equal(result.status, 0, result.stderr || result.stdout)
assert.equal(existsSync(dryRunArtifacts), false, "dry-run must not create artifact directories")

const output = JSON.parse(result.stdout)
assert.equal(output.success, true)
assert.equal(output.schema, "wp-codebox/recipe-run-dry-run/v1")
assert.equal(output.dryRun, true)
assert.equal(output.valid, true)
assert.equal(output.plan.runtime.backend, "wordpress-playground")
assert.equal(output.plan.workspaces.length, 1)
assert.equal(output.plan.workspaces[0].generated, true)
assert.equal(output.plan.workspaces[0].source, undefined)
assert.equal(output.plan.workspaces[0].sourceMode, "site-backed")
assert.equal(output.plan.workspaces[0].metadata.workspaceRoot, "/workspace")
assert.equal(output.plan.workspaces[0].metadata.sourceMode, "site-backed")
assert.equal(output.plan.extra_plugins[0].target, "/wordpress/wp-content/plugins/simple-plugin")
assert.equal(output.plan.extra_plugins[0].loadAs, "plugin")
assert.equal(output.plan.extra_plugins[1].target, "/wordpress/wp-content/mu-plugins/wp-codebox-runtime/simple-runtime")
assert.equal(output.plan.extra_plugins[1].loadAs, "mu-plugin")
assert.equal(output.plan.siteSeeds.length, 2)
assert.equal(output.plan.siteSeeds[0].source, fixtureSeedPath)
assert.equal(output.plan.siteSeeds[0].dryRunOnly, false)
assert.equal(output.plan.siteSeeds[0].privacy.importsIntoSandbox, true)
assert.equal(output.plan.siteSeeds[0].privacy.includesRecordData, true)
assert.equal(output.plan.siteSeeds[1].type, "parent_site")
assert.equal(output.plan.siteSeeds[1].bounded, true)
assert.equal(output.plan.siteSeeds[1].dryRunOnly, true)
assert.equal(output.plan.siteSeeds[1].privacy.exportsParentSiteData, false)
assert.equal(output.plan.siteSeeds[1].privacy.importsIntoSandbox, false)
assert.equal(output.plan.secretEnv[0].name, "DRY_RUN_TOKEN")
assert.equal(Object.prototype.hasOwnProperty.call(output.plan.secretEnv[0], "value"), false)
assert.equal(output.plan.secretEnv[0].available, true)
assert.equal(output.plan.workflow.steps.length, 4)
assert.equal(output.plan.workflow.steps[0].command, "install-mu-plugins")
assert.equal(output.plan.workflow.steps[0].policy.status, "allowed")
assert.equal(output.plan.workflow.steps[1].command, "activate-extra-plugins")
assert.equal(output.plan.workflow.steps[1].policy.status, "allowed")
assert.equal(output.plan.workflow.steps[2].resolvedCommand, "wordpress.run-php")
assert.equal(output.plan.workflow.steps[2].resolvedParsedArgs.code, "echo 'dry run';")
assert.equal(output.plan.workflow.steps[3].parsedArgs.command, "option get home")
assert.equal(output.plan.workflow.steps[3].policy.status, "allowed")
assert.equal(output.runtime, undefined)
assert.equal(output.executions, undefined)
assert.equal(output.artifacts, undefined)

const invalidResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  invalidRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(invalidResult.status, 1, invalidResult.stderr || invalidResult.stdout)
const invalidOutput = JSON.parse(invalidResult.stdout)
assert.equal(invalidOutput.success, false)
assert.equal(invalidOutput.valid, false)
assert.equal(invalidOutput.validation.issues[0].code, "missing-code")

const invalidSiteSeedResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  invalidSiteSeedRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(invalidSiteSeedResult.status, 1, invalidSiteSeedResult.stderr || invalidSiteSeedResult.stdout)
const invalidSiteSeedOutput = JSON.parse(invalidSiteSeedResult.stdout)
assert.equal(invalidSiteSeedOutput.success, false)
assert.equal(invalidSiteSeedOutput.validation.issues.some((issue: { code: string }) => issue.code === "unsafe-site-seed-users"), true)

const externalResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  externalRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8", env: { ...process.env, WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS: "1", WP_CODEBOX_ALLOWED_DOWNLOAD_HOSTS: "downloads.wordpress.org,example.com" } })

assert.equal(externalResult.status, 0, externalResult.stderr || externalResult.stdout)
const externalOutput = JSON.parse(externalResult.stdout)
assert.equal(externalOutput.success, true)
assert.equal(externalOutput.plan.extra_plugins[0].slug, "bbpress")
assert.equal(externalOutput.plan.extra_plugins[0].sourceType, "wporg_plugin_zip")
assert.equal(externalOutput.plan.extra_plugins[0].provenance.resolvedUrl, "https://downloads.wordpress.org/plugin/bbpress.latest-stable.zip")
assert.equal(externalOutput.plan.extra_plugins[1].sourceType, "https_zip")
assert.equal(externalOutput.plan.extra_plugins[1].provenance.kind, "https_zip")
assert.equal(externalOutput.plan.extra_plugins[1].provenance.policy.host, "example.com")

const externalUntrustedHostResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  externalUntrustedHostRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8", env: { ...process.env, WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS: "1" } })

assert.equal(externalUntrustedHostResult.status, 1, externalUntrustedHostResult.stderr || externalUntrustedHostResult.stdout)
const externalUntrustedHostOutput = JSON.parse(externalUntrustedHostResult.stdout)
assert.equal(externalUntrustedHostOutput.success, false)
assert.equal(externalUntrustedHostOutput.validation.issues[0].code, "download-host-not-allowed")

const externalStrictDigestResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  externalStrictDigestRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8", env: { ...process.env, WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS: "1", WP_CODEBOX_REQUIRE_SOURCE_SHA256: "1" } })

assert.equal(externalStrictDigestResult.status, 1, externalStrictDigestResult.stderr || externalStrictDigestResult.stdout)
const externalStrictDigestOutput = JSON.parse(externalStrictDigestResult.stdout)
assert.equal(externalStrictDigestOutput.success, false)
assert.equal(externalStrictDigestOutput.validation.issues[0].code, "missing-source-sha256")

const externalDisabledResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  externalDisabledRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8", env: { ...process.env, WP_CODEBOX_ALLOW_NETWORK_DOWNLOADS: "" } })

assert.equal(externalDisabledResult.status, 1, externalDisabledResult.stderr || externalDisabledResult.stdout)
const externalDisabledOutput = JSON.parse(externalDisabledResult.stdout)
assert.equal(externalDisabledOutput.success, false)
assert.equal(externalDisabledOutput.validation.issues[0].code, "network-downloads-disabled")

const multisiteCookbookResult = spawnSync(process.execPath, [
  cli,
  "recipe-run",
  "--recipe",
  multisiteCookbookRecipePath,
  "--dry-run",
  "--json",
], { cwd: root, encoding: "utf8" })

assert.equal(multisiteCookbookResult.status, 0, multisiteCookbookResult.stderr || multisiteCookbookResult.stdout)
const multisiteCookbookOutput = JSON.parse(multisiteCookbookResult.stdout)
assert.equal(multisiteCookbookOutput.success, true)
assert.equal(multisiteCookbookOutput.plan.mounts.length, 2)
assert.equal(multisiteCookbookOutput.plan.mounts[0].target, "/wordpress/wp-content/plugins/plugin-under-test")
assert.equal(multisiteCookbookOutput.plan.mounts[1].target, "/tmp/wp-codebox-cookbook")
assert.equal(multisiteCookbookOutput.plan.workflow.steps.length, 2)
assert.equal(multisiteCookbookOutput.plan.workflow.steps[0].resolvedParsedArgs.command, "wp core multisite-convert --title=\"WP Codebox Network\" --base=\"/\"")
assert.equal(multisiteCookbookOutput.plan.workflow.steps[1].resolvedParsedArgs.command, "wp eval-file /tmp/wp-codebox-cookbook/multisite-network-seed.php")

console.log("recipe dry-run smoke passed")
