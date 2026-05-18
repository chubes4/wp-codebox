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

function wp_register_ability( string $name, array $definition ): void {
	$GLOBALS['wp_codebox_registered_abilities'][ $name ] = $definition;
}

function doing_action( string $hook ): bool { return 'wp_abilities_api_init' === $hook; }
function add_action( string $hook, callable $callback, int $priority = 10 ): void {}
function current_user_can( string $capability ): bool { return 'manage_options' === $capability; }
function apply_filters( string $hook, mixed $value ): mixed { return $GLOBALS['wp_codebox_filters'][ $hook ] ?? $value; }
function get_option( string $name, mixed $default = null ): mixed { return $default; }

require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-sandbox-runner.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-abilities.php';

$root = sys_get_temp_dir() . '/wp-codebox-wordpress-plugin-' . getmypid();
foreach ( array( 'agents-api', 'data-machine', 'data-machine-code', 'ai-provider-test', 'artifacts' ) as $dir ) {
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

new WP_Codebox_Abilities();

$ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/run-agent-task'] ?? null;
$assert( 'run-agent-task ability registered', is_array( $ability ) );
$assert( 'ability is REST visible', true === ( $ability['meta']['show_in_rest'] ?? false ) );
$assert( 'ability requires task only', array( 'task' ) === ( $ability['input_schema']['required'] ?? array() ) );
$assert( 'permission defaults to manage_options', true === call_user_func( $ability['permission_callback'] ) );

$batch_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/run-agent-task-batch'] ?? null;
$assert( 'run-agent-task-batch ability registered', is_array( $batch_ability ) );
$assert( 'batch ability is REST visible', true === ( $batch_ability['meta']['show_in_rest'] ?? false ) );
$assert( 'batch ability requires tasks', array( 'tasks' ) === ( $batch_ability['input_schema']['required'] ?? array() ) );

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
$runner           = new WP_Codebox_Agent_Sandbox_Runner(
	array(
		'shell_available' => fn() => true,
		'command_runner'  => function ( string $command ) use ( &$captured_command ): array {
			$captured_command = $command;
			return array(
				'exit_code' => 0,
				'output'    => json_encode(
					array(
						'success' => true,
						'runtime' => array( 'backend' => 'wordpress-playground' ),
					)
				),
			);
		},
	)
);

$result = $runner->run(
	array(
		'task'           => 'Run a chat-requested sandbox task.',
		'artifacts_path' => $root . '/artifacts',
	)
);

$assert( 'runner succeeds with filter-provided component paths', ! is_wp_error( $result ) && true === ( $result['success'] ?? false ) );
$assert( 'runner schema is stable', ! is_wp_error( $result ) && 'wp-codebox/agent-task-run/v1' === ( $result['schema'] ?? '' ) );
$assert( 'runner invokes agent-sandbox-run', str_contains( $captured_command, 'agent-sandbox-run' ) );
$assert( 'runner uses node for JS CLI', str_contains( $captured_command, 'node ' ) );
$assert( 'runner passes task', str_contains( $captured_command, '--task' ) );
$assert( 'runner passes default agent', str_contains( $captured_command, '--agent' ) && str_contains( $captured_command, 'site-coder' ) );
$assert( 'runner passes sandbox mode', str_contains( $captured_command, '--mode' ) && str_contains( $captured_command, 'sandbox' ) );
$assert( 'runner passes default provider', str_contains( $captured_command, '--provider' ) && str_contains( $captured_command, 'openai' ) );
$assert( 'runner passes default model', str_contains( $captured_command, '--model' ) && str_contains( $captured_command, 'gpt-5.5' ) );
$assert( 'runner passes provider plugin path', str_contains( $captured_command, '--provider-plugin' ) && str_contains( $captured_command, 'ai-provider-test' ) );
$assert( 'runner passes secret env name only', str_contains( $captured_command, '--secret-env' ) && str_contains( $captured_command, 'OPENAI_API_KEY' ) );

$batch_result = $runner->run_batch(
	array(
		'tasks'          => array( 'Fix issue one.', 'Fix issue two.' ),
		'concurrency'    => 2,
		'artifacts_path' => $root . '/artifacts',
	)
);

$assert( 'batch runner succeeds with filter-provided component paths', ! is_wp_error( $batch_result ) && true === ( $batch_result['success'] ?? false ) );
$assert( 'batch runner schema is stable', ! is_wp_error( $batch_result ) && 'wp-codebox/agent-task-batch/v1' === ( $batch_result['schema'] ?? '' ) );
$assert( 'batch runner invokes agent-sandbox-batch', str_contains( $captured_command, 'agent-sandbox-batch' ) );
$assert( 'batch runner passes repeated tasks', 2 === substr_count( $captured_command, '--task' ) );
$assert( 'batch runner passes concurrency', str_contains( $captured_command, '--concurrency' ) && str_contains( $captured_command, '2' ) );
$assert( 'batch runner passes default provider', str_contains( $captured_command, '--provider' ) && str_contains( $captured_command, 'openai' ) );
$assert( 'batch runner passes default model', str_contains( $captured_command, '--model' ) && str_contains( $captured_command, 'gpt-5.5' ) );
$assert( 'batch runner passes provider plugin path', str_contains( $captured_command, '--provider-plugin' ) && str_contains( $captured_command, 'ai-provider-test' ) );
$assert( 'batch runner passes secret env name only', str_contains( $captured_command, '--secret-env' ) && str_contains( $captured_command, 'OPENAI_API_KEY' ) );

$missing_task = $runner->run( array( 'artifacts_path' => $root . '/artifacts' ) );
$assert( 'missing task fails closed', is_wp_error( $missing_task ) && 'wp_codebox_task_missing' === $missing_task->get_error_code() );

$missing_tasks = $runner->run_batch( array( 'artifacts_path' => $root . '/artifacts' ) );
$assert( 'missing batch tasks fails closed', is_wp_error( $missing_tasks ) && 'wp_codebox_tasks_missing' === $missing_tasks->get_error_code() );

if ( ! empty( $failures ) ) {
	echo "\nFAIL: " . count( $failures ) . " assertion(s) failed out of {$total}\n";
	foreach ( $failures as $failure ) {
		echo "  - {$failure}\n";
	}
	exit( 1 );
}

echo "\nOK ({$total} assertions)\n";
exit( 0 );
