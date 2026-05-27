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

export interface BenchRunCodeOptions {
  componentId: string
  pluginSlug: string
  iterations: number
  warmupIterations: number
  dependencySlugs: string[]
  env: Record<string, unknown>
  workloads: unknown[]
}

export interface PhpunitRunCodeOptions {
  pluginSlug: string
  autoloadFile: string
  testsDir: string
  phpunitXml: string
  selectedTestFile: string
  changedTestFiles: unknown[]
  env: Record<string, unknown>
  wpConfigDefines: Record<string, unknown>
  dependencyMounts: string[]
  multisite: boolean
}

export interface CorePhpunitRunCodeOptions {
  coreRoot: string
  testsDir: string
  phpunitXml: string
  selectedTestFile: string
  changedTestFiles: unknown[]
  autoloadFile: string
  wpConfigDefines: Record<string, unknown>
  multisite: boolean
}

export interface PluginCheckFinding {
  code?: string
  type?: string
  severity?: string
  message?: string
  file?: string
  line?: number
  column?: number
  docs?: string
  raw: Record<string, unknown>
}

export interface PluginCheckNormalizedOutput {
  schema: "wp-codebox/plugin-check/v1"
  command: "wordpress.plugin-check"
  targetPlugin: string
  exitCode: number
  status: "passed" | "failed"
  summary: {
    total: number
    errors: number
    warnings: number
    notices: number
    info: number
    unknown: number
  }
  findings: PluginCheckFinding[]
  rawFormat: "json" | "text"
}

export function normalizePluginCheckOutput(rawOutput: string, exitCode: number, pluginSlug: string): PluginCheckNormalizedOutput {
  const parsed = parsePluginCheckJson(rawOutput)
  const findings = parsed ? collectPluginCheckFindings(parsed) : []
  const summary = findings.reduce<PluginCheckNormalizedOutput["summary"]>((counts, finding) => {
    counts.total++
    const severity = pluginCheckSeverity(finding)
    counts[severity]++
    return counts
  }, { total: 0, errors: 0, warnings: 0, notices: 0, info: 0, unknown: 0 })
  const effectiveExitCode = exitCode === 0 && summary.errors > 0 ? 1 : exitCode

  return {
    schema: "wp-codebox/plugin-check/v1",
    command: "wordpress.plugin-check",
    targetPlugin: pluginSlug,
    exitCode: effectiveExitCode,
    status: effectiveExitCode === 0 && summary.errors === 0 ? "passed" : "failed",
    summary,
    findings,
    rawFormat: parsed ? "json" : "text",
  }
}

function parsePluginCheckJson(rawOutput: string): unknown | undefined {
  const trimmed = rawOutput.trim()
  if (!trimmed) {
    return []
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    const firstJson = trimmed.match(/[\[{]/)
    if (!firstJson) {
      return undefined
    }

    try {
      return JSON.parse(trimmed.slice(firstJson.index))
    } catch {
      return undefined
    }
  }
}

function collectPluginCheckFindings(value: unknown, inheritedFile = "", inheritedType = ""): PluginCheckFinding[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPluginCheckFindings(item, inheritedFile, inheritedType))
  }

  if (!value || typeof value !== "object") {
    return []
  }

  const record = value as Record<string, unknown>
  if (looksLikePluginCheckFinding(record)) {
    return [normalizePluginCheckFinding(record, inheritedFile, inheritedType)]
  }

  return Object.entries(record).flatMap(([key, child]) => collectPluginCheckFindings(
    child,
    looksLikePathKey(key) ? key : inheritedFile,
    pluginCheckTypeKey(key) ?? inheritedType,
  ))
}

function looksLikePluginCheckFinding(record: Record<string, unknown>): boolean {
  return ["message", "code", "type", "severity"].some((key) => typeof record[key] === "string")
}

function looksLikePathKey(key: string): boolean {
  return key.includes("/") || key.endsWith(".php") || key.endsWith(".js") || key.endsWith(".css")
}

function pluginCheckTypeKey(key: string): string | undefined {
  if (key === "errors" || key === "warnings") {
    return key.slice(0, -1)
  }
  return undefined
}

function normalizePluginCheckFinding(record: Record<string, unknown>, inheritedFile: string, inheritedType: string): PluginCheckFinding {
  const file = stringField(record, "file") || stringField(record, "filename") || stringField(record, "path") || inheritedFile || undefined
  const line = numberField(record, "line") ?? numberField(record, "line_number")
  const column = numberField(record, "column") ?? numberField(record, "column_number")
  const type = stringField(record, "type") || inheritedType

  return {
    ...(stringField(record, "code") ? { code: stringField(record, "code") } : {}),
    ...(type ? { type } : {}),
    ...(stringField(record, "severity") ? { severity: stringField(record, "severity") } : {}),
    ...(stringField(record, "message") ? { message: stringField(record, "message") } : {}),
    ...(file ? { file } : {}),
    ...(typeof line === "number" ? { line } : {}),
    ...(typeof column === "number" ? { column } : {}),
    ...(stringField(record, "docs") || stringField(record, "documentation") ? { docs: stringField(record, "docs") || stringField(record, "documentation") } : {}),
    raw: record,
  }
}

function pluginCheckSeverity(finding: PluginCheckFinding): "errors" | "warnings" | "notices" | "info" | "unknown" {
  const value = `${finding.severity ?? finding.type ?? finding.code ?? ""}`.toLowerCase()
  if (value.includes("error")) {
    return "errors"
  }
  if (value.includes("warning") || value.includes("warn")) {
    return "warnings"
  }
  if (value.includes("notice")) {
    return "notices"
  }
  if (value.includes("info")) {
    return "info"
  }
  return "unknown"
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" && record[key].trim() !== "" ? record[key] : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

export function phpunitRunCode(options: PhpunitRunCodeOptions): string {
  return `error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');

$plugin_slug = ${JSON.stringify(options.pluginSlug)};
$plugin_path = '/wordpress/wp-content/plugins/' . $plugin_slug;
$result_file = $plugin_path . '/.pg-test-result.txt';
$current_stage = 'preboot';
$autoload_file = ${JSON.stringify(options.autoloadFile)};
$tests_dir = ${JSON.stringify(options.testsDir)};
$selected_test_file = ${JSON.stringify(options.selectedTestFile)};
$changed_test_files_raw = ${JSON.stringify(JSON.stringify(options.changedTestFiles))};
$bench_env = json_decode(${JSON.stringify(JSON.stringify(options.env))}, true);
$wp_config_defines = json_decode(${JSON.stringify(JSON.stringify(options.wpConfigDefines))}, true);
$dep_mounts = ${JSON.stringify(options.dependencyMounts.join("\\n"))};
$multisite = ${JSON.stringify(options.multisite)};

function pg_log($msg) {
    global $result_file;
    file_put_contents($result_file, $msg . "\n", FILE_APPEND);
}

function pg_diagnostic_context(): string {
    global $current_stage;
    $hook = function_exists('current_filter') ? current_filter() : null;
    if (!is_string($hook) || $hook === '') {
        $hook = 'none';
    }
    $installing = function_exists('wp_installing') && wp_installing() ? 'true' : 'false';
    return 'stage=' . ($current_stage ?: 'unknown') . ' hook=' . $hook . ' wp_installing=' . $installing;
}

function &pg_stage_timings_ref(): array {
    static $timings = array('_starts_ns' => array(), '_durations_ms' => array());
    return $timings;
}

function pg_stage_begin($stage) {
    global $current_stage;
    $current_stage = $stage;
    $timings = &pg_stage_timings_ref();
    $timings['_starts_ns'][$stage] = hrtime(true);
    pg_log('STAGE_BEGIN:' . $stage);
}

function pg_stage_ok($stage) {
    $timings = &pg_stage_timings_ref();
    if (isset($timings['_starts_ns'][$stage])) {
        $timings['_durations_ms'][$stage] = (hrtime(true) - $timings['_starts_ns'][$stage]) / 1000000;
    }
    pg_log('STAGE_OK:' . $stage);
}

function pg_stage_fail($stage, Throwable $e) {
    pg_log('STAGE_FAIL:' . $stage . ':' . get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    pg_log('TRACE:');
    foreach (explode("\n", $e->getTraceAsString()) as $line) {
        pg_log('  ' . $line);
    }
}

function pg_install_diagnostics_handlers() {
    set_error_handler(function ($severity, $message, $file, $line) {
        if (!(error_reporting() & $severity)) {
            return false;
        }
        $labels = array(E_WARNING => 'WARNING', E_NOTICE => 'NOTICE', E_DEPRECATED => 'DEPRECATED', E_USER_WARNING => 'USER_WARNING', E_USER_NOTICE => 'USER_NOTICE', E_USER_DEPRECATED => 'USER_DEPRECATED', E_STRICT => 'STRICT');
        pg_log('NOTICE:' . ($labels[$severity] ?? ('E_' . $severity)) . ': ' . $message . ' at ' . $file . ':' . $line . ' context=' . pg_diagnostic_context());
        return false;
    });
    register_shutdown_function(function () {
        global $current_stage;
        $error = error_get_last();
        if ($error && in_array($error['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
            pg_log('STAGE_FATAL:' . $current_stage . ':' . $error['message'] . ' at ' . $error['file'] . ':' . $error['line']);
        }
    });
}

function pg_snapshot_wordpress_hook_callbacks(string $hook_name): array {
    global $wp_filter;
    $snapshot = array();
    if (!isset($wp_filter[$hook_name]) || !isset($wp_filter[$hook_name]->callbacks)) {
        return $snapshot;
    }
    foreach ($wp_filter[$hook_name]->callbacks as $priority => $callbacks) {
        foreach (array_keys($callbacks) as $callback_id) {
            $snapshot[$priority . ':' . $callback_id] = true;
        }
    }
    return $snapshot;
}

function pg_remove_new_wordpress_hook_callbacks(string $hook_name, array $before): void {
    global $wp_filter;
    if (!isset($wp_filter[$hook_name]) || !isset($wp_filter[$hook_name]->callbacks)) {
        return;
    }
    foreach ($wp_filter[$hook_name]->callbacks as $priority => $callbacks) {
        foreach (array_keys($callbacks) as $callback_id) {
            if (!isset($before[$priority . ':' . $callback_id])) {
                unset($wp_filter[$hook_name]->callbacks[$priority][$callback_id]);
            }
        }
        if (empty($wp_filter[$hook_name]->callbacks[$priority])) {
            unset($wp_filter[$hook_name]->callbacks[$priority]);
        }
    }
}

function pg_defer_new_wordpress_hook_callbacks(string $hook_name, array $before): array {
    global $wp_filter;
    $deferred = array();
    if (!isset($wp_filter[$hook_name]) || !isset($wp_filter[$hook_name]->callbacks)) {
        return $deferred;
    }
    foreach ($wp_filter[$hook_name]->callbacks as $priority => $callbacks) {
        foreach ($callbacks as $callback_id => $callback) {
            if (isset($before[$priority . ':' . $callback_id])) {
                continue;
            }
            $deferred[] = array('priority' => (int) $priority, 'callback' => $callback);
            unset($wp_filter[$hook_name]->callbacks[$priority][$callback_id]);
        }
        if (empty($wp_filter[$hook_name]->callbacks[$priority])) {
            unset($wp_filter[$hook_name]->callbacks[$priority]);
        }
    }
    usort($deferred, static function (array $left, array $right): int { return $left['priority'] <=> $right['priority']; });
    return $deferred;
}

function pg_run_deferred_wordpress_hook_callbacks(array $deferred, array $args = array(), ?string $hook_name = null): void {
    global $wp_current_filter;
    $pushed_hook = false;
    if (is_string($hook_name) && $hook_name !== '') {
        if (!is_array($wp_current_filter)) {
            $wp_current_filter = array();
        }
        $wp_current_filter[] = $hook_name;
        $pushed_hook = true;
    }
    try {
        foreach ($deferred as $entry) {
            $callback = $entry['callback'] ?? null;
            if (!is_array($callback) || !isset($callback['function'])) {
                continue;
            }
            $accepted_args = isset($callback['accepted_args']) ? (int) $callback['accepted_args'] : count($args);
            call_user_func_array($callback['function'], array_slice($args, 0, $accepted_args));
        }
    } finally {
        if ($pushed_hook) {
            array_pop($wp_current_filter);
        }
    }
}

function pg_reopen_wordpress_action(string $hook_name): bool {
    global $wp_actions;
    if (!function_exists('did_action') || did_action($hook_name) === 0) {
        return false;
    }
    if (!is_array($wp_actions)) {
        $wp_actions = array();
    }
    $wp_actions[$hook_name] = 0;
    pg_log('NOTICE:reopened WordPress action after install: ' . $hook_name);
    return true;
}

function pg_fire_reopened_wordpress_action(string $hook_name, bool $reopened): void {
    if ($reopened && function_exists('do_action')) {
        do_action($hook_name);
    }
}

function pg_preload_wp_cli_namespaced_functions(): void {
    global $autoload_file;
    $vendor_dir = dirname($autoload_file);
    $wp_cli_root = $vendor_dir . '/wp-cli/wp-cli';
    if (!defined('WP_CLI_ROOT')) {
        define('WP_CLI_ROOT', $wp_cli_root);
    }
    if (!defined('WP_CLI_VENDOR_DIR')) {
        define('WP_CLI_VENDOR_DIR', $vendor_dir);
    }
    if (!defined('WP_CLI_VERSION') && is_readable($wp_cli_root . '/VERSION')) {
        define('WP_CLI_VERSION', trim(file_get_contents($wp_cli_root . '/VERSION')));
    }
    if (!defined('WP_CLI_START_MICROTIME')) {
        define('WP_CLI_START_MICROTIME', microtime(true));
    }
    if (!function_exists('WP_CLI\\Utils\\parse_str_to_argv') && is_readable($wp_cli_root . '/php/utils.php')) {
        require_once $wp_cli_root . '/php/utils.php';
    }
    if (!function_exists('WP_CLI\\Dispatcher\\get_path') && is_readable($wp_cli_root . '/php/dispatcher.php')) {
        require_once $wp_cli_root . '/php/dispatcher.php';
    }
    if (!function_exists('WP_CLI\\Utils\\get_upgrader') && is_readable($wp_cli_root . '/php/utils-wp.php')) {
        require_once $wp_cli_root . '/php/utils-wp.php';
    }
}

function pg_run_boot_stage(array $cfg = []): ?string {
    global $autoload_file;
    pg_stage_begin('boot');
    try {
        $extra_defines = $cfg['extra_defines'] ?? array();
        $config_path = '/tmp/wp-tests-config.php';
        $config = "<?php\n";
        if (!empty($extra_defines) && is_array($extra_defines)) {
            $config .= "\n// Recipe-declared wp-config defines.\n";
            foreach ($extra_defines as $name => $value) {
                if (!is_string($name) || !preg_match('/^[A-Z_][A-Z0-9_]*$/i', $name)) {
                    pg_log('NOTICE: skipping invalid wp_config_defines key: ' . var_export($name, true));
                    continue;
                }
                $config .= sprintf("if (!defined('%s')) { define('%s', %s); }\n", $name, $name, var_export($value, true));
            }
        }
        $config .= <<<'CONFIG'
$table_prefix = 'wptests_';
define('DB_NAME', ':memory:');
define('DB_USER', 'root');
define('DB_PASSWORD', '');
define('DB_HOST', 'localhost');
define('DB_CHARSET', 'utf8');
define('WP_TESTS_DOMAIN', 'example.org');
define('WP_TESTS_EMAIL', 'admin@example.org');
define('WP_TESTS_TITLE', 'Test Blog');
define('WP_PHP_BINARY', 'php');
define('ABSPATH', '/wordpress/');
define('FS_CHMOD_FILE', 0644);
define('FS_CHMOD_DIR', 0755);
define('FS_METHOD', 'direct');
CONFIG;
        file_put_contents($config_path, $config);
        pg_preload_wp_cli_namespaced_functions();
        require_once $autoload_file;
        pg_stage_ok('boot');
        return $config_path;
    } catch (Throwable $e) {
        pg_stage_fail('boot', $e);
        exit(1);
    }
}

function pg_run_install_stage(array $cfg) {
    global $argv;
    pg_stage_begin('install');
    try {
        $tests_dir = $cfg['tests_dir'];
        $config_path = $cfg['config_path'];
        $ms_tests = !empty($cfg['multisite']) ? 'run_ms_tests' : 'no_ms_tests';
        $argv = array('install.php', $config_path, $ms_tests, 'no_core_tests');
        $_SERVER['argv'] = $argv;
        require_once $tests_dir . '/includes/install.php';
        while (ob_get_level() > 0) {
            @ob_end_clean();
        }
        pg_stage_ok('install');
    } catch (Throwable $e) {
        pg_stage_fail('install', $e);
        exit(1);
    }
}

function pg_run_load_deps_stage(array $cfg): array {
    pg_stage_begin('load_deps');
    try {
        $loaded = array();
        foreach (explode("\n", (string) ($cfg['dep_mounts'] ?? '')) as $dep_mount) {
            $dep_mount = trim($dep_mount);
            if ($dep_mount === '') {
                continue;
            }
            foreach (glob($dep_mount . '/*.php') ?: array() as $dep_file) {
                if (basename($dep_file) === 'db.php') {
                    continue;
                }
                if (strpos(file_get_contents($dep_file), 'Plugin Name:') !== false) {
                    require_once $dep_file;
                    $loaded[] = $dep_file;
                    break;
                }
            }
        }
        pg_stage_ok('load_deps');
        return $loaded;
    } catch (Throwable $e) {
        pg_stage_fail('load_deps', $e);
        exit(1);
    }
}

function pg_run_load_component_stage(array $cfg): ?string {
    pg_stage_begin('load_component');
    try {
        $plugin_path = $cfg['plugin_path'];
        $loaded_file = null;
        $style_css = $plugin_path . '/style.css';
        if (file_exists($style_css) && strpos(file_get_contents($style_css), 'Theme Name:') !== false) {
            pg_log('THEME_DETECTED');
            if (file_exists($plugin_path . '/functions.php')) {
                require_once $plugin_path . '/functions.php';
            }
        } else {
            foreach (glob($plugin_path . '/*.php') ?: array() as $main_file) {
                if (basename($main_file) === 'db.php') {
                    continue;
                }
                if (strpos(file_get_contents($main_file), 'Plugin Name:') !== false) {
                    pg_log('PLUGIN_DETECTED ' . basename($main_file));
                    pg_log('PLUGIN_LOAD_CONTEXT ' . basename($main_file) . ' activate=false ' . pg_diagnostic_context());
                    require_once $main_file;
                    $loaded_file = $main_file;
                    break;
                }
            }
            if ($loaded_file === null) {
                pg_log("NOTICE:no plugin entry file with 'Plugin Name:' header found in " . $plugin_path);
            }
        }
        pg_stage_ok('load_component');
        return $loaded_file;
    } catch (Throwable $e) {
        pg_stage_fail('load_component', $e);
        exit(1);
    }
}

function pg_run_activation_stage(array $cfg): void {
    pg_stage_begin('activation');
    try {
        foreach (($cfg['plugin_files'] ?? array()) as $plugin_file) {
            if (is_string($plugin_file) && $plugin_file !== '') {
                pg_activate_plugin_file($plugin_file, !empty($cfg['multisite']));
            }
        }
        pg_stage_ok('activation');
    } catch (Throwable $e) {
        pg_stage_fail('activation', $e);
        exit(1);
    }
}

function pg_activate_plugin_file(string $plugin_file, bool $network_wide): void {
    if (!function_exists('plugin_basename') || !function_exists('do_action')) {
        pg_log('NOTICE:cannot activate plugin entry before WordPress plugin API is available: ' . $plugin_file);
        return;
    }
    $plugin_basename = plugin_basename($plugin_file);
    pg_log('PLUGIN_ACTIVATE ' . $plugin_basename . ($network_wide ? ' network_wide=1' : ''));
    pg_log('PLUGIN_ACTIVATE_BEGIN ' . $plugin_basename . ' ' . pg_diagnostic_context());
    do_action('activate_' . $plugin_basename, $network_wide);
    pg_mark_plugin_active($plugin_basename, $network_wide);
    do_action('activated_plugin', $plugin_basename, false, $network_wide);
    pg_log('PLUGIN_ACTIVATE_OK ' . $plugin_basename . ' ' . pg_diagnostic_context());
}

function pg_mark_plugin_active(string $plugin_basename, bool $network_wide): void {
    if ($network_wide && function_exists('get_site_option') && function_exists('update_site_option')) {
        $active_plugins = (array) get_site_option('active_sitewide_plugins', array());
        $active_plugins[$plugin_basename] = time();
        update_site_option('active_sitewide_plugins', $active_plugins);
        return;
    }
    if (!function_exists('get_option') || !function_exists('update_option')) {
        return;
    }
    $active_plugins = (array) get_option('active_plugins', array());
    if (!in_array($plugin_basename, $active_plugins, true)) {
        $active_plugins[] = $plugin_basename;
        sort($active_plugins);
        update_option('active_plugins', array_values($active_plugins));
    }
}

function pg_filter_changed_test_files(array $test_files, string $changed_files_json, string $plugin_path): array {
    $decoded = json_decode($changed_files_json, true);
    if (!is_array($decoded) || empty($decoded)) {
        return $test_files;
    }
    $wanted = array();
    foreach ($decoded as $entry) {
        if (!is_scalar($entry)) {
            continue;
        }
        $normalized = pg_component_relative_path((string) $entry, $plugin_path);
        if ($normalized !== '') {
            $wanted[$normalized] = true;
        }
    }
    if (empty($wanted)) {
        pg_log('NOTICE:changed tests did not contain usable test paths');
        return array();
    }
    $filtered = array();
    foreach ($test_files as $file) {
        if (isset($wanted[pg_component_relative_path((string) $file, $plugin_path)])) {
            $filtered[] = $file;
        }
    }
    pg_log('SCOPED_TEST_FILES requested=' . count($wanted) . ' matched=' . count($filtered));
    return $filtered;
}

function pg_component_relative_path(string $path, string $plugin_path): string {
    $path = trim(str_replace('\\\\', '/', $path));
    $plugin_path = rtrim(str_replace('\\\\', '/', $plugin_path), '/');
    if (strpos($path, $plugin_path . '/') === 0) {
        $path = substr($path, strlen($plugin_path) + 1);
    } elseif (strpos($path, '/tests/') !== false) {
        $path = substr($path, strpos($path, '/tests/') + 1);
    }
    while (strpos($path, './') === 0) {
        $path = substr($path, 2);
    }
    return ltrim($path, '/');
}

pg_install_diagnostics_handlers();

if (is_array($bench_env)) {
    foreach ($bench_env as $name => $value) {
        if (is_string($name) && preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name)) {
            $string_value = is_scalar($value) ? (string) $value : json_encode($value);
            putenv($name . '=' . $string_value);
            $_ENV[$name] = $string_value;
        } else {
            pg_log('NOTICE: skipping invalid bench_env key: ' . var_export($name, true));
        }
    }
}

if (!is_array($wp_config_defines)) {
    $wp_config_defines = array();
}
if ($multisite) {
    $wp_config_defines += array(
        'WP_TESTS_MULTISITE' => true,
        'MULTISITE' => true,
        'SUBDOMAIN_INSTALL' => false,
        'DOMAIN_CURRENT_SITE' => 'example.org',
        'PATH_CURRENT_SITE' => '/',
        'SITE_ID_CURRENT_SITE' => 1,
        'BLOG_ID_CURRENT_SITE' => 1,
    );
    putenv('WP_MULTISITE=1');
    $_ENV['WP_MULTISITE'] = '1';
}

$config_path = pg_run_boot_stage(array('extra_defines' => $wp_config_defines));
$pre_component_plugins_loaded_callbacks = pg_snapshot_wordpress_hook_callbacks('plugins_loaded');
$pre_component_init_callbacks = pg_snapshot_wordpress_hook_callbacks('init');
$pre_component_shutdown_callbacks = pg_snapshot_wordpress_hook_callbacks('shutdown');
$deferred_install_plugins_loaded_callbacks = array();
$deferred_install_init_callbacks = array();
$loaded_dep_files = array();
$loaded_component_file = null;

require_once $tests_dir . '/includes/functions.php';
tests_add_filter('muplugins_loaded', function () use ($plugin_path, $dep_mounts, $pre_component_plugins_loaded_callbacks, $pre_component_init_callbacks, &$deferred_install_plugins_loaded_callbacks, &$deferred_install_init_callbacks, &$loaded_dep_files, &$loaded_component_file) {
    $loaded_dep_files = pg_run_load_deps_stage(array('dep_mounts' => $dep_mounts));
    $loaded_component_file = pg_run_load_component_stage(array('plugin_path' => $plugin_path, 'activate' => false));
    $deferred_install_plugins_loaded_callbacks = pg_defer_new_wordpress_hook_callbacks('plugins_loaded', $pre_component_plugins_loaded_callbacks);
    $deferred_install_init_callbacks = pg_defer_new_wordpress_hook_callbacks('init', $pre_component_init_callbacks);
});

pg_run_install_stage(array('config_path' => $config_path, 'tests_dir' => $tests_dir, 'multisite' => $multisite));
pg_remove_new_wordpress_hook_callbacks('shutdown', $pre_component_shutdown_callbacks);
$activation_files = $loaded_dep_files;
if ($loaded_component_file !== null) {
    $activation_files[] = $loaded_component_file;
}
pg_run_activation_stage(array('plugin_files' => $activation_files, 'multisite' => $multisite));

$pre_replayed_plugins_loaded_init_callbacks = pg_snapshot_wordpress_hook_callbacks('init');
$reopened_ability_categories_init = pg_reopen_wordpress_action('wp_abilities_api_categories_init');
$reopened_ability_init = pg_reopen_wordpress_action('wp_abilities_api_init');
pg_run_deferred_wordpress_hook_callbacks($deferred_install_plugins_loaded_callbacks, array(), 'plugins_loaded');
$deferred_install_init_callbacks = array_merge($deferred_install_init_callbacks, pg_defer_new_wordpress_hook_callbacks('init', $pre_replayed_plugins_loaded_init_callbacks));
usort($deferred_install_init_callbacks, static function (array $left, array $right): int {
    return ($left['priority'] ?? 10) <=> ($right['priority'] ?? 10);
});
pg_run_deferred_wordpress_hook_callbacks($deferred_install_init_callbacks, array(), 'init');
pg_fire_reopened_wordpress_action('wp_abilities_api_categories_init', $reopened_ability_categories_init);
pg_fire_reopened_wordpress_action('wp_abilities_api_init', $reopened_ability_init);

pg_stage_begin('load_fixtures');
try {
    global $phpmailer;
    require_once $tests_dir . '/includes/mock-mailer.php';
    $phpmailer = new MockPHPMailer(true);
    require_once $tests_dir . '/includes/functions.php';
    $GLOBALS['_wp_die_disabled'] = false;
    tests_add_filter('wp_die_handler', '_wp_die_handler_filter');
    tests_add_filter('wp_rest_server_class', '_wp_rest_server_class_filter');
    tests_add_filter('async_update_translation', '__return_false');
    tests_add_filter('automatic_updater_disabled', '__return_true');
    foreach (array('phpunit6/compat.php', 'phpunit-adapter-testcase.php', 'abstract-testcase.php', 'testcase.php', 'testcase-rest-api.php', 'testcase-rest-controller.php', 'testcase-rest-post-type-controller.php', 'testcase-xmlrpc.php', 'testcase-ajax.php', 'testcase-canonical.php', 'testcase-xml.php', 'exceptions.php', 'utils.php', 'spy-rest-server.php', 'class-wp-rest-test-search-handler.php', 'class-wp-rest-test-configurable-controller.php', 'class-wp-fake-block-type.php', 'class-wp-fake-hasher.php', 'class-wp-sitemaps-test-provider.php', 'class-wp-sitemaps-empty-test-provider.php', 'class-wp-sitemaps-large-test-provider.php') as $file) {
        require_once $tests_dir . '/includes/' . $file;
    }
    pg_stage_ok('load_fixtures');
} catch (Throwable $e) {
    pg_stage_fail('load_fixtures', $e);
    exit(1);
}

function wp_codebox_phpunit_parse_config($xml_path, $test_dir_default) {
    $directories = array($test_dir_default);
    $suffixes = array('Test.php');
    $prefixes = array('test-');
    $excludes = array();
    if (!is_readable($xml_path) && basename($xml_path) === 'phpunit.xml.dist') {
        $alternate = dirname($xml_path) . '/phpunit.xml';
        if (is_readable($alternate)) {
            $xml_path = $alternate;
        }
    }
    if (!is_readable($xml_path)) {
        pg_log('NOTICE:phpunit.xml.dist not readable at ' . $xml_path . '; using defaults');
        return array($directories, $suffixes, $prefixes, $excludes);
    }
    $prev = libxml_use_internal_errors(true);
    $xml = @simplexml_load_file($xml_path);
    $errors = libxml_get_errors();
    libxml_clear_errors();
    libxml_use_internal_errors($prev);
    if ($xml === false) {
        $first = $errors ? trim($errors[0]->message) : 'unknown';
        pg_log('NOTICE:phpunit.xml.dist parse failed (' . $first . '); using defaults');
        return array($directories, $suffixes, $prefixes, $excludes);
    }
    $plugin_base = dirname($test_dir_default);
    $config_dirs = array();
    $config_suffixes = array();
    $config_prefixes = array();
    foreach ($xml->xpath('//testsuite/directory') ?: array() as $dir) {
        $raw = trim((string) $dir);
        $normalized = trim(str_replace('\\\\', '/', $raw), '/');
        if ($raw === '' || ($normalized !== 'tests' && strpos($normalized, 'tests/') !== 0)) {
            continue;
        }
        $config_dirs[] = $raw[0] === '/' ? rtrim($raw, '/') : rtrim($plugin_base . '/' . $raw, '/');
        foreach (explode(',', (string) ($dir['suffix'] ?? '')) as $suffix) {
            $suffix = trim($suffix);
            if ($suffix !== '') {
                $config_suffixes[] = $suffix;
            }
        }
        foreach (explode(',', (string) ($dir['prefix'] ?? '')) as $prefix) {
            $prefix = trim($prefix);
            if ($prefix !== '') {
                $config_prefixes[] = $prefix;
            }
        }
    }
    foreach ($xml->xpath('//testsuite/exclude') ?: array() as $exclude) {
        $raw = trim((string) $exclude);
        if ($raw !== '') {
            $excludes[] = $raw[0] === '/' ? rtrim($raw, '/') : rtrim($plugin_base . '/' . $raw, '/');
        }
    }
    if (!empty($config_dirs)) {
        $directories = $config_dirs;
        pg_log('NOTICE:phpunit.xml.dist loaded from ' . $xml_path);
    }
    if (!empty($config_suffixes)) {
        $suffixes = $config_suffixes;
    }
    if (!empty($config_prefixes)) {
        $prefixes = $config_prefixes;
    }
    return array($directories, $suffixes, $prefixes, $excludes);
}

function wp_codebox_phpunit_discover(array $directories, array $suffixes, array $prefixes, array $excludes) {
    $found = array();
    foreach ($directories as $dir) {
        if (!is_dir($dir)) {
            pg_log('NOTICE:test directory does not exist: ' . $dir);
            continue;
        }
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
        foreach ($iterator as $file) {
            if (!$file->isFile() || $file->getExtension() !== 'php') {
                continue;
            }
            $path = $file->getPathname();
            foreach ($excludes as $exclude) {
                if (strpos($path, $exclude) === 0) {
                    continue 2;
                }
            }
            $base = $file->getBasename();
            $matches = false;
            foreach ($suffixes as $suffix) {
                if ($suffix !== '' && substr($base, -strlen($suffix)) === $suffix) {
                    $matches = true;
                    break;
                }
            }
            if (!$matches) {
                foreach ($prefixes as $prefix) {
                    if ($prefix !== '' && strpos($base, $prefix) === 0) {
                        $matches = true;
                        break;
                    }
                }
            }
            if ($matches) {
                $found[] = $path;
            }
        }
    }
    sort($found);
    return array_values(array_unique($found));
}

pg_stage_begin('discover_tests');
try {
    $test_dir = $plugin_path . '/tests';
    if (!is_dir($test_dir)) {
        pg_log('NO_TEST_FILES');
        pg_log('NOTICE:tests directory not found at ' . $test_dir);
        pg_stage_ok('discover_tests');
        exit(1);
    }
    list($directories, $suffixes, $prefixes, $excludes) = wp_codebox_phpunit_parse_config(${JSON.stringify(options.phpunitXml)}, $test_dir);
    $test_files = wp_codebox_phpunit_discover($directories, $suffixes, $prefixes, $excludes);
    $test_files = pg_filter_changed_test_files($test_files, $changed_test_files_raw, $plugin_path);
    if ($selected_test_file !== '') {
        $selected_abs = $plugin_path . '/' . ltrim($selected_test_file, '/');
        if (!in_array($selected_abs, $test_files, true)) {
            pg_log('NO_TEST_FILES');
            pg_log('NOTICE:requested PHPUnit test file not discovered: ' . $selected_test_file);
            pg_stage_ok('discover_tests');
            exit(1);
        }
        $test_files = array($selected_abs);
    }
    pg_log('DISCOVERY: dirs=' . implode(',', $directories) . ' suffixes=' . implode(',', $suffixes) . ' prefixes=' . implode(',', $prefixes) . ' excludes=' . count($excludes) . ' found=' . count($test_files));
    if (empty($test_files)) {
        pg_log('NO_TEST_FILES');
        pg_stage_ok('discover_tests');
        exit(1);
    }
    pg_stage_ok('discover_tests');
} catch (Throwable $e) {
    pg_stage_fail('discover_tests', $e);
    exit(1);
}

pg_stage_begin('load_tests');
$suite = new PHPUnit\\Framework\\TestSuite('WP Codebox PHPUnit Tests');
$before_classes = get_declared_classes();
try {
    foreach ($test_files as $test_file) {
        require_once $test_file;
    }
} catch (Throwable $e) {
    pg_stage_fail('load_tests', $e);
    exit(1);
}
$after_classes = get_declared_classes();
foreach (array_diff($after_classes, $before_classes) as $class_name) {
    try {
        $ref = new ReflectionClass($class_name);
        if (!$ref->isAbstract() && $ref->isSubclassOf('PHPUnit\\Framework\\TestCase')) {
            $suite->addTestSuite($class_name);
        }
    } catch (Throwable $e) {
        pg_log('NOTICE:reflection failed for ' . $class_name . ': ' . $e->getMessage());
    }
}
pg_stage_ok('load_tests');

function wp_codebox_phpunit_args(array $argv) {
    $arguments = array('colors' => 'never', 'testdox' => true, 'verbose' => false, 'extensions' => array());
    $args = array_slice($argv, 1);
    for ($i = 0; $i < count($args); $i++) {
        $arg = $args[$i];
        if ($arg === '--filter' && isset($args[$i + 1])) {
            $arguments['filter'] = $args[++$i];
            pg_log('NOTICE:phpunit filter applied: ' . $arguments['filter']);
            continue;
        }
        if (strpos($arg, '--filter=') === 0) {
            $arguments['filter'] = substr($arg, strlen('--filter='));
            pg_log('NOTICE:phpunit filter applied: ' . $arguments['filter']);
            continue;
        }
        if ($arg === '--list-tests') {
            $arguments['listTests'] = true;
            continue;
        }
        if ($arg === '--no-testdox') {
            $arguments['testdox'] = false;
            continue;
        }
        if ($arg === '--verbose' || $arg === '-v') {
            $arguments['verbose'] = true;
            continue;
        }
    }
    return $arguments;
}

function wp_codebox_phpunit_print_test_list($test) {
    if ($test instanceof PHPUnit\\Framework\\TestSuite) {
        foreach ($test->tests() as $child) {
            wp_codebox_phpunit_print_test_list($child);
        }
        return;
    }
    if ($test instanceof PHPUnit\\Framework\\TestCase) {
        echo get_class($test) . '::' . $test->getName() . PHP_EOL;
    }
}

pg_stage_begin('run_tests');
pg_log('RUNNING ' . count($test_files) . ' TEST FILES');
try {
    $phpunit_args = wp_codebox_phpunit_args($argv ?? array());
    if (!empty($phpunit_args['listTests'])) {
        wp_codebox_phpunit_print_test_list($suite);
        pg_log('ALL TESTS PASSED');
        pg_log('TESTS: ' . $suite->count() . ' FAILURES: 0 ERRORS: 0');
        pg_stage_ok('run_tests');
        exit(0);
    }
    $runner = new PHPUnit\\TextUI\\TestRunner();
    $result = $runner->run($suite, $phpunit_args);
    pg_log($result->wasSuccessful() ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
    pg_log('TESTS: ' . $result->count() . ' FAILURES: ' . count($result->failures()) . ' ERRORS: ' . count($result->errors()));
    pg_stage_ok('run_tests');
    exit($result->wasSuccessful() ? 0 : 1);
} catch (Throwable $e) {
    pg_stage_fail('run_tests', $e);
    exit(1);
}`
}

export function corePhpunitRunCode(options: CorePhpunitRunCodeOptions): string {
  return `error_reporting(E_ALL);
ini_set('display_errors', '1');
ini_set('display_startup_errors', '1');

$core_root = rtrim(${JSON.stringify(options.coreRoot)}, '/');
$tests_dir = rtrim(${JSON.stringify(options.testsDir)}, '/');
$phpunit_xml = ${JSON.stringify(options.phpunitXml)};
$selected_test_file = ${JSON.stringify(options.selectedTestFile)};
$changed_test_files_raw = ${JSON.stringify(JSON.stringify(options.changedTestFiles))};
$autoload_file = ${JSON.stringify(options.autoloadFile)};
$wp_config_defines = json_decode(${JSON.stringify(JSON.stringify(options.wpConfigDefines))}, true);
$multisite = ${JSON.stringify(options.multisite)};
$result_file = $core_root . '/.pg-test-result.txt';
$current_stage = 'preboot';

function core_pg_log($msg) {
    global $result_file;
    file_put_contents($result_file, $msg . "\n", FILE_APPEND);
}

function core_pg_stage_begin($stage) {
    global $current_stage;
    $current_stage = $stage;
    core_pg_log('STAGE_BEGIN:' . $stage);
}

function core_pg_stage_ok($stage) {
    core_pg_log('STAGE_OK:' . $stage);
}

function core_pg_stage_fail($stage, Throwable $e) {
    core_pg_log('STAGE_FAIL:' . $stage . ':' . get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine());
    core_pg_log('TRACE:');
    foreach (explode("\n", $e->getTraceAsString()) as $line) {
        core_pg_log('  ' . $line);
    }
}

function core_pg_install_diagnostics_handlers() {
    set_error_handler(function ($severity, $message, $file, $line) {
        if (!(error_reporting() & $severity)) {
            return false;
        }
        core_pg_log('NOTICE:E_' . $severity . ': ' . $message . ' at ' . $file . ':' . $line);
        return false;
    });
    register_shutdown_function(function () {
        global $current_stage;
        $error = error_get_last();
        if ($error && in_array($error['type'], array(E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR), true)) {
            core_pg_log('STAGE_FATAL:' . $current_stage . ':' . $error['message'] . ' at ' . $error['file'] . ':' . $error['line']);
        }
    });
}

function core_pg_write_tests_config(string $core_root, array $extra_defines): string {
    $config_path = $core_root . '/wp-tests-config.php';
    if (is_readable($config_path)) {
        return $config_path;
    }

    $config = "<?php\n";
    foreach ($extra_defines as $name => $value) {
        if (is_string($name) && preg_match('/^[A-Z_][A-Z0-9_]*$/i', $name)) {
            $config .= sprintf("if (!defined('%s')) { define('%s', %s); }\n", $name, $name, var_export($value, true));
        }
    }
    $config .= "\n";
    $config .= "define('DB_NAME', ':memory:');\n";
    $config .= "define('DB_USER', 'root');\n";
    $config .= "define('DB_PASSWORD', '');\n";
    $config .= "define('DB_HOST', 'localhost');\n";
    $config .= "define('DB_CHARSET', 'utf8');\n";
    $config .= "define('DB_COLLATE', '');\n";
    $config .= "define('WP_TESTS_DOMAIN', 'example.org');\n";
    $config .= "define('WP_TESTS_EMAIL', 'admin@example.org');\n";
    $config .= "define('WP_TESTS_TITLE', 'Test Blog');\n";
    $config .= "define('WP_PHP_BINARY', 'php');\n";
    $config .= "define('WP_RUN_CORE_TESTS', true);\n";
    $config .= "define('ABSPATH', '" . addslashes($core_root) . "/');\n";
    $config .= "define('FS_METHOD', 'direct');\n";
    $config .= "\$table_prefix = 'wptests_';\n";
    file_put_contents($config_path, $config);

    return $config_path;
}

function core_pg_parse_phpunit_config(string $xml_path, string $default_dir): array {
    $directories = array($default_dir);
    $suffixes = array('Test.php');
    $prefixes = array('test-');
    $excludes = array();
    if (!is_readable($xml_path)) {
        core_pg_log('NOTICE:phpunit config not readable at ' . $xml_path . '; using defaults');
        return array($directories, $suffixes, $prefixes, $excludes);
    }
    $xml = @simplexml_load_file($xml_path);
    if ($xml === false) {
        core_pg_log('NOTICE:phpunit config parse failed; using defaults');
        return array($directories, $suffixes, $prefixes, $excludes);
    }
    $base = dirname($xml_path);
    $config_dirs = array();
    foreach ($xml->xpath('//testsuite/directory') ?: array() as $dir) {
        $raw = trim((string) $dir);
        if ($raw === '') {
            continue;
        }
        $config_dirs[] = $raw[0] === '/' ? rtrim($raw, '/') : rtrim($base . '/' . $raw, '/');
        foreach (explode(',', (string) ($dir['suffix'] ?? '')) as $suffix) {
            $suffix = trim($suffix);
            if ($suffix !== '') {
                $suffixes[] = $suffix;
            }
        }
        foreach (explode(',', (string) ($dir['prefix'] ?? '')) as $prefix) {
            $prefix = trim($prefix);
            if ($prefix !== '') {
                $prefixes[] = $prefix;
            }
        }
    }
    foreach ($xml->xpath('//testsuite/exclude') ?: array() as $exclude) {
        $raw = trim((string) $exclude);
        if ($raw !== '') {
            $excludes[] = $raw[0] === '/' ? rtrim($raw, '/') : rtrim($base . '/' . $raw, '/');
        }
    }
    if (!empty($config_dirs)) {
        $directories = $config_dirs;
        core_pg_log('NOTICE:phpunit config loaded from ' . $xml_path);
    }
    return array(array_values(array_unique($directories)), array_values(array_unique($suffixes)), array_values(array_unique($prefixes)), $excludes);
}

function core_pg_discover_tests(array $directories, array $suffixes, array $prefixes, array $excludes): array {
    $found = array();
    foreach ($directories as $dir) {
        if (!is_dir($dir)) {
            core_pg_log('NOTICE:test directory does not exist: ' . $dir);
            continue;
        }
        $iterator = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($dir, RecursiveDirectoryIterator::SKIP_DOTS), RecursiveIteratorIterator::LEAVES_ONLY);
        foreach ($iterator as $file) {
            if (!$file->isFile() || $file->getExtension() !== 'php') {
                continue;
            }
            $path = $file->getPathname();
            foreach ($excludes as $exclude) {
                if (strpos($path, $exclude) === 0) {
                    continue 2;
                }
            }
            $base = $file->getBasename();
            $matches = false;
            foreach ($suffixes as $suffix) {
                if ($suffix !== '' && substr($base, -strlen($suffix)) === $suffix) {
                    $matches = true;
                    break;
                }
            }
            if (!$matches) {
                foreach ($prefixes as $prefix) {
                    if ($prefix !== '' && strpos($base, $prefix) === 0) {
                        $matches = true;
                        break;
                    }
                }
            }
            if ($matches) {
                $found[] = $path;
            }
        }
    }
    sort($found);
    return array_values(array_unique($found));
}

function core_pg_relative_path(string $path, string $core_root): string {
    $path = trim(str_replace('\\\\', '/', $path));
    $core_root = rtrim(str_replace('\\\\', '/', $core_root), '/');
    if (strpos($path, $core_root . '/') === 0) {
        $path = substr($path, strlen($core_root) + 1);
    }
    while (strpos($path, './') === 0) {
        $path = substr($path, 2);
    }
    return ltrim($path, '/');
}

function core_pg_filter_changed_test_files(array $test_files, string $changed_files_json, string $core_root): array {
    $decoded = json_decode($changed_files_json, true);
    if (!is_array($decoded) || empty($decoded)) {
        return $test_files;
    }
    $wanted = array();
    foreach ($decoded as $entry) {
        if (is_scalar($entry)) {
            $wanted[core_pg_relative_path((string) $entry, $core_root)] = true;
        }
    }
    $filtered = array();
    foreach ($test_files as $file) {
        if (isset($wanted[core_pg_relative_path((string) $file, $core_root)])) {
            $filtered[] = $file;
        }
    }
    core_pg_log('SCOPED_TEST_FILES requested=' . count($wanted) . ' matched=' . count($filtered));
    return $filtered;
}

function core_pg_phpunit_args(array $argv) {
    $arguments = array('colors' => 'never', 'testdox' => true, 'verbose' => false, 'extensions' => array());
    $args = array_slice($argv, 1);
    for ($i = 0; $i < count($args); $i++) {
        $arg = $args[$i];
        if ($arg === '--filter' && isset($args[$i + 1])) {
            $arguments['filter'] = $args[++$i];
            core_pg_log('NOTICE:phpunit filter applied: ' . $arguments['filter']);
            continue;
        }
        if (strpos($arg, '--filter=') === 0) {
            $arguments['filter'] = substr($arg, strlen('--filter='));
            core_pg_log('NOTICE:phpunit filter applied: ' . $arguments['filter']);
            continue;
        }
        if ($arg === '--list-tests') {
            $arguments['listTests'] = true;
            continue;
        }
        if ($arg === '--no-testdox') {
            $arguments['testdox'] = false;
            continue;
        }
        if ($arg === '--verbose' || $arg === '-v') {
            $arguments['verbose'] = true;
            continue;
        }
    }
    return $arguments;
}

core_pg_install_diagnostics_handlers();

core_pg_stage_begin('boot');
try {
    if (!is_readable($autoload_file)) {
        throw new RuntimeException('core PHPUnit autoload file is not readable: ' . $autoload_file);
    }
    if (!is_dir($core_root)) {
        throw new RuntimeException('core root is not a directory: ' . $core_root);
    }
    if (!is_dir($tests_dir)) {
        throw new RuntimeException('core tests directory is not a directory: ' . $tests_dir);
    }
    if (!is_array($wp_config_defines)) {
        $wp_config_defines = array();
    }
    if ($multisite) {
        $wp_config_defines += array(
            'WP_TESTS_MULTISITE' => true,
            'MULTISITE' => true,
            'SUBDOMAIN_INSTALL' => false,
            'DOMAIN_CURRENT_SITE' => 'example.org',
            'PATH_CURRENT_SITE' => '/',
            'SITE_ID_CURRENT_SITE' => 1,
            'BLOG_ID_CURRENT_SITE' => 1,
        );
        putenv('WP_MULTISITE=1');
        $_ENV['WP_MULTISITE'] = '1';
    }
    require_once $autoload_file;
    $config_path = core_pg_write_tests_config($core_root, $wp_config_defines);
    define('WP_TESTS_CONFIG_FILE_PATH', $config_path);
    core_pg_stage_ok('boot');
} catch (Throwable $e) {
    core_pg_stage_fail('boot', $e);
    exit(1);
}

core_pg_stage_begin('bootstrap');
try {
    require_once $tests_dir . '/includes/bootstrap.php';
    core_pg_stage_ok('bootstrap');
} catch (Throwable $e) {
    core_pg_stage_fail('bootstrap', $e);
    exit(1);
}

core_pg_stage_begin('discover_tests');
try {
    list($directories, $suffixes, $prefixes, $excludes) = core_pg_parse_phpunit_config($phpunit_xml, $tests_dir . '/tests');
    $test_files = core_pg_discover_tests($directories, $suffixes, $prefixes, $excludes);
    $test_files = core_pg_filter_changed_test_files($test_files, $changed_test_files_raw, $core_root);
    if ($selected_test_file !== '') {
        $selected_abs = $selected_test_file[0] === '/' ? $selected_test_file : $core_root . '/' . ltrim($selected_test_file, '/');
        if (!in_array($selected_abs, $test_files, true)) {
            core_pg_log('NO_TEST_FILES');
            core_pg_log('NOTICE:requested PHPUnit test file not discovered: ' . $selected_test_file);
            core_pg_stage_ok('discover_tests');
            exit(1);
        }
        $test_files = array($selected_abs);
    }
    core_pg_log('DISCOVERY: dirs=' . implode(',', $directories) . ' suffixes=' . implode(',', $suffixes) . ' prefixes=' . implode(',', $prefixes) . ' excludes=' . count($excludes) . ' found=' . count($test_files));
    if (empty($test_files)) {
        core_pg_log('NO_TEST_FILES');
        core_pg_stage_ok('discover_tests');
        exit(1);
    }
    core_pg_stage_ok('discover_tests');
} catch (Throwable $e) {
    core_pg_stage_fail('discover_tests', $e);
    exit(1);
}

core_pg_stage_begin('load_tests');
$suite = new PHPUnit\\Framework\\TestSuite('WP Codebox WordPress Core Tests');
$before_classes = get_declared_classes();
try {
    foreach ($test_files as $test_file) {
        require_once $test_file;
    }
} catch (Throwable $e) {
    core_pg_stage_fail('load_tests', $e);
    exit(1);
}
$after_classes = get_declared_classes();
foreach (array_diff($after_classes, $before_classes) as $class_name) {
    try {
        $ref = new ReflectionClass($class_name);
        if (!$ref->isAbstract() && $ref->isSubclassOf('PHPUnit\\Framework\\TestCase')) {
            $suite->addTestSuite($class_name);
        }
    } catch (Throwable $e) {
        core_pg_log('NOTICE:reflection failed for ' . $class_name . ': ' . $e->getMessage());
    }
}
core_pg_stage_ok('load_tests');

core_pg_stage_begin('run_tests');
core_pg_log('RUNNING ' . count($test_files) . ' TEST FILES');
try {
    $phpunit_args = core_pg_phpunit_args($argv ?? array());
    $runner = new PHPUnit\\TextUI\\TestRunner();
    $result = $runner->run($suite, $phpunit_args);
    core_pg_log($result->wasSuccessful() ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED');
    core_pg_log('TESTS: ' . $result->count() . ' FAILURES: ' . count($result->failures()) . ' ERRORS: ' . count($result->errors()));
    core_pg_stage_ok('run_tests');
    exit($result->wasSuccessful() ? 0 : 1);
} catch (Throwable $e) {
    core_pg_stage_fail('run_tests', $e);
    exit(1);
}`
}

export function benchRunCode(options: BenchRunCodeOptions): string {
  return `require_once ABSPATH . 'wp-admin/includes/plugin.php';

$component_id = ${JSON.stringify(options.componentId)};
$plugin_slug = ${JSON.stringify(options.pluginSlug)};
$plugin_path = WP_PLUGIN_DIR . '/' . $plugin_slug;
$iterations = max(1, (int) ${JSON.stringify(String(options.iterations))});
$warmup_iterations = max(0, (int) ${JSON.stringify(String(options.warmupIterations))});
$dependency_slugs = json_decode(${JSON.stringify(JSON.stringify(options.dependencySlugs))}, true);
$bench_env = json_decode(${JSON.stringify(JSON.stringify(options.env))}, true);
$configured_workloads = json_decode(${JSON.stringify(JSON.stringify(options.workloads))}, true);

if (is_array($bench_env)) {
    foreach ($bench_env as $name => $value) {
        if (is_string($name) && preg_match('/^[A-Za-z_][A-Za-z0-9_]*$/', $name)) {
            $string_value = is_scalar($value) ? (string) $value : wp_json_encode($value);
            putenv($name . '=' . $string_value);
            $_ENV[$name] = $string_value;
        }
    }
}

function wp_codebox_bench_percentile(array $samples, float $percentile): float {
    if (empty($samples)) {
        return 0.0;
    }

    sort($samples, SORT_NUMERIC);
    $index = (int) ceil($percentile * count($samples)) - 1;
    $index = max(0, min(count($samples) - 1, $index));
    return (float) $samples[$index];
}

function wp_codebox_bench_aggregate(array $samples, string $prefix = '', string $suffix = ''): array {
    sort($samples, SORT_NUMERIC);
    $count = count($samples);
    $sum = array_sum($samples);
    $key_prefix = $prefix === '' ? '' : $prefix . '_';

    return array(
        $key_prefix . 'mean' . $suffix => $count > 0 ? $sum / $count : 0.0,
        $key_prefix . 'p50' . $suffix => wp_codebox_bench_percentile($samples, 0.50),
        $key_prefix . 'p95' . $suffix => wp_codebox_bench_percentile($samples, 0.95),
        $key_prefix . 'p99' . $suffix => wp_codebox_bench_percentile($samples, 0.99),
        $key_prefix . 'min' . $suffix => $count > 0 ? (float) $samples[0] : 0.0,
        $key_prefix . 'max' . $suffix => $count > 0 ? (float) $samples[$count - 1] : 0.0,
    );
}

function wp_codebox_bench_record_payload($payload, array &$metric_samples, ?array &$metadata, ?array &$artifacts = null): void {
    if (!is_array($payload)) {
        return;
    }

    if (isset($payload['metadata']) && is_array($payload['metadata'])) {
        $metadata = $payload['metadata'];
    }

    if (isset($payload['artifacts']) && is_array($payload['artifacts'])) {
        $artifacts = $payload['artifacts'];
    }

    $metrics = array();
    if (isset($payload['metrics']) && is_array($payload['metrics'])) {
        $metrics = $payload['metrics'];
    } else {
        $metrics = $payload;
        unset($metrics['metadata'], $metrics['artifacts']);
    }

    foreach ($metrics as $name => $value) {
        if (!is_string($name) || $name === '' || !is_numeric($value)) {
            continue;
        }

        $sample = (float) $value;
        if (is_finite($sample)) {
            $metric_samples[$name][] = $sample;
        }
    }
}

$plugins_to_activate = array();
foreach (is_array($dependency_slugs) ? $dependency_slugs : array() as $dependency_slug) {
    $dependency_slug = sanitize_key((string) $dependency_slug);
    $dependency_file = WP_PLUGIN_DIR . '/' . $dependency_slug . '/' . $dependency_slug . '.php';
    if (file_exists($dependency_file)) {
        $plugins_to_activate[] = $dependency_slug . '/' . $dependency_slug . '.php';
    }
}
$plugin_file = $plugin_path . '/' . $plugin_slug . '.php';
if (file_exists($plugin_file)) {
    $plugins_to_activate[] = $plugin_slug . '/' . $plugin_slug . '.php';
}
foreach ($plugins_to_activate as $plugin_to_activate) {
    if (is_plugin_active($plugin_to_activate)) {
        continue;
    }
    $activation = activate_plugin($plugin_to_activate);
    if (is_wp_error($activation)) {
        throw new RuntimeException($activation->get_error_message());
    }
}

function wp_codebox_bench_run_configured_workload(array $workload, string $plugin_path) {
    $steps = isset($workload['run']) && is_array($workload['run']) ? $workload['run'] : array($workload);
    $payload = array('metrics' => array(), 'metadata' => array(), 'artifacts' => array());
    if (isset($workload['metadata']) && is_array($workload['metadata'])) {
        $payload['metadata'] = array_merge($payload['metadata'], $workload['metadata']);
    }
    if (isset($workload['artifacts']) && is_array($workload['artifacts'])) {
        $payload['artifacts'] = array_merge($payload['artifacts'], $workload['artifacts']);
    }
    foreach ($steps as $step) {
        if (!is_array($step)) {
            continue;
        }
        $type = isset($step['type']) ? (string) $step['type'] : 'php';
        if ($type === 'php') {
            if (isset($step['file']) && is_string($step['file'])) {
                $file = $plugin_path . '/' . ltrim($step['file'], '/');
                $callable = require $file;
                $result = is_callable($callable) ? $callable() : $callable;
            } else {
                $result = null;
                $code = isset($step['code']) && is_string($step['code']) ? $step['code'] : '';
                if ($code !== '') {
                    $runner = static function () use ($code, &$result): void {
                        $result = eval($code);
                    };
                    $runner();
                }
            }
        } elseif ($type === 'ability') {
            if (!function_exists('wp_get_ability')) {
                throw new RuntimeException('The WordPress Abilities API is not available in this runtime.');
            }
            $ability_name = isset($step['name']) ? (string) $step['name'] : (isset($step['ability']) ? (string) $step['ability'] : '');
            $ability = wp_get_ability($ability_name);
            if (!$ability) {
                throw new RuntimeException('Ability is not registered: ' . $ability_name);
            }
            $result = $ability->execute(isset($step['input']) && is_array($step['input']) ? $step['input'] : array());
            if (is_wp_error($result)) {
                throw new RuntimeException($result->get_error_message());
            }
        } elseif ($type === 'wp-cli') {
            if (!class_exists('WP_CLI')) {
                throw new RuntimeException('WP-CLI is not loaded inside wordpress.bench yet.');
            }
            $command = isset($step['command']) ? (string) $step['command'] : '';
            $result = WP_CLI::runcommand($command, array('return' => true, 'launch' => false, 'parse' => 'json'));
        } else {
            throw new RuntimeException('Unsupported bench workload step type: ' . $type);
        }
        if (is_array($result)) {
            if (isset($result['metrics']) && is_array($result['metrics'])) {
                $payload['metrics'] = array_merge($payload['metrics'], $result['metrics']);
            }
            if (isset($result['metadata']) && is_array($result['metadata'])) {
                $payload['metadata'] = array_merge($payload['metadata'], $result['metadata']);
            }
            if (isset($result['artifacts']) && is_array($result['artifacts'])) {
                $payload['artifacts'] = array_merge($payload['artifacts'], $result['artifacts']);
            }
        }
    }
    return $payload;
}

$bench_dir = $plugin_path . '/tests/bench';
$workload_files = is_dir($bench_dir) ? glob($bench_dir . '/*.php') : array();
sort($workload_files, SORT_STRING);

$scenarios = array();
foreach ($workload_files as $workload_file) {
    $callable = require $workload_file;
    if (!is_callable($callable)) {
        continue;
    }

    $timings = array();
    $metric_samples = array();
    $metadata = null;
    $artifacts = null;
    $artifacts = null;

    if (function_exists('memory_reset_peak_usage')) {
        memory_reset_peak_usage();
    }

    $total_iterations = $iterations + $warmup_iterations;
    for ($i = 0; $i < $total_iterations; $i++) {
        $is_warmup = $i < $warmup_iterations;
        $started = hrtime(true);
        $payload = $callable();
        $elapsed_ms = (hrtime(true) - $started) / 1000000;

        if (!$is_warmup) {
            $timings[] = $elapsed_ms;
            wp_codebox_bench_record_payload($payload, $metric_samples, $metadata, $artifacts);
        }
    }

    $metrics = wp_codebox_bench_aggregate($timings, '', '_ms');
    ksort($metric_samples);
    foreach ($metric_samples as $metric => $samples) {
        $metrics += wp_codebox_bench_aggregate($samples, $metric);
    }

    $relative_file = substr($workload_file, strlen($plugin_path) + 1);
    $scenario = array(
        'id' => preg_replace('/\\.php$/', '', basename($workload_file)),
        'source' => 'in_tree',
        'file' => $relative_file,
        'iterations' => $iterations,
        'metrics' => $metrics,
        'memory' => array('peak_bytes' => memory_get_peak_usage(true)),
    );

    if (is_array($metadata) && !empty($metadata)) {
        $scenario['metadata'] = $metadata;
    }

    $scenarios[] = $scenario;
}

foreach (is_array($configured_workloads) ? $configured_workloads : array() as $index => $workload) {
    if (!is_array($workload)) {
        continue;
    }
    $scenario_id = isset($workload['id']) && is_string($workload['id']) ? $workload['id'] : 'configured-' . $index;
    $timings = array();
    $metric_samples = array();
    $metadata = null;
    $total_iterations = $iterations + $warmup_iterations;
    for ($i = 0; $i < $total_iterations; $i++) {
        $is_warmup = $i < $warmup_iterations;
        $started = hrtime(true);
        $payload = wp_codebox_bench_run_configured_workload($workload, $plugin_path);
        $elapsed_ms = (hrtime(true) - $started) / 1000000;
        if (!$is_warmup) {
            $timings[] = $elapsed_ms;
            wp_codebox_bench_record_payload($payload, $metric_samples, $metadata, $artifacts);
        }
    }
    $metrics = wp_codebox_bench_aggregate($timings, '', '_ms');
    ksort($metric_samples);
    foreach ($metric_samples as $metric => $samples) {
        $metrics += wp_codebox_bench_aggregate($samples, $metric);
    }
    $scenario = array(
        'id' => $scenario_id,
        'source' => 'config',
        'iterations' => $iterations,
        'metrics' => $metrics,
        'memory' => array('peak_bytes' => memory_get_peak_usage(true)),
    );
    if (is_array($metadata) && !empty($metadata)) {
        $scenario['metadata'] = $metadata;
    }
    if (is_array($artifacts) && !empty($artifacts)) {
        $scenario['artifacts'] = $artifacts;
    }
    $scenarios[] = $scenario;
}

echo wp_json_encode(array(
    'component_id' => $component_id,
    'iterations' => $iterations,
    'warmup_iterations' => $warmup_iterations,
    'scenarios' => $scenarios,
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);`
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

export function positiveIntegerArg(args: string[], name: string, fallback: number): number {
  const raw = argValue(args, name)
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function nonNegativeIntegerArg(args: string[], name: string, fallback: number): number {
  const raw = argValue(args, name)
  if (!raw) {
    return fallback
  }

  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback
}

export function booleanArg(args: string[], name: string, fallback = false): boolean {
  const raw = argValue(args, name)
  if (!raw) {
    return fallback
  }

  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase())
}

export function commaListArg(args: string[], name: string): string[] {
  return (argValue(args, name) ?? "").split(",").map((item) => item.trim()).filter(Boolean)
}

export function jsonObjectArg(args: string[], name: string): Record<string, unknown> {
  const raw = argValue(args, name)
  if (!raw) {
    return {}
  }

  const parsed = JSON.parse(raw)
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON object`)
  }

  return parsed as Record<string, unknown>
}

export function jsonArrayArg(args: string[], name: string): unknown[] {
  const raw = argValue(args, name)
  if (!raw) {
    return []
  }

  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) {
    throw new Error(`${name} must be a JSON array`)
  }

  return parsed
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
