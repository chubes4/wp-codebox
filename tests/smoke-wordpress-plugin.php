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
function get_option( string $name, mixed $default = null ): mixed { return $default; }

require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-sandbox-runner.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-artifacts.php';
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
$assert( 'runner does not pass raw code options', ! str_contains( $captured_command, '--code ' ) && ! str_contains( $captured_command, '--code-file' ) );

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

$artifact_root = $root . '/artifact-store';
$bundle_dir    = $artifact_root . '/runtime-test';
mkdir( $bundle_dir . '/files', 0777, true );
file_put_contents(
	$bundle_dir . '/manifest.json',
	json_encode(
		array(
			'id'        => 'artifact-bundle-test',
			'createdAt' => '2026-05-19T00:00:00Z',
			'files'     => array(
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
			),
		),
		JSON_PRETTY_PRINT
	) . "\n"
);
file_put_contents( $bundle_dir . '/metadata.json', json_encode( array( 'artifacts' => array( 'patch' => 'files/patch.diff' ) ), JSON_PRETTY_PRINT ) . "\n" );
file_put_contents(
	$bundle_dir . '/files/changed-files.json',
	json_encode(
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
	) . "\n"
);
file_put_contents( $bundle_dir . '/files/patch.diff', "diff --git a/generated.txt b/generated.txt\n+cooked\n" );

$artifacts = new WP_Codebox_Artifacts();
$listed    = $artifacts->list( array( 'artifacts_path' => $artifact_root ) );
$assert( 'artifact listing succeeds', ! is_wp_error( $listed ) && 1 === count( $listed['artifacts'] ?? array() ) );

$read_artifact = $artifacts->get(
	array(
		'artifacts_path' => $artifact_root,
		'artifact_id'    => 'artifact-bundle-test',
	)
);
$assert( 'artifact get returns canonical changed files', ! is_wp_error( $read_artifact ) && 'wp-codebox/changed-files/v1' === ( $read_artifact['artifact']['changed_files']['schema'] ?? '' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_apply_approved_artifact'] = function ( mixed $value, array $payload ): array {
	return array(
		'adapter'       => 'test-adapter',
		'artifact_id'   => $payload['artifact_id'],
		'patch_sha256'  => $payload['patch_sha256'],
		'patch_contains' => str_contains( $payload['patch'], 'cooked' ),
	);
};
$applied = $artifacts->apply_approved(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => 'artifact-bundle-test',
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
		'approver'        => 'site-user:1',
	)
);
$assert( 'approved artifact apply delegates exact patch', ! is_wp_error( $applied ) && true === ( $applied['result']['patch_contains'] ?? false ) && hash( 'sha256', "diff --git a/generated.txt b/generated.txt\n+cooked\n" ) === ( $applied['patch_sha256'] ?? '' ) );

$unknown_apply = $artifacts->apply_approved(
	array(
		'artifacts_path' => $artifact_root,
		'artifact_id'    => 'artifact-bundle-test',
		'approved_files' => array( '/wordpress/wp-content/plugins/example/unknown.txt' ),
	)
);
$assert( 'approved artifact rejects unknown files', is_wp_error( $unknown_apply ) && 'wp_codebox_approved_files_invalid' === $unknown_apply->get_error_code() );

$discarded = $artifacts->discard(
	array(
		'artifacts_path' => $artifact_root,
		'artifact_id'    => 'artifact-bundle-test',
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
