import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { argValue, isSafeEnvName, normalizePhpCode, phpBody } from "./commands.js"
import type { RuntimeCreateSpec } from "@chubes4/wp-codebox-core"

interface PhpBootstrapBridge {
  url: string
  token: string
}

export function bootstrapAbilityPhpCode(spec: RuntimeCreateSpec, code: string): string {
  return `<?php
define( 'REST_REQUEST', true );
$_SERVER['REQUEST_URI'] = '/wp-json/wp-codebox/ability';
require_once '/wordpress/wp-load.php';
${secretEnvPhp(spec)}
${phpBody(code)}`
}

export function bootstrapPhpCode(spec: RuntimeCreateSpec, code: string, args: string[], wpCliBridge?: PhpBootstrapBridge): string {
  if (argValue(args, "bootstrap") === "none") {
    return code
  }

  return `<?php
${pluginRuntimeBootstrapPhp(spec)}
require_once '/wordpress/wp-load.php';
${secretEnvPhp(spec)}
${wpCliBridge ? `putenv(${JSON.stringify(`HOMEBOY_TERMINAL_ACTION_URL=${wpCliBridge.url}`)});
putenv(${JSON.stringify(`HOMEBOY_TERMINAL_ACTION_TOKEN=${wpCliBridge.token}`)});
` : ""}
${phpBody(code)}`
}

export async function phpCodeFromArgs(args: string[], command = "wordpress.run-php"): Promise<string> {
  const inlineCode = argValue(args, "code")
  if (inlineCode) {
    return normalizePhpCode(inlineCode)
  }

  const codeFile = argValue(args, "code-file")
  if (codeFile) {
    return normalizePhpCode(await readFile(resolve(codeFile), "utf8"))
  }

  throw new Error(`${command} requires code=<php> or code-file=<path>`)
}

function pluginRuntimeBootstrapPhp(spec: RuntimeCreateSpec): string {
  const pluginRuntime = spec.metadata?.recipe && typeof spec.metadata.recipe === "object" && !Array.isArray(spec.metadata.recipe)
    ? (spec.metadata.recipe as { inputs?: { pluginRuntime?: unknown } }).inputs?.pluginRuntime
    : undefined
  if (!pluginRuntime || typeof pluginRuntime !== "object" || Array.isArray(pluginRuntime)) {
    return ""
  }

  const runtime = pluginRuntime as { php?: { memoryLimit?: unknown; maxExecutionTime?: unknown }; wpConfigDefines?: Record<string, unknown> }
  const lines: string[] = []
  const memoryLimit = typeof runtime.php?.memoryLimit === "string" ? runtime.php.memoryLimit : undefined
  if (memoryLimit && /^[0-9]+[KMG]?$/.test(memoryLimit)) {
    lines.push(`@ini_set('memory_limit', ${JSON.stringify(memoryLimit)});`)
  }
  const maxExecutionTime = runtime.php?.maxExecutionTime
  if (Number.isInteger(maxExecutionTime) && typeof maxExecutionTime === "number" && maxExecutionTime >= 0 && maxExecutionTime <= 3600) {
    lines.push(`@set_time_limit(${maxExecutionTime});`)
  }
  for (const [name, value] of Object.entries(runtime.wpConfigDefines ?? {})) {
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name) || (!["string", "number", "boolean"].includes(typeof value) && value !== null)) {
      continue
    }
    lines.push(`if (!defined(${JSON.stringify(name)})) { define(${JSON.stringify(name)}, ${phpLiteral(value as string | number | boolean | null)}); }`)
  }

  return lines.length > 0 ? `${lines.join("\n")}\n` : ""
}

function secretEnvPhp(spec: RuntimeCreateSpec): string {
  const entries = Object.entries(spec.secretEnv ?? {}).filter(([name]) => isSafeEnvName(name))
  if (entries.length === 0) {
    return ""
  }

  return `${entries
    .map(([name, value]) => `putenv(${JSON.stringify(`${name}=${value}`)});`)
    .join("\n")}\n`
}

function phpLiteral(value: string | number | boolean | null): string {
  if (typeof value === "string") {
    return JSON.stringify(value)
  }
  if (value === null) {
    return "null"
  }
  return String(value)
}
