<?php
/**
 * Pure-PHP smoke for the WP Codebox WordPress plugin ability surface.
 *
 * Run: php tests/smoke-wordpress-plugin.php
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', sys_get_temp_dir() . '/wp-codebox-wordpress-plugin/' );
}

if ( ! class_exists( 'WP_Ability' ) ) {
	class WP_Ability {}
}

if ( ! class_exists( 'WP_Error' ) ) {
	class WP_Error {
		public function __construct( private string $code = '', private string $message = '', private array $data = array() ) {}
		public function get_error_code(): string { return $this->code; }
		public function get_error_message(): string { return $this->message; }
		public function get_error_data(): array { return $this->data; }
	}
}

if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $thing ): bool { return $thing instanceof WP_Error; }
}

$GLOBALS['wp_codebox_registered_abilities'] = array();
$GLOBALS['wp_codebox_filters']              = array();
$GLOBALS['wp_codebox_options']              = array();
$GLOBALS['wp_codebox_site_options']         = array();

function wp_register_ability( string $name, array $definition ): void {
	$GLOBALS['wp_codebox_registered_abilities'][ $name ] = $definition;
}

function doing_action( string $hook ): bool { return 'wp_abilities_api_init' === $hook; }
function add_action( string $hook, callable $callback, int $priority = 10 ): void {}
function add_filter( string $hook, callable $callback, int $priority = 10 ): void { $GLOBALS['wp_codebox_filters'][ $hook ] = $callback; }
function current_user_can( string $capability ): bool { return 'manage_options' === $capability; }
function apply_filters( string $hook, mixed $value, mixed ...$args ): mixed {
	if ( ! array_key_exists( $hook, $GLOBALS['wp_codebox_filters'] ) ) {
		return $value;
	}

	$filter = $GLOBALS['wp_codebox_filters'][ $hook ];
	if ( is_callable( $filter ) ) {
		return $filter( $value, ...$args );
	}

	return $filter;
}
function is_multisite(): bool { return (bool) ( $GLOBALS['wp_codebox_is_multisite'] ?? false ); }
function get_option( string $name, mixed $default = null ): mixed { return $GLOBALS['wp_codebox_options'][ $name ] ?? $default; }
function get_site_option( string $name, mixed $default = null ): mixed { return $GLOBALS['wp_codebox_site_options'][ $name ] ?? $default; }

require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-sandbox-runner.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-artifacts.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-data-machine-pending-actions.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-abilities.php';

$root = sys_get_temp_dir() . '/wp-codebox-wordpress-plugin-' . getmypid();
foreach ( array( 'agents-api', 'data-machine', 'data-machine-code', 'ai-provider-test', 'editable-plugin', 'artifacts', 'artifact-network-root' ) as $dir ) {
	mkdir( $root . '/' . $dir, 0777, true );
}
file_put_contents( $root . '/wp-codebox.js', "#!/usr/bin/env node\n" );

$failures = array();
$total    = 0;
$assert   = function ( string $label, bool $condition ) use ( &$failures, &$total ): void {
	++$total;
	if ( $condition ) {
		echo "  ok {$label}\n";
		return;
	}

	$failures[] = $label;
	echo "  fail {$label}\n";
};

echo "WP Codebox WordPress plugin - smoke\n";

new WP_Codebox_Data_Machine_Pending_Actions();
new WP_Codebox_Abilities();

$ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/run-agent-task'] ?? null;
$assert( 'run-agent-task ability registered', is_array( $ability ) );
$assert( 'ability is REST visible', true === ( $ability['meta']['show_in_rest'] ?? false ) );
$assert( 'ability accepts goal or legacy task', array( 'goal' ) === ( $ability['input_schema']['anyOf'][0]['required'] ?? array() ) && array( 'task' ) === ( $ability['input_schema']['anyOf'][1]['required'] ?? array() ) );
$assert( 'ability exposes task target schema', isset( $ability['input_schema']['properties']['target']['properties']['kind'] ) );
$assert( 'ability exposes allowed tools schema', 'array' === ( $ability['input_schema']['properties']['allowed_tools']['type'] ?? '' ) );
$assert( 'ability exposes expected artifacts schema', 'array' === ( $ability['input_schema']['properties']['expected_artifacts']['type'] ?? '' ) );
$assert( 'ability exposes policy and context schema', 'object' === ( $ability['input_schema']['properties']['policy']['type'] ?? '' ) && 'object' === ( $ability['input_schema']['properties']['context']['type'] ?? '' ) );
$assert( 'ability exposes generic mounts schema', 'array' === ( $ability['input_schema']['properties']['mounts']['type'] ?? '' ) && 'object' === ( $ability['input_schema']['properties']['mounts']['items']['properties']['metadata']['type'] ?? '' ) );
$assert( 'ability exposes inheritance request schema', 'object' === ( $ability['input_schema']['properties']['inherit']['type'] ?? '' ) && 'array' === ( $ability['input_schema']['properties']['inherit']['properties']['connectors']['type'] ?? '' ) );
$assert( 'ability exposes connector credential envelope schema', 'object' === ( $ability['input_schema']['properties']['inherit']['properties']['credentials']['type'] ?? '' ) && 'array' === ( $ability['input_schema']['properties']['inherit']['properties']['credentials']['properties']['secrets']['type'] ?? '' ) );
$assert( 'ability exposes external sandbox session schema', 'string' === ( $ability['input_schema']['properties']['sandbox_session_id']['type'] ?? '' ) && 'object' === ( $ability['input_schema']['properties']['orchestrator']['type'] ?? '' ) && 'object' === ( $ability['output_schema']['properties']['session']['type'] ?? '' ) );
$assert( 'session schema pins external orchestrator persistence', array( 'external-orchestrator' ) === ( $ability['output_schema']['properties']['session']['properties']['persistence']['enum'] ?? array() ) && str_contains( $ability['output_schema']['properties']['session']['properties']['persistence']['description'] ?? '', 'does not persist' ) );
$assert( 'session schema keeps durable lifecycle external', array( 'completed' ) === ( $ability['output_schema']['properties']['session']['properties']['status']['enum'] ?? array() ) && str_contains( $ability['output_schema']['properties']['session']['properties']['status']['description'] ?? '', 'external orchestrator' ) );
$assert( 'ability omits raw code input', ! isset( $ability['input_schema']['properties']['code'] ) && ! isset( $ability['input_schema']['properties']['code_file'] ) );
$assert( 'permission defaults to manage_options', true === call_user_func( $ability['permission_callback'] ) );

$batch_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/run-agent-task-batch'] ?? null;
$assert( 'run-agent-task-batch ability registered', is_array( $batch_ability ) );
$assert( 'batch ability is REST visible', true === ( $batch_ability['meta']['show_in_rest'] ?? false ) );
$assert( 'batch ability requires tasks', array( 'tasks' ) === ( $batch_ability['input_schema']['required'] ?? array() ) );

$artifact_abilities = array(
	'wp-codebox/list-artifacts',
	'wp-codebox/get-artifact',
	'wp-codebox/discard-artifact',
	'wp-codebox/apply-approved-artifact',
	'wp-codebox/stage-artifact-apply',
);
foreach ( $artifact_abilities as $artifact_ability_name ) {
	$artifact_ability = $GLOBALS['wp_codebox_registered_abilities'][ $artifact_ability_name ] ?? null;
	$assert( $artifact_ability_name . ' ability registered', is_array( $artifact_ability ) );
	$assert( $artifact_ability_name . ' is REST visible', true === ( $artifact_ability['meta']['show_in_rest'] ?? false ) );
}

$GLOBALS['wp_codebox_filters']['wp_codebox_component_paths'] = array(
	'agents_api'        => $root . '/agents-api',
	'data_machine'      => $root . '/data-machine',
	'data_machine_code' => $root . '/data-machine-code',
	'provider_plugins'  => array( $root . '/ai-provider-test' ),
);
$GLOBALS['wp_codebox_filters']['wp_codebox_bin'] = $root . '/wp-codebox.js';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_agent'] = 'site-coder';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_provider'] = 'openai';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_model'] = 'gpt-5.5';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_secret_env'] = array( 'OPENAI_API_KEY' );

$captured_command = '';
$captured_recipe  = '';
$runner           = new WP_Codebox_Agent_Sandbox_Runner(
	array(
		'shell_available' => fn() => true,
		'command_runner'  => function ( string $command ) use ( &$captured_command, &$captured_recipe ): array {
			$captured_command = $command;
			if ( preg_match( "/--recipe '([^']+)'/", $command, $matches ) && is_readable( $matches[1] ) ) {
				$captured_recipe = (string) file_get_contents( $matches[1] );
			}
			return array(
				'exit_code' => 0,
				'output'    => json_encode(
					array(
						'success'   => true,
						'runtime'   => array( 'backend' => 'wordpress-playground' ),
						'artifacts' => array(
							'id'      => 'artifact-bundle-sha256-fixture',
							'preview' => array( 'url' => 'http://127.0.0.1:12345' ),
						),
					)
				),
			);
		},
	)
);

$result = $runner->run(
	array(
		'task'           => 'Run a chat-requested sandbox task.',
		'sandbox_session_id' => 'parent-job-123',
		'session_id'     => 'agent-chat-session-456',
		'orchestrator'   => array(
			'type'   => 'external-job-system',
			'id'     => 'parent-control-plane',
			'job_id' => 'job-123',
		),
		'artifacts_path' => $root . '/artifacts',
		'secret_env'     => array( 'GITHUB_TOKEN' ),
		'preview_hold_seconds' => 30,
		'mounts'         => array(
			array(
				'source'   => $root . '/editable-plugin',
				'target'   => '/wordpress/wp-content/plugins/editable-plugin',
				'mode'     => 'readwrite',
				'metadata' => array(
					'kind'                        => 'component',
					'slug'                        => 'editable-plugin',
					'repo'                        => 'example/editable-plugin',
					'default_branch'              => 'main',
					'repo_root_relative_to_mount' => '.',
					'editable'                    => true,
				),
			),
		),
	)
);

$assert( 'runner succeeds with filter-provided component paths', ! is_wp_error( $result ) && true === ( $result['success'] ?? false ) );
$assert( 'runner schema is stable', ! is_wp_error( $result ) && 'wp-codebox/agent-task-run/v1' === ( $result['schema'] ?? '' ) );
$assert( 'runner returns caller-owned sandbox session envelope', ! is_wp_error( $result ) && 'wp-codebox/sandbox-session/v1' === ( $result['session']['schema'] ?? '' ) && 'parent-job-123' === ( $result['session']['id'] ?? '' ) && 'external-orchestrator' === ( $result['session']['persistence'] ?? '' ) );
$assert( 'runner keeps agent session separate from sandbox session', ! is_wp_error( $result ) && 'agent-chat-session-456' === ( $result['session']['agent_session_id'] ?? '' ) && str_contains( $captured_recipe, 'session-id=agent-chat-session-456' ) );
$assert( 'runner returns orchestrator correlation and artifact refs', ! is_wp_error( $result ) && 'job-123' === ( $result['session']['orchestrator']['job_id'] ?? '' ) && 'artifact-bundle-sha256-fixture' === ( $result['session']['artifacts']['bundle_id'] ?? '' ) );
$assert( 'runner returns normalized task input for legacy task', ! is_wp_error( $result ) && 'wp-codebox/task-input/v1' === ( $result['task_input']['schema'] ?? '' ) && 'Run a chat-requested sandbox task.' === ( $result['task_input']['goal'] ?? '' ) );
$assert( 'runner invokes recipe-run', str_contains( $captured_command, 'recipe-run' ) );
$assert( 'runner uses node for JS CLI', str_contains( $captured_command, 'node ' ) );
$assert( 'runner passes preview hold to CLI', str_contains( $captured_command, '--preview-hold' ) && str_contains( $captured_command, "'30'" ) );
$assert( 'runner recipe uses agent step', str_contains( $captured_recipe, 'wp-codebox.agent-sandbox-run' ) );
$assert( 'runner recipe passes task', str_contains( $captured_recipe, 'Run a chat-requested sandbox task.' ) );
$assert( 'runner recipe passes default agent', str_contains( $captured_recipe, 'site-coder' ) );
$assert( 'runner recipe passes sandbox mode', str_contains( $captured_recipe, 'sandbox' ) );
$assert( 'runner recipe passes default provider', str_contains( $captured_recipe, 'openai' ) );
$assert( 'runner recipe passes default model', str_contains( $captured_recipe, 'gpt-5.5' ) );
$assert( 'runner recipe passes provider plugin path', str_contains( $captured_recipe, 'ai-provider-test' ) );
$assert( 'runner recipe passes generic mount metadata', str_contains( $captured_recipe, 'example/editable-plugin' ) && str_contains( $captured_recipe, 'repo_root_relative_to_mount' ) );
$assert( 'runner recipe passes secret env name only', str_contains( $captured_recipe, 'GITHUB_TOKEN' ) && ! str_contains( $captured_recipe, 'GITHUB_TOKEN=' ) );
$assert( 'runner does not pass raw code options', ! str_contains( $captured_command, '--code ' ) && ! str_contains( $captured_command, '--code-file' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_default_provider'] = '';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_model']    = '';
$GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] = function ( array $resolution, array $request ): array {
	$resolution['connectors'] = array(
		array(
			'name'       => $request['connectors'][0] ?? 'primary-ai',
			'status'     => 'resolved',
			'provider'   => 'openai',
			'model'      => 'gpt-5.5',
			'secret_env' => array( 'OPENAI_API_KEY' ),
			'credentials' => array(
				'schema'    => 'wp-codebox/connector-credentials/v1',
				'connector' => $request['connectors'][0] ?? 'primary-ai',
				'scope'     => 'connector',
				'status'    => 'available',
				'secrets'   => array(
					array(
						'name'   => 'OPENAI_API_KEY',
						'status' => 'available',
						'scope'  => 'primary-ai',
						'source' => 'parent-env',
					),
				),
			),
			'value'      => 'sk-test-secret-value',
			'token'      => 'sk-test-secret-value',
		),
	);
	$resolution['settings']   = array(
		array(
			'name'   => $request['settings'][0] ?? 'mode_models',
			'status' => 'resolved',
			'scope'  => 'site',
			'value'  => 'sk-test-secret-value',
		),
	);

	return $resolution;
};

$inherit_result = $runner->run(
	array(
		'goal'           => 'Use inherited connector configuration.',
		'artifacts_path' => $root . '/artifacts',
		'inherit'        => array(
			'connectors' => array( 'primary-ai' ),
			'settings'   => array( 'mode_models' ),
		),
	)
);
$inherit_recipe    = json_decode( $captured_recipe, true );
$inherit_step_args = $inherit_recipe['workflow']['steps'][0]['args'] ?? array();
$assert( 'runner resolves inherited connector provider', ! is_wp_error( $inherit_result ) && in_array( 'provider=openai', $inherit_step_args, true ) );
$assert( 'runner resolves inherited connector model', ! is_wp_error( $inherit_result ) && in_array( 'model=gpt-5.5', $inherit_step_args, true ) );
$assert( 'runner transports inherited secret env name only', ! is_wp_error( $inherit_result ) && in_array( 'OPENAI_API_KEY', $inherit_recipe['inputs']['secretEnv'] ?? array(), true ) && ! str_contains( $captured_recipe, 'OPENAI_API_KEY=' ) );
$assert( 'runner records connector credential provenance without value', ! is_wp_error( $inherit_result ) && 'wp-codebox/connector-credentials/v1' === ( $inherit_recipe['inputs']['inheritance']['connectors'][0]['credentials']['schema'] ?? '' ) && 'available' === ( $inherit_recipe['inputs']['inheritance']['connectors'][0]['credentials']['secrets'][0]['status'] ?? '' ) );
$assert( 'runner records sanitized inheritance status', ! is_wp_error( $inherit_result ) && 'primary-ai' === ( $inherit_recipe['inputs']['inheritance']['connectors'][0]['name'] ?? '' ) && 'resolved' === ( $inherit_recipe['inputs']['inheritance']['settings'][0]['status'] ?? '' ) );
$assert( 'runner drops inherited secret values from recipe', ! str_contains( $captured_recipe, 'sk-test-secret-value' ) && ! str_contains( $captured_recipe, 'token' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] = function ( array $resolution, array $request ): array {
	$resolution['connectors'] = array(
		array(
			'name'        => $request['connectors'][0] ?? 'primary-ai',
			'status'      => 'resolved',
			'provider'    => 'openai',
			'model'       => 'gpt-5.5',
			'credentials' => array(
				'schema'    => 'wp-codebox/connector-credentials/v1',
				'connector' => $request['connectors'][0] ?? 'primary-ai',
				'scope'     => 'connector',
				'status'    => 'denied',
				'reason'    => 'scope not approved',
				'secrets'   => array(
					array(
						'name'   => 'OPENAI_API_KEY',
						'status' => 'denied',
						'scope'  => 'primary-ai',
						'source' => 'connector',
						'reason' => 'scope not approved',
					),
				),
			),
		),
	);

	return $resolution;
};

$denied_credentials = $runner->run(
	array(
		'goal'           => 'Use denied connector credentials.',
		'artifacts_path' => $root . '/artifacts',
		'inherit'        => array( 'connectors' => array( 'primary-ai' ) ),
	)
);
$assert( 'denied connector credential scope fails closed', is_wp_error( $denied_credentials ) && 'wp_codebox_connector_credentials_unavailable' === $denied_credentials->get_error_code() );
$assert( 'denied connector credential failure is observable and redacted', is_wp_error( $denied_credentials ) && 'wp-codebox/connector-credential-failure/v1' === ( $denied_credentials->get_error_data()['schema'] ?? '' ) && ! str_contains( json_encode( $denied_credentials->get_error_data() ), 'sk-test-secret-value' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] = function ( array $resolution, array $request ): array {
	$resolution['connectors'] = array(
		array(
			'name'        => $request['connectors'][0] ?? 'primary-ai',
			'status'      => 'resolved',
			'provider'    => 'openai',
			'model'       => 'gpt-5.5',
			'credentials' => array(
				'schema'    => 'wp-codebox/connector-credentials/v1',
				'connector' => $request['connectors'][0] ?? 'primary-ai',
				'scope'     => 'connector',
				'status'    => 'missing',
				'secrets'   => array(
					array( 'name' => 'OPENAI_API_KEY', 'status' => 'missing', 'scope' => 'primary-ai', 'source' => 'parent-env' ),
				),
			),
		),
	);

	return $resolution;
};

$missing_credentials = $runner->run(
	array(
		'goal'           => 'Use missing connector credentials.',
		'artifacts_path' => $root . '/artifacts',
		'inherit'        => array( 'connectors' => array( 'primary-ai' ) ),
	)
);
$assert( 'missing connector credential scope fails closed', is_wp_error( $missing_credentials ) && 'wp_codebox_connector_credentials_unavailable' === $missing_credentials->get_error_code() );

$GLOBALS['wp_codebox_filters']['wp_codebox_default_provider'] = 'openai';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_model']    = 'gpt-5.5';
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] );

$raw_code = $runner->run(
	array(
		'task'           => 'Run a chat-requested sandbox task.',
		'artifacts_path' => $root . '/artifacts',
		'code'           => '<?php echo "raw";',
	)
);
$assert( 'raw code input fails closed', is_wp_error( $raw_code ) && 'wp_codebox_raw_code_forbidden' === $raw_code->get_error_code() );

$raw_code_file = $runner->run(
	array(
		'task'           => 'Run a chat-requested sandbox task.',
		'artifacts_path' => $root . '/artifacts',
		'code_file'      => '/tmp/raw.php',
	)
);
$assert( 'raw code file input fails closed', is_wp_error( $raw_code_file ) && 'wp_codebox_raw_code_forbidden' === $raw_code_file->get_error_code() );

$invalid_mount = $runner->run(
	array(
		'task'           => 'Run a chat-requested sandbox task.',
		'artifacts_path' => $root . '/artifacts',
		'mounts'         => array(
			array(
				'source' => $root . '/missing-plugin',
				'target' => '/wordpress/wp-content/plugins/missing-plugin',
			),
		),
	)
);
$assert( 'invalid mount input fails closed', is_wp_error( $invalid_mount ) && 'wp_codebox_mount_source_invalid' === $invalid_mount->get_error_code() );

$structured_result = $runner->run(
	array(
		'goal'               => 'Add a focused product feature.',
		'target'             => array(
			'kind' => 'plugin',
			'path' => 'wp-content/plugins/simple-plugin',
		),
		'allowed_tools'      => array( 'workspace.read', 'workspace.write', '' ),
		'expected_artifacts' => array( 'patch', 'tests', 'patch' ),
		'policy'             => array( 'applyBack' => 'reviewed' ),
		'context'            => array( 'issue' => 'https://github.com/chubes4/wp-codebox/issues/29' ),
		'artifacts_path'     => $root . '/artifacts',
	)
);

$assert( 'runner accepts structured task input', ! is_wp_error( $structured_result ) && 'Add a focused product feature.' === ( $structured_result['task_input']['goal'] ?? '' ) );
$assert( 'runner preserves structured target', ! is_wp_error( $structured_result ) && 'plugin' === ( $structured_result['task_input']['target']['kind'] ?? '' ) );
$assert( 'runner normalizes task input lists', ! is_wp_error( $structured_result ) && array( 'workspace.read', 'workspace.write' ) === ( $structured_result['task_input']['allowed_tools'] ?? array() ) && array( 'patch', 'tests' ) === ( $structured_result['task_input']['expected_artifacts'] ?? array() ) );
$assert( 'runner passes structured task contract to recipe', str_contains( $captured_recipe, 'wp-codebox/task-input/v1' ) && str_contains( $captured_recipe, 'allowed_tools' ) );

$batch_result = $runner->run_batch(
	array(
		'tasks'          => array( 'Fix issue one.', 'Fix issue two.' ),
		'concurrency'    => 2,
		'artifacts_path' => $root . '/artifacts',
	)
);

$assert( 'batch runner succeeds with filter-provided component paths', ! is_wp_error( $batch_result ) && true === ( $batch_result['success'] ?? false ) );
$assert( 'batch runner schema is stable', ! is_wp_error( $batch_result ) && 'wp-codebox/agent-task-batch/v1' === ( $batch_result['schema'] ?? '' ) );
$assert( 'batch runner returns normalized task inputs', ! is_wp_error( $batch_result ) && 2 === count( $batch_result['task_inputs'] ?? array() ) && 'Fix issue one.' === ( $batch_result['task_inputs'][0]['goal'] ?? '' ) );
$assert( 'batch runner invokes recipe-run', str_contains( $captured_command, 'recipe-run' ) );
$assert( 'batch runner emits repeated agent steps', 2 === substr_count( $captured_recipe, 'wp-codebox.agent-sandbox-run' ) );
$assert( 'batch runner preserves requested concurrency', 2 === ( $batch_result['concurrency'] ?? 0 ) );
$assert( 'batch runner recipe passes default provider', str_contains( $captured_recipe, 'openai' ) );
$assert( 'batch runner recipe passes default model', str_contains( $captured_recipe, 'gpt-5.5' ) );
$assert( 'batch runner recipe passes provider plugin path', str_contains( $captured_recipe, 'ai-provider-test' ) );
$assert( 'batch runner recipe passes secret env name only', str_contains( $captured_recipe, 'OPENAI_API_KEY' ) );

$pending_action_handlers_filter     = $GLOBALS['wp_codebox_filters']['datamachine_pending_action_handlers'] ?? null;
$GLOBALS['wp_codebox_is_multisite'] = true;
$GLOBALS['wp_codebox_filters']      = array_filter(
	array( 'datamachine_pending_action_handlers' => $pending_action_handlers_filter ),
	static fn( mixed $filter ): bool => null !== $filter
);
$GLOBALS['wp_codebox_site_options'] = array(
	'wp_codebox_component_paths' => array(
		'agents_api'        => $root . '/agents-api',
		'data_machine'      => $root . '/data-machine',
		'data_machine_code' => $root . '/data-machine-code',
		'provider_plugins'  => array( $root . '/ai-provider-test' ),
	),
	'wp_codebox_bin'             => $root . '/wp-codebox.js',
	'wp_codebox_artifacts_root'  => $root . '/artifact-network-root',
);

$network_result = $runner->run( array( 'task' => 'Use network-level WP Codebox configuration.' ) );
$assert( 'multisite runner reads network-level options', ! is_wp_error( $network_result ) && str_starts_with( (string) ( $network_result['artifacts'] ?? '' ), $root . '/artifact-network-root' ) );

$GLOBALS['wp_codebox_is_multisite'] = false;
$GLOBALS['wp_codebox_filters']      = array_filter(
	array(
		'wp_codebox_component_paths'            => array(
			'agents_api'        => $root . '/agents-api',
			'data_machine'      => $root . '/data-machine',
			'data_machine_code' => $root . '/data-machine-code',
		),
		'wp_codebox_bin'                        => $root . '/wp-codebox.js',
		'wp_codebox_default_agent'              => 'site-coder',
		'wp_codebox_default_provider'           => 'openai',
		'wp_codebox_default_model'              => 'gpt-5.5',
		'wp_codebox_default_secret_env'         => array( 'OPENAI_API_KEY' ),
		'datamachine_pending_action_handlers'   => $pending_action_handlers_filter,
	),
	static fn( mixed $filter ): bool => null !== $filter
);

$missing_task = $runner->run( array( 'artifacts_path' => $root . '/artifacts' ) );
$assert( 'missing task fails closed', is_wp_error( $missing_task ) && 'wp_codebox_task_missing' === $missing_task->get_error_code() );

$missing_tasks = $runner->run_batch( array( 'artifacts_path' => $root . '/artifacts' ) );
$assert( 'missing batch tasks fails closed', is_wp_error( $missing_tasks ) && 'wp_codebox_tasks_missing' === $missing_tasks->get_error_code() );

$artifact_root = $root . '/artifact-store';
$bundle_dir    = $artifact_root . '/runtime-test';
mkdir( $bundle_dir . '/files', 0777, true );
$changed_files_json = json_encode(
	array(
		'schema' => 'wp-codebox/changed-files/v1',
		'files'  => array(
			array(
				'path'         => '/wordpress/wp-content/plugins/example/generated.txt',
				'status'       => 'added',
				'mountIndex'   => 0,
				'mountTarget'  => '/wordpress/wp-content/plugins/example',
				'relativePath' => 'generated.txt',
				'patchPath'    => 'files/diffs/mount-0.patch',
			),
		),
	),
	JSON_PRETTY_PRINT
) . "\n";
$patch_diff          = "diff --git a/generated.txt b/generated.txt\n+cooked\n";
$content_digest      = hash( 'sha256', "wp-codebox/artifact-content/v1\nfiles/changed-files.json\n" . $changed_files_json . "\nfiles/patch.diff\n" . $patch_diff );
$artifact_id         = 'artifact-bundle-sha256-' . $content_digest;
file_put_contents(
	$bundle_dir . '/manifest.json',
	json_encode(
		array(
			'id'            => $artifact_id,
			'contentDigest' => array(
				'algorithm' => 'sha256',
				'inputs'    => array( 'files/changed-files.json', 'files/patch.diff' ),
				'value'     => $content_digest,
			),
			'createdAt'     => '2026-05-19T00:00:00Z',
			'files'         => array(
				array(
					'path'        => 'files/changed-files.json',
					'kind'        => 'changed-files',
					'contentType' => 'application/json',
				),
				array(
					'path'        => 'files/patch.diff',
					'kind'        => 'patch',
					'contentType' => 'text/x-diff',
				),
				array(
					'path'        => 'files/test-results.json',
					'kind'        => 'test-results',
					'contentType' => 'application/json',
				),
				array(
					'path'        => 'files/review.json',
					'kind'        => 'review',
					'contentType' => 'application/json',
				),
			),
		),
		JSON_PRETTY_PRINT
	) . "\n"
);
file_put_contents(
	$bundle_dir . '/metadata.json',
	json_encode(
		array(
			'artifacts'  => array( 'patch' => 'files/patch.diff' ),
			'provenance' => array(
				'task' => array(
					'requester' => 'chat:user-7',
				),
			),
		),
		JSON_PRETTY_PRINT
	) . "\n"
);
file_put_contents( $bundle_dir . '/files/changed-files.json', $changed_files_json );
file_put_contents( $bundle_dir . '/files/patch.diff', $patch_diff );
file_put_contents(
	$bundle_dir . '/files/test-results.json',
	json_encode(
		array(
			'schema'           => 'wp-codebox/test-results/v1',
			'status'           => 'unknown',
			'summary'          => array(
				'total'   => 0,
				'passed'  => 0,
				'failed'  => 0,
				'skipped' => 0,
				'unknown' => 0,
			),
			'suites'           => array(),
			'rawLogReferences' => array(
				array(
					'path' => 'logs/commands.log',
					'kind' => 'commands-log',
				),
			),
		),
		JSON_PRETTY_PRINT
	) . "\n"
);
file_put_contents(
	$bundle_dir . '/files/review.json',
	json_encode(
		array(
			'schema'     => 'wp-codebox/artifact-review/v1',
			'artifactId' => $artifact_id,
			'summary'    => 'Sandbox produced changes in 1 file.',
			'actions'    => array(
				array(
					'kind'                  => 'approve',
					'label'                 => 'Approve all changes',
					'requiresApprovedFiles' => true,
				),
			),
		),
		JSON_PRETTY_PRINT
	) . "\n"
);

$artifacts = new WP_Codebox_Artifacts();
$listed    = $artifacts->list( array( 'artifacts_path' => $artifact_root ) );
$assert( 'artifact listing succeeds', ! is_wp_error( $listed ) && 1 === count( $listed['artifacts'] ?? array() ) );
$assert( 'artifact listing detects test results', ! is_wp_error( $listed ) && true === ( $listed['artifacts'][0]['has_test_results'] ?? false ) );

$read_artifact = $artifacts->get(
	array(
		'artifacts_path' => $artifact_root,
		'artifact_id'    => $artifact_id,
	)
);
$assert( 'artifact get returns canonical changed files', ! is_wp_error( $read_artifact ) && 'wp-codebox/changed-files/v1' === ( $read_artifact['artifact']['changed_files']['schema'] ?? '' ) );
$assert( 'artifact get returns test results', ! is_wp_error( $read_artifact ) && 'wp-codebox/test-results/v1' === ( $read_artifact['artifact']['test_results']['schema'] ?? '' ) );
$assert( 'artifact get returns review payload', ! is_wp_error( $read_artifact ) && 'wp-codebox/artifact-review/v1' === ( $read_artifact['artifact']['review']['schema'] ?? '' ) );
$assert( 'artifact get verifies content digest', ! is_wp_error( $read_artifact ) && $content_digest === ( $read_artifact['artifact']['content_digest'] ?? '' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_apply_approved_artifact'] = function ( mixed $value, array $payload ): array {
	return array(
		'adapter'                 => 'test-adapter',
		'artifact_id'             => $payload['artifact_id'],
		'patch_sha256'            => $payload['patch_sha256'],
		'artifact_content_digest' => $payload['artifact_content_digest'],
		'patch_contains'          => str_contains( $payload['patch'], 'cooked' ),
		'patch'                   => $payload['patch'],
		'access_token'            => 'secret-token-value',
		'pr_url'                  => 'https://github.com/chubes4/wp-codebox/pull/999',
	);
};
$applied = $artifacts->apply_approved(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
		'approver'        => 'site-user:1',
	)
);
$assert( 'approved artifact apply delegates exact patch', ! is_wp_error( $applied ) && true === ( $applied['result']['patch_contains'] ?? false ) && hash( 'sha256', $patch_diff ) === ( $applied['patch_sha256'] ?? '' ) && $content_digest === ( $applied['content_digest'] ?? '' ) );

$captured_stage_args = array();
$GLOBALS['wp_codebox_filters']['wp_codebox_stage_pending_apply_artifact'] = function ( mixed $value, array $stage_args ) use ( &$captured_stage_args ): array {
	$captured_stage_args = $stage_args;
	return array(
		'staged'    => true,
		'action_id' => 'act_test',
		'payload'   => array(
			'pending_action' => array(
				'kind'        => $stage_args['kind'],
				'apply_input' => $stage_args['apply_input'],
				'preview'     => $stage_args['preview_data'],
			),
		),
	);
};
$staged = WP_Codebox_Data_Machine_Pending_Actions::stage_apply_artifact(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt', '' ),
		'approver'        => 'site-user:1',
		'apply_target'    => array( 'repo' => 'chubes4/wp-codebox' ),
		'context'         => array( 'session_id' => 'chat-123' ),
	)
);
$assert( 'pending artifact apply can be staged', ! is_wp_error( $staged ) && true === ( $staged['staged'] ?? false ) && WP_Codebox_Data_Machine_Pending_Actions::KIND === ( $captured_stage_args['kind'] ?? '' ) );
$assert( 'pending artifact apply stores exact apply input', $artifact_id === ( $captured_stage_args['apply_input']['artifact_id'] ?? '' ) && array( '/wordpress/wp-content/plugins/example/generated.txt' ) === ( $captured_stage_args['apply_input']['approved_files'] ?? array() ) && array( 'repo' => 'chubes4/wp-codebox' ) === ( $captured_stage_args['apply_input']['apply_target'] ?? array() ) );
$assert( 'pending artifact apply preview includes review and changed files', 'wp-codebox/pending-apply-preview/v1' === ( $captured_stage_args['preview_data']['schema'] ?? '' ) && 'wp-codebox/artifact-review/v1' === ( $captured_stage_args['preview_data']['review']['schema'] ?? '' ) && 'wp-codebox/changed-files/v1' === ( $captured_stage_args['preview_data']['changed_files']['schema'] ?? '' ) );

$handlers = apply_filters( 'datamachine_pending_action_handlers', array() );
$assert( 'pending artifact apply handler registers with Data Machine', isset( $handlers[ WP_Codebox_Data_Machine_Pending_Actions::KIND ]['apply'] ) && is_callable( $handlers[ WP_Codebox_Data_Machine_Pending_Actions::KIND ]['apply'] ) );
$pending_handler_result = call_user_func(
	$handlers[ WP_Codebox_Data_Machine_Pending_Actions::KIND ]['apply'],
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
		'approver'        => 'site-user:1',
	)
);
$assert( 'pending artifact apply handler delegates to approved artifact apply', ! is_wp_error( $pending_handler_result ) && true === ( $pending_handler_result['success'] ?? false ) && $artifact_id === ( $pending_handler_result['artifact_id'] ?? '' ) );

$audit_path      = $artifact_root . '/apply-audit.jsonl';
$audit_lines     = is_file( $audit_path ) ? array_values( array_filter( explode( "\n", trim( (string) file_get_contents( $audit_path ) ) ) ) ) : array();
$success_audit   = isset( $audit_lines[0] ) ? json_decode( $audit_lines[0], true ) : array();
$success_encoded = isset( $audit_lines[0] ) ? $audit_lines[0] : '';
$assert( 'approved artifact apply writes success audit record', is_array( $success_audit ) && 'wp-codebox/apply-audit/v1' === ( $success_audit['schema'] ?? '' ) && 'success' === ( $success_audit['status'] ?? '' ) );
$assert( 'success audit records reviewed principals and files', 'chat:user-7' === ( $success_audit['requester'] ?? '' ) && 'site-user:1' === ( $success_audit['approver'] ?? '' ) && array( '/wordpress/wp-content/plugins/example/generated.txt' ) === ( $success_audit['approved_files'] ?? array() ) );
$assert( 'success audit records digest and adapter metadata', $artifact_id === ( $success_audit['artifact_id'] ?? '' ) && $content_digest === ( $success_audit['content_digest'] ?? '' ) && 'test-adapter' === ( $success_audit['adapter'] ?? '' ) && 'https://github.com/chubes4/wp-codebox/pull/999' === ( $success_audit['result']['pr_url'] ?? '' ) );
$assert( 'success audit excludes raw patch body and secrets', ! str_contains( $success_encoded, 'diff --git' ) && ! str_contains( $success_encoded, 'secret-token-value' ) && '[redacted]' === ( $success_audit['result']['patch'] ?? '' ) && '[redacted]' === ( $success_audit['result']['access_token'] ?? '' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_apply_approved_artifact'] = function (): WP_Error {
	return new WP_Error( 'wp_codebox_adapter_failed', 'Adapter failed to apply artifact.', array( 'status' => 502, 'adapter' => 'test-adapter', 'patch' => 'diff --git should not persist', 'password' => 'secret-password-value' ) );
};
$failed_apply = $artifacts->apply_approved(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
		'approver'        => 'site-user:2',
	)
);
$audit_lines   = is_file( $audit_path ) ? array_values( array_filter( explode( "\n", trim( (string) file_get_contents( $audit_path ) ) ) ) ) : array();
$failure_audit = isset( $audit_lines[2] ) ? json_decode( $audit_lines[2], true ) : array();
$failure_encoded = isset( $audit_lines[2] ) ? $audit_lines[2] : '';
$assert( 'approved artifact apply writes adapter failure audit record', is_wp_error( $failed_apply ) && is_array( $failure_audit ) && 'failure' === ( $failure_audit['status'] ?? '' ) && 'test-adapter' === ( $failure_audit['adapter'] ?? '' ) && 'wp_codebox_adapter_failed' === ( $failure_audit['error']['code'] ?? '' ) );
$assert( 'failure audit records approver and excludes raw patch body and secrets', 'site-user:2' === ( $failure_audit['approver'] ?? '' ) && ! str_contains( $failure_encoded, 'diff --git' ) && ! str_contains( $failure_encoded, 'secret-password-value' ) && '[redacted]' === ( $failure_audit['error']['data']['patch'] ?? '' ) && '[redacted]' === ( $failure_audit['error']['data']['password'] ?? '' ) );

$unknown_apply = $artifacts->apply_approved(
	array(
		'artifacts_path' => $artifact_root,
		'artifact_id'    => $artifact_id,
		'approved_files' => array( '/wordpress/wp-content/plugins/example/unknown.txt' ),
	)
);
$assert( 'approved artifact rejects unknown files', is_wp_error( $unknown_apply ) && 'wp_codebox_approved_files_invalid' === $unknown_apply->get_error_code() );

$discarded = $artifacts->discard(
	array(
		'artifacts_path' => $artifact_root,
		'artifact_id'    => $artifact_id,
	)
);
$assert( 'artifact discard removes bundle inside root', ! is_wp_error( $discarded ) && ! is_dir( $bundle_dir ) );

if ( ! empty( $failures ) ) {
	echo "\nFAIL: " . count( $failures ) . " assertion(s) failed out of {$total}\n";
	foreach ( $failures as $failure ) {
		echo "  - {$failure}\n";
	}
	exit( 1 );
}

echo "\nOK ({$total} assertions)\n";
exit( 0 );
