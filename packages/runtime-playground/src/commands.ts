export function wpCliCommandFromArgs(args: string[]): string {
  const explicit = argValue(args, "command")
  if (explicit) {
    return explicit.trim()
  }

  return args.join(" ").trim()
}

export function abilityInputFromArgs(args: string[]): unknown {
  const raw = argValue(args, "input")
  if (!raw) {
    return {}
  }

  try {
    return JSON.parse(raw)
  } catch (error) {
    throw new Error(`wordpress.ability input must be valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export function abilityPhpCode(name: string, input: unknown): string {
  return `wp_set_current_user( 1 );
if ( ! function_exists( 'wp_get_ability' ) ) {
    throw new RuntimeException( 'The WordPress Abilities API is not available in this runtime.' );
}
$ability = wp_get_ability( ${JSON.stringify(name)} );
if ( ! $ability ) {
    throw new RuntimeException( sprintf( 'Ability is not registered: %s', ${JSON.stringify(name)} ) );
}
$result = $ability->execute( json_decode( ${JSON.stringify(JSON.stringify(input))}, true ) );
if ( is_wp_error( $result ) ) {
    throw new RuntimeException( $result->get_error_message() );
}
echo wp_json_encode( array(
    'command' => 'wordpress.ability',
    'name' => ${JSON.stringify(name)},
    'input' => json_decode( ${JSON.stringify(JSON.stringify(input))}, true ),
    'result' => $result,
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );`
}

export function shellArgv(command: string): string[] {
  const args: string[] = []
  let current = ""
  let quote = ""

  for (let index = 0; index < command.length; index++) {
    const char = command[index]
    if (!quote && /\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ""
      }
      continue
    }

    if ((char === "'" || char === '"') && (!quote || quote === char)) {
      quote = quote ? "" : char
      continue
    }

    if (char === "\\" && index + 1 < command.length) {
      current += command[++index]
      continue
    }

    current += char
  }

  if (quote) {
    throw new Error("Unclosed quote in wordpress.wp-cli command")
  }

  if (current) {
    args.push(current)
  }

  return args
}

export function wpCliPhpScript(argv: string[]): string {
  return `<?php
putenv('SHELL_PIPE=0');
$GLOBALS['argv'] = array_merge(array('/tmp/wp-cli.phar', '--path=/wordpress', '--no-color'), json_decode(${JSON.stringify(JSON.stringify(argv))}, true));
if (!defined('STDIN')) {
    define('STDIN', fopen('php://stdin', 'rb'));
}
if (!defined('STDOUT')) {
    define('STDOUT', fopen('php://stdout', 'wb'));
}
if (!defined('STDERR')) {
    define('STDERR', fopen('php://stderr', 'wb'));
}
require '/tmp/wp-cli.phar';
`
}

export function cleanWpCliOutput(output: string): string {
  return output.replace(/^#!\/usr\/bin\/env php\r?\n/, "")
}

export function argValue(args: string[], name: string): string | undefined {
  const prefix = `${name}=`
  const match = args.find((arg) => arg.startsWith(prefix))
  return match?.slice(prefix.length)
}

export function isSafeEnvName(name: string): boolean {
  return /^[A-Z_][A-Z0-9_]*$/.test(name)
}

export function normalizePhpCode(code: string): string {
  return code.trimStart().startsWith("<?php") ? code : `<?php\n${code}`
}

export function phpBody(code: string): string {
  return code.trimStart().replace(/^<\?php\s*/, "")
}
