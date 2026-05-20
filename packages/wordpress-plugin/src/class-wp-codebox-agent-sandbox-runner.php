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
	private const TASK_INPUT_SCHEMA = 'wp-codebox/task-input/v1';

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

		$task_input = $this->task_input( $input );
		if ( is_wp_error( $task_input ) ) {
			return $task_input;
		}
		$task        = (string) $task_input['goal'];
		$task_prompt = $this->task_input_prompt( $task_input );

		$raw_code_input = $this->reject_raw_code_input( $input );
		if ( is_wp_error( $raw_code_input ) ) {
			return $raw_code_input;
		}

		$paths = $this->resolve_component_paths( $input );
		if ( is_wp_error( $paths ) ) {
			return $paths;
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

		$recipe_file = $this->write_agent_recipe( $paths, $input, array( $task_prompt ), $wp_version );
		if ( is_wp_error( $recipe_file ) ) {
			return $recipe_file;
		}

		$command = sprintf(
			'%s recipe-run --recipe %s --artifacts %s --json',
			$this->command_prefix( $bin ),
			escapeshellarg( $recipe_file ),
			escapeshellarg( $artifacts )
		);

		$result    = $this->run_command( $command );
		@unlink( $recipe_file );
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
			'task_input' => $task_input,
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

		$task_inputs = $this->task_inputs( $input );
		if ( is_wp_error( $task_inputs ) ) {
			return $task_inputs;
		}

		if ( empty( $task_inputs ) ) {
			return new WP_Error( 'wp_codebox_tasks_missing', 'tasks must include at least one task.', array( 'status' => 400 ) );
		}
		$tasks        = array_map( static fn( array $task_input ): string => (string) $task_input['goal'], $task_inputs );
		$task_prompts = array_map( array( $this, 'task_input_prompt' ), $task_inputs );

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
		$recipe_file = $this->write_agent_recipe( $paths, $input, $task_prompts, $wp_version );
		if ( is_wp_error( $recipe_file ) ) {
			return $recipe_file;
		}

		$command = sprintf(
			'%s recipe-run --recipe %s --artifacts %s --json',
			$this->command_prefix( $bin ),
			escapeshellarg( $recipe_file ),
			escapeshellarg( $artifacts )
		);

		$result    = $this->run_command( $command );
		@unlink( $recipe_file );
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
			'task_inputs' => $task_inputs,
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

	/** @param array<string,mixed> $input Ability input. @return true|WP_Error */
	private function reject_raw_code_input( array $input ): true|WP_Error {
		foreach ( array( 'code', 'code_file' ) as $field ) {
			if ( ! array_key_exists( $field, $input ) ) {
				continue;
			}

			$value = $input[ $field ];
			if ( null === $value || '' === trim( (string) $value ) ) {
				continue;
			}

			return new WP_Error(
				'wp_codebox_raw_code_forbidden',
				'Raw PHP code inputs are not accepted by wp-codebox/run-agent-task. Use the operator CLI debug path for raw PHP execution.',
				array(
					'status' => 400,
					'field'  => $field,
				)
			);
		}

		return true;
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
		$task_inputs = $this->task_inputs( $input );
		if ( is_wp_error( $task_inputs ) ) {
			return array();
		}

		return array_map( static fn( array $task_input ): string => (string) $task_input['goal'], $task_inputs );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private function task_input( array $input ): array|WP_Error {
		$goal = trim( (string) ( $input['goal'] ?? $input['task'] ?? '' ) );
		if ( '' === $goal ) {
			return new WP_Error( 'wp_codebox_task_missing', 'goal is required.', array( 'status' => 400 ) );
		}

		$task_input = array(
			'schema' => self::TASK_INPUT_SCHEMA,
			'goal'   => $goal,
		);

		foreach ( array( 'target', 'policy', 'context' ) as $field ) {
			if ( isset( $input[ $field ] ) && is_array( $input[ $field ] ) ) {
				$task_input[ $field ] = $input[ $field ];
			}
		}

		foreach ( array( 'allowed_tools', 'expected_artifacts' ) as $field ) {
			$values = $this->string_list( $input[ $field ] ?? array() );
			if ( ! empty( $values ) ) {
				$task_input[ $field ] = $values;
			}
		}

		return $task_input;
	}

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
	private function task_inputs( array $input ): array|WP_Error {
		$tasks = is_array( $input['tasks'] ?? null ) ? $input['tasks'] : array();

		$task_inputs = array();
		foreach ( $tasks as $task ) {
			$normalized = is_array( $task ) ? $this->task_input( $task ) : $this->task_input( array( 'task' => $task ) );
			if ( is_wp_error( $normalized ) ) {
				continue;
			}

			$task_inputs[] = $normalized;
		}

		return $task_inputs;
	}

	/** @param array<string,mixed> $task_input Normalized task input. */
	private function task_input_prompt( array $task_input ): string {
		$encoded = function_exists( 'wp_json_encode' ) ? wp_json_encode( $task_input, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) : json_encode( $task_input, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );

		return is_string( $encoded ) ? $encoded : '';
	}

	/** @return string[] */
	private function string_list( mixed $values ): array {
		if ( ! is_array( $values ) ) {
			return array();
		}

		return array_values(
			array_unique(
				array_filter(
					array_map(
						static fn( $value ): string => trim( (string) $value ),
						$values
					),
					static fn( string $value ): bool => '' !== $value
				)
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

	/**
	 * @param array{agents_api:string,data_machine:string,data_machine_code:string} $paths Component paths.
	 * @param array<string,mixed> $input Ability input.
	 * @param string[] $task_prompts Encoded task prompts.
	 */
	private function write_agent_recipe( array $paths, array $input, array $task_prompts, string $wp_version ): string|WP_Error {
		$provider_plugins = array_map(
			fn( string $path ): array => array(
				'source'   => $path,
				'slug'     => basename( $path ),
				'activate' => false,
			),
			$this->provider_plugin_paths( $input )
		);

		$provider_slugs = array_map( static fn( array $plugin ): string => (string) $plugin['slug'], $provider_plugins );
		$steps          = array();
		foreach ( $task_prompts as $task_prompt ) {
			$args = array(
				'task=' . $task_prompt,
				'agent=' . $this->agent_slug( $input ),
				'mode=' . $this->mode( $input ),
				'provider=' . $this->provider( $input ),
				'model=' . $this->model( $input ),
				'provider-plugin-slugs=' . implode( ',', $provider_slugs ),
			);
			if ( ! empty( $input['session_id'] ) ) {
				$args[] = 'session-id=' . (string) $input['session_id'];
			}
			if ( ! empty( $input['max_turns'] ) ) {
				$args[] = 'max-turns=' . (string) max( 1, (int) $input['max_turns'] );
			}

			$steps[] = array(
				'command' => 'wp-codebox.agent-sandbox-run',
				'args'    => $args,
			);
		}

		$recipe = array(
			'schema'   => 'wp-codebox/workspace-recipe/v1',
			'runtime'  => array(
				'wp'        => $wp_version,
				'blueprint' => array( 'steps' => array() ),
			),
			'inputs'   => array(
				'extraPlugins' => array_merge(
					array(
						array( 'source' => $paths['agents_api'], 'slug' => 'agents-api', 'activate' => false ),
						array( 'source' => $paths['data_machine'], 'slug' => 'data-machine', 'activate' => false ),
						array( 'source' => $paths['data_machine_code'], 'slug' => 'data-machine-code', 'activate' => false ),
					),
					$provider_plugins
				),
				'secretEnv'    => $this->secret_env_names( $input ),
			),
			'workflow' => array( 'steps' => $steps ),
		);

		$file = tempnam( sys_get_temp_dir(), 'wp-codebox-recipe-' );
		if ( false === $file ) {
			return new WP_Error( 'wp_codebox_recipe_temp_failed', 'Could not create a temporary WP Codebox recipe.', array( 'status' => 500 ) );
		}

		$encoded = function_exists( 'wp_json_encode' ) ? wp_json_encode( $recipe, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) : json_encode( $recipe, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		if ( ! is_string( $encoded ) || false === file_put_contents( $file, $encoded ) ) {
			@unlink( $file );
			return new WP_Error( 'wp_codebox_recipe_write_failed', 'Could not write the temporary WP Codebox recipe.', array( 'status' => 500 ) );
		}

		return $file;
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
