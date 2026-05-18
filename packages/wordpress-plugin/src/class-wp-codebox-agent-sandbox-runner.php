<?php
/**
 * Host-side WP Codebox agent sandbox runner.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Agent_Sandbox_Runner {

	private const SCHEMA = 'wp-codebox/agent-task-run/v1';
	private const BATCH_SCHEMA = 'wp-codebox/agent-task-batch/v1';

	/** @var array<string, callable> */
	private array $callbacks;

	/**
	 * @param array<string, callable> $callbacks Test seams for pure-PHP smoke coverage.
	 */
	public function __construct( array $callbacks = array() ) {
		$this->callbacks = $callbacks;
	}

	/**
	 * Run a task inside an isolated WP Codebox agent sandbox.
	 *
	 * @param array<string,mixed> $input Ability input.
	 * @return array<string,mixed>|WP_Error
	 */
	public function run( array $input ): array|WP_Error {
		if ( ! $this->shell_available() ) {
			return new WP_Error( 'wp_codebox_shell_unavailable', 'Shell execution is not available for WP Codebox.', array( 'status' => 500 ) );
		}

		$task = trim( (string) ( $input['task'] ?? '' ) );
		if ( '' === $task ) {
			return new WP_Error( 'wp_codebox_task_missing', 'task is required.', array( 'status' => 400 ) );
		}

		$paths = $this->resolve_component_paths( $input );
		if ( is_wp_error( $paths ) ) {
			return $paths;
		}

		$code      = trim( (string) ( $input['code'] ?? '' ) );
		$code_file = $this->clean_path( (string) ( $input['code_file'] ?? '' ) );
		if ( '' !== $code && '' !== $code_file ) {
			return new WP_Error( 'wp_codebox_code_conflict', 'Use either code or code_file, not both.', array( 'status' => 400 ) );
		}

		$artifacts = $this->clean_path( (string) ( $input['artifacts_path'] ?? $this->default_artifacts_path() ) );
		$wp_version = trim( (string) ( $input['wp'] ?? 'trunk' ) );
		if ( '' === $wp_version ) {
			$wp_version = 'trunk';
		}

		$bin = trim( (string) ( $input['wp_codebox_bin'] ?? $this->default_bin() ) );
		if ( '' === $bin || ! preg_match( '#^[A-Za-z0-9_./:@+-]+$#', $bin ) ) {
			return new WP_Error( 'wp_codebox_bin_invalid', 'wp_codebox_bin must be a command name or path without shell metacharacters.', array( 'status' => 400 ) );
		}

		$command = sprintf(
			'%s agent-sandbox-run --agents-api %s --data-machine %s --data-machine-code %s --task %s --agent %s --mode %s --provider %s --model %s --wp %s --artifacts %s --json',
			$this->command_prefix( $bin ),
			escapeshellarg( $paths['agents_api'] ),
			escapeshellarg( $paths['data_machine'] ),
			escapeshellarg( $paths['data_machine_code'] ),
			escapeshellarg( $task ),
			escapeshellarg( $this->agent_slug( $input ) ),
			escapeshellarg( $this->mode( $input ) ),
			escapeshellarg( $this->provider( $input ) ),
			escapeshellarg( $this->model( $input ) ),
			escapeshellarg( $wp_version ),
			escapeshellarg( $artifacts )
		);

		foreach ( $this->provider_plugin_paths( $input ) as $provider_plugin_path ) {
			$command .= ' --provider-plugin ' . escapeshellarg( $provider_plugin_path );
		}

		if ( ! empty( $input['session_id'] ) ) {
			$command .= ' --session-id ' . escapeshellarg( (string) $input['session_id'] );
		}

		if ( ! empty( $input['max_turns'] ) ) {
			$command .= ' --max-turns ' . escapeshellarg( (string) max( 1, (int) $input['max_turns'] ) );
		}

		if ( '' !== $code ) {
			$command .= ' --code ' . escapeshellarg( $code );
		}

		if ( '' !== $code_file ) {
			$command .= ' --code-file ' . escapeshellarg( $code_file );
		}

		foreach ( $this->secret_env_names( $input ) as $secret_env ) {
			$command .= ' --secret-env ' . escapeshellarg( $secret_env );
		}

		$result    = $this->run_command( $command );
		$exit_code = (int) ( $result['exit_code'] ?? 1 );
		$output    = (string) ( $result['output'] ?? '' );
		$decoded   = $this->decode_json_output( $output );

		if ( is_wp_error( $decoded ) ) {
			return new WP_Error(
				'wp_codebox_json_invalid',
				'WP Codebox did not return valid JSON: ' . $decoded->get_error_message(),
				array(
					'status'    => 500,
					'exit_code' => $exit_code,
					'output'    => $this->bound_output( $output ),
				)
			);
		}

		if ( 0 !== $exit_code ) {
			return new WP_Error(
				'wp_codebox_run_failed',
				'WP Codebox agent sandbox run failed.',
				array(
					'status'    => 500,
					'exit_code' => $exit_code,
					'output'    => $this->bound_output( $output ),
					'run'       => $decoded,
				)
			);
		}

		return array(
			'success'   => true,
			'schema'    => self::SCHEMA,
			'task'      => $task,
			'wp'        => $wp_version,
			'paths'     => $paths,
			'artifacts' => $artifacts,
			'exit_code' => $exit_code,
			'run'       => $decoded,
		);
	}

	/**
	 * Run multiple tasks, each in its own isolated WP Codebox agent sandbox.
	 *
	 * @param array<string,mixed> $input Ability input.
	 * @return array<string,mixed>|WP_Error
	 */
	public function run_batch( array $input ): array|WP_Error {
		if ( ! $this->shell_available() ) {
			return new WP_Error( 'wp_codebox_shell_unavailable', 'Shell execution is not available for WP Codebox.', array( 'status' => 500 ) );
		}

		$tasks = $this->tasks( $input );
		if ( empty( $tasks ) ) {
			return new WP_Error( 'wp_codebox_tasks_missing', 'tasks must include at least one task.', array( 'status' => 400 ) );
		}

		$paths = $this->resolve_component_paths( $input );
		if ( is_wp_error( $paths ) ) {
			return $paths;
		}

		$artifacts  = $this->clean_path( (string) ( $input['artifacts_path'] ?? $this->default_artifacts_path() ) );
		$wp_version = trim( (string) ( $input['wp'] ?? 'trunk' ) );
		if ( '' === $wp_version ) {
			$wp_version = 'trunk';
		}

		$bin = trim( (string) ( $input['wp_codebox_bin'] ?? $this->default_bin() ) );
		if ( '' === $bin || ! preg_match( '#^[A-Za-z0-9_./:@+-]+$#', $bin ) ) {
			return new WP_Error( 'wp_codebox_bin_invalid', 'wp_codebox_bin must be a command name or path without shell metacharacters.', array( 'status' => 400 ) );
		}

		$concurrency = max( 1, (int) ( $input['concurrency'] ?? 2 ) );
		$command     = sprintf(
			'%s agent-sandbox-batch --agents-api %s --data-machine %s --data-machine-code %s --agent %s --mode %s --provider %s --model %s --concurrency %s --wp %s --artifacts %s --json',
			$this->command_prefix( $bin ),
			escapeshellarg( $paths['agents_api'] ),
			escapeshellarg( $paths['data_machine'] ),
			escapeshellarg( $paths['data_machine_code'] ),
			escapeshellarg( $this->agent_slug( $input ) ),
			escapeshellarg( $this->mode( $input ) ),
			escapeshellarg( $this->provider( $input ) ),
			escapeshellarg( $this->model( $input ) ),
			escapeshellarg( (string) $concurrency ),
			escapeshellarg( $wp_version ),
			escapeshellarg( $artifacts )
		);

		foreach ( $this->provider_plugin_paths( $input ) as $provider_plugin_path ) {
			$command .= ' --provider-plugin ' . escapeshellarg( $provider_plugin_path );
		}

		if ( ! empty( $input['max_turns'] ) ) {
			$command .= ' --max-turns ' . escapeshellarg( (string) max( 1, (int) $input['max_turns'] ) );
		}

		foreach ( $this->secret_env_names( $input ) as $secret_env ) {
			$command .= ' --secret-env ' . escapeshellarg( $secret_env );
		}

		foreach ( $tasks as $task ) {
			$command .= ' --task ' . escapeshellarg( $task );
		}

		$result    = $this->run_command( $command );
		$exit_code = (int) ( $result['exit_code'] ?? 1 );
		$output    = (string) ( $result['output'] ?? '' );
		$decoded   = $this->decode_json_output( $output );

		if ( is_wp_error( $decoded ) ) {
			return new WP_Error(
				'wp_codebox_json_invalid',
				'WP Codebox did not return valid JSON: ' . $decoded->get_error_message(),
				array(
					'status'    => 500,
					'exit_code' => $exit_code,
					'output'    => $this->bound_output( $output ),
				)
			);
		}

		if ( 0 !== $exit_code ) {
			return new WP_Error(
				'wp_codebox_batch_failed',
				'WP Codebox agent sandbox batch failed.',
				array(
					'status'    => 500,
					'exit_code' => $exit_code,
					'output'    => $this->bound_output( $output ),
					'run'       => $decoded,
				)
			);
		}

		return array(
			'success'     => true,
			'schema'      => self::BATCH_SCHEMA,
			'tasks'       => $tasks,
			'concurrency' => $concurrency,
			'wp'          => $wp_version,
			'paths'       => $paths,
			'artifacts'   => $artifacts,
			'exit_code'   => $exit_code,
			'run'         => $decoded,
		);
	}

	/**
	 * @param array<string,mixed> $input Ability input.
	 * @return array{agents_api:string,data_machine:string,data_machine_code:string}|WP_Error
	 */
	private function resolve_component_paths( array $input ): array|WP_Error {
		$configured = $this->configured_paths();
		$paths      = array(
			'agents_api'        => $this->clean_path( (string) ( $input['agents_api_path'] ?? $configured['agents_api'] ?? '' ) ),
			'data_machine'      => $this->clean_path( (string) ( $input['data_machine_path'] ?? $configured['data_machine'] ?? '' ) ),
			'data_machine_code' => $this->clean_path( (string) ( $input['data_machine_code_path'] ?? $configured['data_machine_code'] ?? '' ) ),
		);

		foreach ( $paths as $key => $path ) {
			if ( '' === $path || ! is_dir( $path ) ) {
				return new WP_Error( 'wp_codebox_component_path_missing', sprintf( 'WP Codebox component path %s is missing or not a directory.', $key ), array( 'status' => 400 ) );
			}
		}

		return $paths;
	}

	/** @return array<string,string> */
	private function configured_paths(): array {
		$paths = array();
		if ( function_exists( 'get_option' ) ) {
			$option = get_option( 'wp_codebox_component_paths', array() );
			if ( is_array( $option ) ) {
				$paths = $option;
			}
		}

		if ( function_exists( 'apply_filters' ) ) {
			$paths = apply_filters( 'wp_codebox_component_paths', $paths );
		}

		return is_array( $paths ) ? $paths : array();
	}

	private function shell_available(): bool {
		if ( isset( $this->callbacks['shell_available'] ) ) {
			return (bool) ( $this->callbacks['shell_available'] )();
		}

		return function_exists( 'exec' ) && function_exists( 'shell_exec' );
	}

	private function agent_slug( array $input ): string {
		$agent = trim( (string) ( $input['agent'] ?? '' ) );
		if ( '' !== $agent ) {
			return $agent;
		}

		if ( function_exists( 'apply_filters' ) ) {
			$agent = (string) apply_filters( 'wp_codebox_default_agent', '' );
		}

		return '' !== trim( $agent ) ? trim( $agent ) : 'sandbox-agent';
	}

	private function mode( array $input ): string {
		$mode = trim( (string) ( $input['mode'] ?? '' ) );

		return '' !== $mode ? $mode : 'sandbox';
	}

	private function provider( array $input ): string {
		$provider = trim( (string) ( $input['provider'] ?? '' ) );
		if ( '' !== $provider ) {
			return $provider;
		}

		if ( function_exists( 'apply_filters' ) ) {
			$provider = (string) apply_filters( 'wp_codebox_default_provider', '' );
		}

		return trim( $provider );
	}

	private function model( array $input ): string {
		$model = trim( (string) ( $input['model'] ?? '' ) );
		if ( '' !== $model ) {
			return $model;
		}

		if ( function_exists( 'apply_filters' ) ) {
			$model = (string) apply_filters( 'wp_codebox_default_model', '' );
		}

		return trim( $model );
	}

	/** @param array<string,mixed> $input Ability input. @return string[] */
	private function provider_plugin_paths( array $input ): array {
		$configured = $this->configured_paths();
		$paths      = is_array( $input['provider_plugin_paths'] ?? null ) ? $input['provider_plugin_paths'] : ( $configured['provider_plugins'] ?? array() );

		if ( ! is_array( $paths ) ) {
			return array();
		}

		return array_values(
			array_filter(
				array_map(
					fn( $path ): string => $this->clean_path( (string) $path ),
					$paths
				),
				static fn( string $path ): bool => '' !== $path && is_dir( $path )
			)
		);
	}

	/** @param array<string,mixed> $input Ability input. @return string[] */
	private function secret_env_names( array $input ): array {
		$names = is_array( $input['secret_env'] ?? null ) ? $input['secret_env'] : array();
		if ( empty( $names ) && function_exists( 'apply_filters' ) ) {
			$names = apply_filters( 'wp_codebox_default_secret_env', array() );
		}

		if ( ! is_array( $names ) ) {
			return array();
		}

		return array_values(
			array_unique(
				array_filter(
					array_map(
						static fn( $name ): string => trim( (string) $name ),
						$names
					),
					static fn( string $name ): bool => 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name )
				)
			)
		);
	}

	/** @param array<string,mixed> $input Ability input. @return string[] */
	private function tasks( array $input ): array {
		$tasks = is_array( $input['tasks'] ?? null ) ? $input['tasks'] : array();

		return array_values(
			array_filter(
				array_map(
					static fn( $task ): string => trim( (string) $task ),
					$tasks
				),
				static fn( string $task ): bool => '' !== $task
			)
		);
	}

	private function default_artifacts_path(): string {
		$base = function_exists( 'wp_upload_dir' ) ? wp_upload_dir() : array( 'basedir' => sys_get_temp_dir() );
		$root = is_array( $base ) && ! empty( $base['basedir'] ) ? (string) $base['basedir'] : sys_get_temp_dir();

		return rtrim( $root, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . 'wp-codebox' . DIRECTORY_SEPARATOR . $this->generate_run_id();
	}

	private function default_bin(): string {
		$bin = 'wp-codebox';
		if ( function_exists( 'get_option' ) ) {
			$bin = (string) get_option( 'wp_codebox_bin', $bin );
		}

		if ( function_exists( 'apply_filters' ) ) {
			$bin = (string) apply_filters( 'wp_codebox_bin', $bin );
		}

		return $bin;
	}

	private function clean_path( string $path ): string {
		return rtrim( trim( $path ), DIRECTORY_SEPARATOR );
	}

	private function command_prefix( string $bin ): string {
		if ( str_ends_with( $bin, '.js' ) && is_file( $bin ) ) {
			return 'node ' . escapeshellarg( $bin );
		}

		return escapeshellarg( $bin );
	}

	private function generate_run_id(): string {
		if ( function_exists( 'wp_generate_uuid4' ) ) {
			return wp_generate_uuid4();
		}

		return bin2hex( random_bytes( 16 ) );
	}

	/** @return array<string,mixed>|WP_Error */
	private function decode_json_output( string $output ): array|WP_Error {
		$trimmed = trim( $output );
		if ( '' === $trimmed ) {
			return new WP_Error( 'empty_output', 'Empty output.' );
		}

		$decoded = json_decode( $trimmed, true );
		if ( is_array( $decoded ) ) {
			return $decoded;
		}

		$offset = strrpos( $trimmed, "\n{" );
		if ( false !== $offset ) {
			$decoded = json_decode( substr( $trimmed, $offset + 1 ), true );
			if ( is_array( $decoded ) ) {
				return $decoded;
			}
		}

		return new WP_Error( 'json_decode_failed', json_last_error_msg() );
	}

	/** @return array{exit_code:int,output:string} */
	private function run_command( string $command ): array {
		if ( isset( $this->callbacks['command_runner'] ) ) {
			return ( $this->callbacks['command_runner'] )( $command );
		}

		$output = array();
		$exit   = 0;
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.system_calls_exec -- Required host-side WP Codebox execution primitive.
		exec( $command . ' 2>&1', $output, $exit );

		return array(
			'exit_code' => $exit,
			'output'    => implode( "\n", $output ),
		);
	}

	private function bound_output( string $output ): string {
		if ( strlen( $output ) <= 4000 ) {
			return $output;
		}

		return substr( $output, 0, 4000 );
	}
}
