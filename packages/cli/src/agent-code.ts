import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { SANDBOX_DMC_PARENT_ONLY_ABILITIES, SANDBOX_DMC_SAFE_ABILITIES, SANDBOX_WORKSPACE_ROOT } from "@chubes4/wp-codebox-core"

export interface AgentSandboxCodeOptions {
  task: string
  agent?: string
  mode?: string
  provider?: string
  model?: string
  sessionId?: string
  maxTurns?: string
  code?: string
  codeFile?: string
}

export async function resolveSandboxTaskCode(options: AgentSandboxCodeOptions): Promise<string> {
  if (options.agent) {
    return agentChatTaskCode(options)
  }

  if (options.code) {
    return options.code
  }

  if (options.codeFile) {
    return readFile(resolve(options.codeFile), "utf8")
  }

  return `echo json_encode(array('task_received' => true), JSON_PRETTY_PRINT);`
}

function agentChatTaskCode(options: AgentSandboxCodeOptions): string {
  const mode = options.mode ?? "sandbox"
  const agentModes = sandboxAgentModes(mode)
  const agentConfig = scopedAgentConfig(mode, options.provider, options.model)
  const input: Record<string, unknown> = {
    agent: options.agent,
    message: options.task,
    session_id: options.sessionId ?? null,
    mode,
    modes: agentModes,
    client_context: {
      source: "bridge",
      client_name: "wp-codebox",
      connector_id: "wp-codebox-cli",
      mode,
      agent_modes: agentModes,
      workspace_root: SANDBOX_WORKSPACE_ROOT,
      tool_contract: sandboxToolContract(),
    },
  }

  if (options.maxTurns) {
    input.max_turns = Number.parseInt(options.maxTurns, 10)
  }

  return `
if (function_exists('wp_set_current_user')) {
    wp_set_current_user(1);
}

if (!defined('DATAMACHINE_WORKSPACE_PATH')) {
    define('DATAMACHINE_WORKSPACE_PATH', ${JSON.stringify(SANDBOX_WORKSPACE_ROOT)});
}

add_filter('datamachine_code_remote_workspace_backend_should_handle', '__return_false', 100);

$sandbox_workspace_adoptions = array();
if (function_exists('wp_get_ability')) {
    $sandbox_adopt_callback = static function () use (&$sandbox_workspace_adoptions): void {
        $sandbox_adopt_ability = wp_get_ability('datamachine/workspace-adopt');
        if (!$sandbox_adopt_ability || !method_exists($sandbox_adopt_ability, 'execute')) {
            return;
        }
        foreach (glob(rtrim(DATAMACHINE_WORKSPACE_PATH, '/') . '/*', GLOB_ONLYDIR) ?: array() as $sandbox_workspace_dir) {
            $sandbox_workspace_name = basename($sandbox_workspace_dir);
            $sandbox_adopt_result = $sandbox_adopt_ability->execute(array(
                'path' => $sandbox_workspace_dir,
                'name' => $sandbox_workspace_name,
            ));
            $sandbox_workspace_adoptions[$sandbox_workspace_name] = is_wp_error($sandbox_adopt_result)
                ? array('success' => false, 'error' => $sandbox_adopt_result->get_error_message())
                : $sandbox_adopt_result;
        }
    };
    if (class_exists('DataMachine\\Abilities\\PermissionHelper')) {
        DataMachine\\Abilities\\PermissionHelper::run_as_authenticated($sandbox_adopt_callback, 1);
    } else {
        $sandbox_adopt_callback();
    }
}
$sandbox_stack['workspace_adoptions'] = $sandbox_workspace_adoptions;

if (class_exists('DataMachine\\Core\\Database\\Agents\\Agents')) {
    $sandbox_agent_slug = sanitize_title((string) (${JSON.stringify(input.agent)}));
    if ('' !== $sandbox_agent_slug) {
        $sandbox_agents = new DataMachine\\Core\\Database\\Agents\\Agents();
        $sandbox_agent_config = json_decode(${JSON.stringify(JSON.stringify(agentConfig))}, true);
        $sandbox_agent_id = $sandbox_agents->create_if_missing(
            $sandbox_agent_slug,
            'Sandbox Agent',
            1,
            $sandbox_agent_config
        );
        if ($sandbox_agent_id > 0 && method_exists($sandbox_agents, 'update_agent')) {
            $sandbox_agents->update_agent($sandbox_agent_id, array('agent_config' => $sandbox_agent_config));
        }
    }
}

$sandbox_model_settings = json_decode(${JSON.stringify(JSON.stringify(scopedSettings(mode, options.provider, options.model)))}, true);
if (is_array($sandbox_model_settings) && !empty($sandbox_model_settings)) {
    update_option('datamachine_settings', array_merge(get_option('datamachine_settings', array()), $sandbox_model_settings));
}

add_filter('agents_chat_permission', static function () {
    return true;
}, 100, 2);

add_filter('datamachine_code_sandbox_safe_abilities', static function () {
    return json_decode(${JSON.stringify(JSON.stringify([...SANDBOX_DMC_SAFE_ABILITIES]))}, true);
}, 100);

add_filter('datamachine_code_sandbox_parent_only_abilities', static function () {
    return json_decode(${JSON.stringify(JSON.stringify([...SANDBOX_DMC_PARENT_ONLY_ABILITIES]))}, true);
}, 100);

add_action('datamachine_agent_modes', static function () {
    if (class_exists('DataMachine\\Engine\\AI\\AgentModeRegistry')) {
        DataMachine\\Engine\\AI\\AgentModeRegistry::register('sandbox', 25, array(
            'label' => 'Sandbox',
            'description' => 'WP Codebox sandbox execution with reviewed artifact output.',
        ));
    }
}, 100);

add_filter('datamachine_agent_mode_sandbox', static function (string $content): string {
    $guidance = ${JSON.stringify(sandboxModeGuidance())};
    return trim($content) === '' ? $guidance : trim($content) . "\n\n" . $guidance;
}, 100, 1);

if (interface_exists('DataMachine\\Engine\\AI\\Directives\\DirectiveInterface') && !class_exists('WP_Codebox_Sandbox_Perception_Directive')) {
    final class WP_Codebox_Sandbox_Perception_Directive implements DataMachine\\Engine\\AI\\Directives\\DirectiveInterface {
        private const TREE_MAX_DEPTH = 2;

        public static function get_outputs(string $provider_name, array $tools, ?string $step_id = null, array $payload = array()): array {
            unset($provider_name, $step_id);
            $workspace_root = defined('DATAMACHINE_WORKSPACE_PATH') ? DATAMACHINE_WORKSPACE_PATH : (${JSON.stringify(SANDBOX_WORKSPACE_ROOT)});
            $sections = array(
                self::section_header(),
                self::section_workspace((string) $workspace_root),
                self::section_runtime(),
                self::section_tools($tools, is_array($payload['client_context']['tool_contract'] ?? null) ? $payload['client_context']['tool_contract'] : array()),
                self::section_outcome(),
            );
            $content = trim(implode("\n\n", array_filter($sections, static fn(string $section): bool => '' !== $section)));
            if ('' === $content) {
                return array();
            }
            return array(array('type' => 'system_text', 'content' => $content));
        }

        private static function section_header(): string {
            return implode("\n", array(
                '# WP Codebox Sandbox Perception',
                '',
                'Live snapshot of the disposable WP Codebox sandbox at the start of this run. Use it as your starting awareness; workspace tools remain available for targeted inspection and edits.',
            ));
        }

        private static function section_workspace(string $workspace_root): string {
            if ('' === $workspace_root || !is_dir($workspace_root)) {
                return '';
            }
            $entries = self::scan_tree($workspace_root, $workspace_root, 0);
            sort($entries, SORT_STRING);
            $lines = array(
                '## Workspace',
                '',
                sprintf('- Root: %s', $workspace_root),
                sprintf('- Tree depth: %d', self::TREE_MAX_DEPTH),
                '',
                'Tree:',
            );
            foreach ($entries as $entry) {
                $lines[] = $entry;
            }
            return implode("\n", $lines);
        }

        private static function scan_tree(string $base, string $current, int $depth): array {
            if ($depth > self::TREE_MAX_DEPTH) {
                return array();
            }
            $ignored = array('.git', 'node_modules', 'vendor', 'dist', 'build', '.homeboy-build');
            $items = scandir($current);
            if (false === $items) {
                return array();
            }
            $results = array();
            foreach ($items as $item) {
                if ('.' === $item || '..' === $item || in_array($item, $ignored, true)) {
                    continue;
                }
                $path = $current . '/' . $item;
                $relative = ltrim(substr($path, strlen($base)), '/');
                if (is_dir($path)) {
                    $results[] = $relative . '/';
                    $results = array_merge($results, self::scan_tree($base, $path, $depth + 1));
                    continue;
                }
                $results[] = $relative;
            }
            return $results;
        }

        private static function section_runtime(): string {
            $plugins = array();
            foreach ((array) get_option('active_plugins', array()) as $plugin_file) {
                $plugins[] = '- ' . (string) $plugin_file;
            }
            $lines = array(
                '## Runtime',
                '',
                sprintf('- WordPress: %s', get_bloginfo('version')),
                sprintf('- PHP: %s', PHP_VERSION),
            );
            if (!empty($plugins)) {
                $lines[] = '';
                $lines[] = 'Active plugins:';
                $lines = array_merge($lines, $plugins);
            }
            return implode("\n", $lines);
        }

        private static function section_tools(array $tools, array $tool_contract): string {
            $tool_names = array_keys($tools);
            sort($tool_names, SORT_STRING);
            $contract_tools = array_values(array_filter((array) ($tool_contract['tools'] ?? array()), 'is_string'));
            sort($contract_tools, SORT_STRING);
            $lines = array('## Tool Surface', '');
            if (!empty($tool_names)) {
                $lines[] = 'Resolved tools:';
                foreach ($tool_names as $tool_name) {
                    $lines[] = sprintf('- %s', $tool_name);
                }
            }
            if (!empty($contract_tools)) {
                $lines[] = '';
                $lines[] = 'Sandbox contract tools:';
                foreach ($contract_tools as $tool_name) {
                    $lines[] = sprintf('- %s', $tool_name);
                }
            }
            return implode("\n", $lines);
        }

        private static function section_outcome(): string {
            return implode("\n", array(
                '## Outcome Contract',
                '',
                'Make repository changes through workspace tools when the task calls for code changes. The parent WP Codebox run captures sandbox diffs as reviewed artifacts; return a concise final outcome that includes changed files, verification, and any PR or false-positive disposition when available.',
            ));
        }
    }
}

add_filter('datamachine_directives', static function (array $directives): array {
    if (class_exists('WP_Codebox_Sandbox_Perception_Directive')) {
        $directives[] = array(
            'class' => 'WP_Codebox_Sandbox_Perception_Directive',
            'priority' => 25,
            'modes' => array('sandbox'),
        );
    }
    return $directives;
});

$ability = function_exists('wp_get_ability') ? wp_get_ability('agents/chat') : null;
if (!$ability || !method_exists($ability, 'execute')) {
    $sandbox_agent_runtime = array(
        'agent_runtime' => array(
            'success' => false,
            'error' => array(
                'code' => 'agents_chat_unavailable',
                'message' => 'The canonical agents/chat ability is not available inside the sandbox.',
            ),
        ),
    );
} else {
    $agent_input = ${JSON.stringify(JSON.stringify(input))};
    $agent_result = $ability->execute(json_decode($agent_input, true));
    if (is_wp_error($agent_result)) {
        $sandbox_agent_runtime = array(
            'agent_runtime' => array(
                'success' => false,
                'input' => json_decode($agent_input, true),
                'error' => array(
                    'code' => $agent_result->get_error_code(),
                    'message' => $agent_result->get_error_message(),
                    'data' => $agent_result->get_error_data(),
                ),
            ),
        );
    } else {
        $sandbox_agent_runtime = array(
            'agent_runtime' => array(
                'success' => true,
                'input' => json_decode($agent_input, true),
                'result' => $agent_result,
            ),
        );
    }
}

echo json_encode($sandbox_agent_runtime, JSON_PRETTY_PRINT);
`
}

function sandboxToolContract(): Record<string, unknown> {
  return {
    schema: "wp-codebox/sandbox-dmc-tools/v1",
    modes: ["chat", "sandbox"],
    tools: sandboxToolNames(),
    safe_abilities: [...SANDBOX_DMC_SAFE_ABILITIES],
    parent_only_abilities: [...SANDBOX_DMC_PARENT_ONLY_ABILITIES],
  }
}

function sandboxToolNames(): string[] {
  return SANDBOX_DMC_SAFE_ABILITIES.map((ability) => ability.replace(/^datamachine\//, "").replaceAll("-", "_"))
}

function sandboxAgentModes(mode: string): string[] {
  return Array.from(new Set([mode, "chat"].filter(Boolean)))
}

function sandboxModeGuidance(): string {
  return `# WP Codebox Sandbox Context

You are running inside a disposable WP Codebox sandbox. The sandbox can produce a reviewed artifact bundle from workspace changes.

Use the available workspace tools by their exact names: ${sandboxToolNames().join(", ")}.

Do not invent alternate tool names such as read_file, read-file, write_file, or edit_file. For file inspection use workspace_read, workspace_ls, and workspace_grep. For changes use workspace_write, workspace_edit, or workspace_apply_patch.

The sandbox workspace root is ${SANDBOX_WORKSPACE_ROOT}. Keep changes focused on the requested task and prefer patchable repository edits over prose-only answers.`
}

function scopedAgentConfig(mode: string, provider: string | undefined, model: string | undefined): Record<string, unknown> {
  const toolPolicy = {
    mode: "allow",
    tools: sandboxToolNames(),
  }

  if (!provider && !model) {
    return { tool_policy: toolPolicy }
  }

  return {
    ...(provider ? { default_provider: provider } : {}),
    ...(model ? { default_model: model } : {}),
    tool_policy: toolPolicy,
    mode_models: {
      [mode]: {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      },
    },
  }
}

function scopedSettings(mode: string, provider: string | undefined, model: string | undefined): Record<string, unknown> {
  if (!provider && !model) {
    return {}
  }

  return {
    ...(provider ? { default_provider: provider } : {}),
    ...(model ? { default_model: model } : {}),
    mode_models: {
      [mode]: {
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
      },
    },
  }
}

export function agentSandboxRunCode(task: string, code: string, providerPlugins: Array<{ slug: string }>): string {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

if (!defined('DATAMACHINE_WORKSPACE_PATH')) {
    define('DATAMACHINE_WORKSPACE_PATH', ${JSON.stringify(SANDBOX_WORKSPACE_ROOT)});
}

add_filter('datamachine_code_remote_workspace_backend_should_handle', '__return_false', 100);

add_filter('datamachine_should_load_full_runtime', '__return_true', 1);

$plugins = array_merge(array(
    'agents-api/agents-api.php',
    'data-machine/data-machine.php',
    'data-machine-code/data-machine-code.php',
), wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)));

function wp_codebox_plugin_entry_path(string $plugin): ?array {
    $plugin = ltrim($plugin, '/');
    if ('' === $plugin || str_contains($plugin, '..') || !str_ends_with($plugin, '.php')) {
        return null;
    }
    $normal_path = WP_PLUGIN_DIR . '/' . $plugin;
    if (file_exists($normal_path)) {
        return array('path' => $normal_path, 'load_as' => 'plugin');
    }
    $mu_path = WPMU_PLUGIN_DIR . '/wp-codebox-runtime/' . $plugin;
    if (file_exists($mu_path)) {
        return array('path' => $mu_path, 'load_as' => 'mu-plugin');
    }
    return null;
}

function wp_codebox_provider_plugin_entries(array $provider_plugins): array {
    $entries = array();
    foreach ($provider_plugins as $plugin) {
        $slug = isset($plugin['slug']) ? sanitize_key((string) $plugin['slug']) : '';
        if ('' === $slug) {
            continue;
        }
        $candidates = array($slug . '/plugin.php', $slug . '/' . $slug . '.php');
        foreach ($candidates as $candidate) {
            if (wp_codebox_plugin_entry_path($candidate)) {
                $entries[] = $candidate;
                break;
            }
        }
    }
    return $entries;
}

$activation_results = array();

foreach ($plugins as $plugin) {
    $entry = wp_codebox_plugin_entry_path($plugin);
    if (!$entry) {
        $activation_results[$plugin] = array('active' => false, 'error' => 'Plugin is not mounted.');
        continue;
    }
    $result = null;
    if ('mu-plugin' === $entry['load_as']) {
        require_once $entry['path'];
    } else {
        $result = activate_plugin($plugin);
    }
    $activation_results[$plugin] = array(
        'active' => 'mu-plugin' === $entry['load_as'] ? true : is_plugin_active($plugin),
        'load_as' => $entry['load_as'],
        'error' => is_wp_error($result) ? $result->get_error_message() : null,
    );
}

do_action('plugins_loaded');
do_action('init');
do_action('wp_abilities_api_categories_init');
do_action('wp_abilities_api_init');

$sandbox_task = ${phpStringLiteral(task)};
$sandbox_stack = array(
    'plugins' => $activation_results,
    'signals' => array(
        'agents_api_loaded' => defined('AGENTS_API_LOADED'),
        'agents_registry_class' => class_exists('WP_Agents_Registry'),
        'data_machine_version' => defined('DATAMACHINE_VERSION') ? DATAMACHINE_VERSION : null,
        'data_machine_permission_helper' => class_exists('DataMachine\\Abilities\\PermissionHelper'),
        'data_machine_code_version' => defined('DATAMACHINE_CODE_VERSION') ? DATAMACHINE_CODE_VERSION : null,
        'data_machine_code_workspace' => class_exists('DataMachineCode\\Workspace\\Workspace'),
        'provider_plugins' => wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)),
    ),
);

ob_start();
${phpBody(code)}
$sandbox_output = ob_get_clean();

echo json_encode(
    array(
        'command' => 'agent-sandbox.run',
        'task' => $sandbox_task,
        'wp_loaded' => function_exists('wp_insert_post'),
        'stack' => $sandbox_stack,
        'output' => $sandbox_output,
    ),
    JSON_PRETTY_PRINT
);
`
}

function phpBody(code: string): string {
  return code.trimStart().replace(/^<\?php\s*/, "")
}

function phpStringLiteral(value: string): string {
  const marker = `WP_CODEBOX_LITERAL_${Math.random().toString(36).slice(2).toUpperCase()}`
  return `<<<'${marker}'\n${value}\n${marker}`
}

export function agentRuntimeProbeCode(providerPlugins: Array<{ slug: string }>): string {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

add_filter('datamachine_should_load_full_runtime', '__return_true', 1);

$plugins = array_merge(array(
    'agents-api/agents-api.php',
    'data-machine/data-machine.php',
    'data-machine-code/data-machine-code.php',
), wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)));

function wp_codebox_plugin_entry_path(string $plugin): ?array {
    $plugin = ltrim($plugin, '/');
    if ('' === $plugin || str_contains($plugin, '..') || !str_ends_with($plugin, '.php')) {
        return null;
    }
    $normal_path = WP_PLUGIN_DIR . '/' . $plugin;
    if (file_exists($normal_path)) {
        return array('path' => $normal_path, 'load_as' => 'plugin');
    }
    $mu_path = WPMU_PLUGIN_DIR . '/wp-codebox-runtime/' . $plugin;
    if (file_exists($mu_path)) {
        return array('path' => $mu_path, 'load_as' => 'mu-plugin');
    }
    return null;
}

function wp_codebox_provider_plugin_entries(array $provider_plugins): array {
    $entries = array();
    foreach ($provider_plugins as $plugin) {
        $slug = isset($plugin['slug']) ? sanitize_key((string) $plugin['slug']) : '';
        if ('' === $slug) {
            continue;
        }
        $candidates = array($slug . '/plugin.php', $slug . '/' . $slug . '.php');
        foreach ($candidates as $candidate) {
            if (wp_codebox_plugin_entry_path($candidate)) {
                $entries[] = $candidate;
                break;
            }
        }
    }
    return $entries;
}

$activation_results = array();

foreach ($plugins as $plugin) {
    $entry = wp_codebox_plugin_entry_path($plugin);
    if (!$entry) {
        $activation_results[$plugin] = array('active' => false, 'error' => 'Plugin is not mounted.');
        continue;
    }
    $result = null;
    if ('mu-plugin' === $entry['load_as']) {
        require_once $entry['path'];
    } else {
        $result = activate_plugin($plugin);
    }
    $activation_results[$plugin] = array(
        'active' => 'mu-plugin' === $entry['load_as'] ? true : is_plugin_active($plugin),
        'load_as' => $entry['load_as'],
        'error' => is_wp_error($result) ? $result->get_error_message() : null,
    );
}

do_action('plugins_loaded');
do_action('init');
do_action('wp_abilities_api_categories_init');
do_action('wp_abilities_api_init');

echo json_encode(
    array(
        'command' => 'agent-runtime.probe',
        'wp_loaded' => function_exists('wp_insert_post'),
        'plugins' => $activation_results,
        'signals' => array(
            'agents_api_loaded' => defined('AGENTS_API_LOADED'),
            'agents_registry_class' => class_exists('WP_Agents_Registry'),
            'data_machine_version' => defined('DATAMACHINE_VERSION') ? DATAMACHINE_VERSION : null,
            'data_machine_permission_helper' => class_exists('DataMachine\\\\Abilities\\\\PermissionHelper'),
            'data_machine_code_version' => defined('DATAMACHINE_CODE_VERSION') ? DATAMACHINE_CODE_VERSION : null,
            'data_machine_code_workspace' => class_exists('DataMachineCode\\\\Workspace\\\\Workspace'),
            'provider_plugins' => wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)),
        ),
    ),
    JSON_PRETTY_PRINT
);
`
}
