<?php
/**
 * Pure-PHP smoke for the Sandbox Runtime WordPress plugin ability surface.
 *
 * Run: php tests/smoke-wordpress-plugin.php
 */

declare( strict_types=1 );

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', sys_get_temp_dir() . '/sandbox-runtime-wordpress-plugin/' );
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

$GLOBALS['sandbox_runtime_registered_abilities'] = array();
$GLOBALS['sandbox_runtime_filters']              = array();

function wp_register_ability( string $name, array $definition ): void {
	$GLOBALS['sandbox_runtime_registered_abilities'][ $name ] = $definition;
}

function doing_action( string $hook ): bool { return 'wp_abilities_api_init' === $hook; }
function add_action( string $hook, callable $callback, int $priority = 10 ): void {}
function current_user_can( string $capability ): bool { return 'manage_options' === $capability; }
function apply_filters( string $hook, mixed $value ): mixed { return $GLOBALS['sandbox_runtime_filters'][ $hook ] ?? $value; }
function get_option( string $name, mixed $default = null ): mixed { return $default; }

require __DIR__ . '/../packages/wordpress-plugin/src/class-sandbox-runtime-agent-sandbox-runner.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-sandbox-runtime-abilities.php';

$root = sys_get_temp_dir() . '/sandbox-runtime-wordpress-plugin-' . getmypid();
foreach ( array( 'agents-api', 'data-machine', 'data-machine-code', 'ai-provider-for-openai', 'artifacts' ) as $dir ) {
	mkdir( $root . '/' . $dir, 0777, true );
}
file_put_contents( $root . '/sandbox-runtime.js', "#!/usr/bin/env node\n" );

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

echo "Sandbox Runtime WordPress plugin - smoke\n";

new Sandbox_Runtime_Abilities();

$ability = $GLOBALS['sandbox_runtime_registered_abilities']['sandbox-runtime/run-agent-task'] ?? null;
$assert( 'run-agent-task ability registered', is_array( $ability ) );
$assert( 'ability is REST visible', true === ( $ability['meta']['show_in_rest'] ?? false ) );
$assert( 'ability requires task only', array( 'task' ) === ( $ability['input_schema']['required'] ?? array() ) );
$assert( 'permission defaults to manage_options', true === call_user_func( $ability['permission_callback'] ) );

$GLOBALS['sandbox_runtime_filters']['sandbox_runtime_component_paths'] = array(
	'agents_api'        => $root . '/agents-api',
	'data_machine'      => $root . '/data-machine',
	'data_machine_code' => $root . '/data-machine-code',
	'openai_provider'   => $root . '/ai-provider-for-openai',
);
$GLOBALS['sandbox_runtime_filters']['sandbox_runtime_bin'] = $root . '/sandbox-runtime.js';

$captured_command = '';
$runner           = new Sandbox_Runtime_Agent_Sandbox_Runner(
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
$assert( 'runner schema is stable', ! is_wp_error( $result ) && 'sandbox-runtime/agent-task-run/v1' === ( $result['schema'] ?? '' ) );
$assert( 'runner invokes agent-sandbox-run', str_contains( $captured_command, 'agent-sandbox-run' ) );
$assert( 'runner uses node for JS CLI', str_contains( $captured_command, 'node ' ) );
$assert( 'runner passes task', str_contains( $captured_command, '--task' ) );

$missing_task = $runner->run( array( 'artifacts_path' => $root . '/artifacts' ) );
$assert( 'missing task fails closed', is_wp_error( $missing_task ) && 'sandbox_runtime_task_missing' === $missing_task->get_error_code() );

if ( ! empty( $failures ) ) {
	echo "\nFAIL: " . count( $failures ) . " assertion(s) failed out of {$total}\n";
	foreach ( $failures as $failure ) {
		echo "  - {$failure}\n";
	}
	exit( 1 );
}

echo "\nOK ({$total} assertions)\n";
exit( 0 );
