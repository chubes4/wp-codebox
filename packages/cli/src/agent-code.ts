import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

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
  const agentConfig = scopedAgentConfig(mode, options.provider, options.model)
  const input: Record<string, unknown> = {
    agent: options.agent,
    message: options.task,
    session_id: options.sessionId ?? null,
    mode,
    client_context: {
      source: "bridge",
      client_name: "wp-codebox",
      connector_id: "wp-codebox-cli",
      mode,
      agent_modes: [mode],
    },
  }

  if (options.maxTurns) {
    input.max_turns = Number.parseInt(options.maxTurns, 10)
  }

  return `
if (function_exists('wp_set_current_user')) {
    wp_set_current_user(1);
}

if (class_exists('DataMachine\\Core\\Database\\Agents\\Agents')) {
    $sandbox_agent_slug = sanitize_title((string) (${JSON.stringify(input.agent)}));
    if ('' !== $sandbox_agent_slug) {
        (new DataMachine\\Core\\Database\\Agents\\Agents())->create_if_missing(
            $sandbox_agent_slug,
            'Sandbox Agent',
            1,
            json_decode(${JSON.stringify(JSON.stringify(agentConfig))}, true)
        );
    }
}

$sandbox_model_settings = json_decode(${JSON.stringify(JSON.stringify(scopedSettings(mode, options.provider, options.model)))}, true);
if (is_array($sandbox_model_settings) && !empty($sandbox_model_settings)) {
    update_option('datamachine_settings', array_merge(get_option('datamachine_settings', array()), $sandbox_model_settings));
}

add_filter('agents_chat_permission', static function () {
    return true;
}, 100, 2);

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

function scopedAgentConfig(mode: string, provider: string | undefined, model: string | undefined): Record<string, unknown> {
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

add_filter('datamachine_should_load_full_runtime', '__return_true', 1);

$plugins = array_merge(array(
    'agents-api/agents-api.php',
    'data-machine/data-machine.php',
    'data-machine-code/data-machine-code.php',
), wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)));

function wp_codebox_provider_plugin_entries(array $provider_plugins): array {
    $entries = array();
    foreach ($provider_plugins as $plugin) {
        $slug = isset($plugin['slug']) ? sanitize_key((string) $plugin['slug']) : '';
        if ('' === $slug) {
            continue;
        }
        $candidates = array($slug . '/plugin.php', $slug . '/' . $slug . '.php');
        foreach ($candidates as $candidate) {
            if (file_exists(WP_PLUGIN_DIR . '/' . $candidate)) {
                $entries[] = $candidate;
                break;
            }
        }
    }
    return $entries;
}

$activation_results = array();

foreach ($plugins as $plugin) {
    $result = activate_plugin($plugin);
    $activation_results[$plugin] = array(
        'active' => is_plugin_active($plugin),
        'error' => is_wp_error($result) ? $result->get_error_message() : null,
    );
}

do_action('plugins_loaded');
do_action('init');
do_action('wp_abilities_api_categories_init');
do_action('wp_abilities_api_init');

$sandbox_task = ${JSON.stringify(task)};
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

export function agentRuntimeProbeCode(providerPlugins: Array<{ slug: string }>): string {
  return `<?php
require_once ABSPATH . 'wp-admin/includes/plugin.php';

add_filter('datamachine_should_load_full_runtime', '__return_true', 1);

$plugins = array_merge(array(
    'agents-api/agents-api.php',
    'data-machine/data-machine.php',
    'data-machine-code/data-machine-code.php',
), wp_codebox_provider_plugin_entries(json_decode(${JSON.stringify(JSON.stringify(providerPlugins))}, true)));

function wp_codebox_provider_plugin_entries(array $provider_plugins): array {
    $entries = array();
    foreach ($provider_plugins as $plugin) {
        $slug = isset($plugin['slug']) ? sanitize_key((string) $plugin['slug']) : '';
        if ('' === $slug) {
            continue;
        }
        $candidates = array($slug . '/plugin.php', $slug . '/' . $slug . '.php');
        foreach ($candidates as $candidate) {
            if (file_exists(WP_PLUGIN_DIR . '/' . $candidate)) {
                $entries[] = $candidate;
                break;
            }
        }
    }
    return $entries;
}

$activation_results = array();

foreach ($plugins as $plugin) {
    $result = activate_plugin($plugin);
    $activation_results[$plugin] = array(
        'active' => is_plugin_active($plugin),
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
