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
	private const SESSION_SCHEMA = WP_Codebox_Agent_Task::SESSION_SCHEMA;
	private const TASK_INPUT_SCHEMA = WP_Codebox_Agent_Task::INPUT_SCHEMA;
	private const TOOL_DENIAL_SCHEMA = 'wp-codebox/tool-allowlist-denial/v1';
	private const REMEDIATION_OUTCOME_SCHEMA = 'wp-codebox/agent-sandbox-remediation-outcome/v1';
	private const SANDBOX_TOOL_POLICY_FILE = __DIR__ . '/generated-sandbox-datamachine-tool-policy.php';

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
		$session_id  = $this->sandbox_session_id( $input );

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

		$command_prefix = $this->command_prefix( $bin );
		if ( is_wp_error( $command_prefix ) ) {
			return $command_prefix;
		}

		$preview_args = $this->preview_args( $input );
		if ( is_wp_error( $preview_args ) ) {
			return $preview_args;
		}

		$inheritance_payload = $this->inheritance_resolution_payload( $input );
		$recipe_payload      = $this->write_agent_recipe( $paths, $input, array( $task_prompt ), $wp_version, $inheritance_payload['inheritance'] );
		if ( is_wp_error( $recipe_payload ) ) {
			return $recipe_payload;
		}
		$recipe_file = (string) $recipe_payload['path'];

		$command = sprintf(
			'%s recipe-run --recipe %s --artifacts %s --json',
			$command_prefix,
			escapeshellarg( $recipe_file ),
			escapeshellarg( $artifacts )
		);
		$command .= $preview_args;

		$result    = $this->run_command( $command, $inheritance_payload['secret_env'] );
		@unlink( $recipe_file );
		foreach ( $recipe_payload['cleanup_paths'] as $cleanup_path ) {
			@unlink( (string) $cleanup_path );
		}
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

		$strict_remediation_outcome = $this->strict_remediation_outcome( $task_input );
		$outcome                    = $strict_remediation_outcome ? $this->remediation_outcome( $decoded, $exit_code, $output ) : null;

		if ( 0 !== $exit_code && ! $strict_remediation_outcome ) {
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

		$response = array(
			'success'   => $strict_remediation_outcome ? (bool) ( $outcome['success'] ?? false ) : true,
			'schema'    => self::SCHEMA,
			'session'   => $this->sandbox_session( $session_id, 'completed', $input, $decoded, $artifacts ),
			'task'      => $task,
			'task_input' => $task_input,
			'wp'        => $wp_version,
			'paths'        => $paths,
			'artifacts'    => $artifacts,
			'exit_code'    => $exit_code,
			'agent_result' => is_array( $decoded['agentResult'] ?? null ) ? $decoded['agentResult'] : array(),
			'run'          => $decoded,
		);

		if ( null !== $outcome ) {
			$response['outcome'] = $outcome;
		}

		return $response;
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
		$tasks      = array_map( static fn( array $task_input ): string => (string) $task_input['goal'], $task_inputs );
		$session_id = $this->sandbox_session_id( $input );

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

		$runs = array();
		foreach ( $task_inputs as $index => $task_input ) {
			$task_input_request = array_merge( $input, $task_input );
			unset( $task_input_request['tasks'], $task_input_request['task'], $task_input_request['concurrency'], $task_input_request['session_id'] );

			if ( ! empty( $input['sandbox_session_id'] ) ) {
				$task_input_request['sandbox_session_id'] = $session_id . ':' . ( $index + 1 );
			}

			$task_result = $this->run( $task_input_request );
			if ( is_wp_error( $task_result ) ) {
				$runs[] = array(
					'index'      => $index,
					'task'       => (string) $task_input['goal'],
					'task_input' => $task_input,
					'success'    => false,
					'status'     => 'failed',
					'error'      => $this->error_payload( $task_result ),
				);
				continue;
			}

			$runs[] = array(
				'index'       => $index,
				'task'        => (string) $task_input['goal'],
				'task_input'  => $task_input,
				'success'     => true,
				'status'      => 'completed',
				'exit_code'   => (int) ( $task_result['exit_code'] ?? 0 ),
				'session'     => $task_result['session'] ?? array(),
				'artifact_id' => (string) ( $task_result['session']['artifacts']['bundle_id'] ?? '' ),
				'preview_url' => (string) ( $task_result['session']['artifacts']['preview_url'] ?? '' ),
				'artifacts'    => $task_result['session']['artifacts'] ?? array(),
				'agent_result' => $task_result['agent_result'] ?? array(),
				'run'          => $task_result['run'] ?? array(),
			);
		}

		$completed = count( array_filter( $runs, static fn( array $run ): bool => true === ( $run['success'] ?? false ) ) );
		$failed    = count( $runs ) - $completed;

		return array(
			'success'     => 0 === $failed,
			'schema'      => self::BATCH_SCHEMA,
			'session'     => $this->sandbox_session( $session_id, 'completed', $input, array(), $artifacts ),
			'tasks'       => $tasks,
			'task_inputs' => $task_inputs,
			'execution'   => 'sequential-isolated-sandboxes',
			'total'       => count( $runs ),
			'completed'   => $completed,
			'failed'      => $failed,
			'wp'          => $wp_version,
			'paths'       => $paths,
			'artifacts'   => $artifacts,
			'runs'        => $runs,
		);
	}

	/**
	 * @param array<string,mixed> $input Ability input.
	 * @return array{agents_api:string,data_machine:string,data_machine_code:string}|WP_Error
	 */
	private function resolve_component_paths( array $input ): array|WP_Error {
		$configured = array_merge( $this->default_component_paths(), $this->configured_paths() );
		$paths      = array(
			'agents_api'        => $this->clean_path( (string) ( $input['agents_api_path'] ?? $configured['agents_api'] ?? '' ) ),
			'data_machine'      => $this->clean_path( (string) ( $input['data_machine_path'] ?? $configured['data_machine'] ?? '' ) ),
			'data_machine_code' => $this->clean_path( (string) ( $input['data_machine_code_path'] ?? $configured['data_machine_code'] ?? '' ) ),
		);

		foreach ( $paths as $key => $path ) {
			if ( '' === $path ) {
				if ( 'agents_api' !== $key ) {
					continue;
				}

				return new WP_Error( 'wp_codebox_component_path_missing', sprintf( 'WP Codebox component path %s is missing or not a directory.', $key ), array( 'status' => 400 ) );
			}

			if ( ! is_dir( $path ) ) {
				return new WP_Error( 'wp_codebox_component_path_missing', sprintf( 'WP Codebox component path %s is missing or not a directory.', $key ), array( 'status' => 400 ) );
			}
		}

		return $paths;
	}

	/** @return array{agents_api:string,data_machine:string,data_machine_code:string} */
	private function default_component_paths(): array {
		$paths = array(
			'agents_api'        => '',
			'data_machine'      => '',
			'data_machine_code' => '',
		);

		if ( ! defined( 'WP_PLUGIN_DIR' ) ) {
			return $paths;
		}

		$plugin_dir = $this->clean_path( (string) WP_PLUGIN_DIR );
		foreach (
			array(
				'agents_api'        => 'agents-api',
				'data_machine'      => 'data-machine',
				'data_machine_code' => 'data-machine-code',
			) as $key => $slug
		) {
			$path = $plugin_dir . DIRECTORY_SEPARATOR . $slug;
			if ( is_dir( $path ) ) {
				$paths[ $key ] = $path;
			}
		}

		return $paths;
	}

	/** @return array<string,mixed> */
	private function configured_paths(): array {
		$paths  = array();
		$option = $this->config_option( 'wp_codebox_component_paths', array() );
		if ( is_array( $option ) ) {
			$paths = $option;
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

	private function provider( array $input, ?array $inheritance = null ): string {
		$provider = trim( (string) ( $input['provider'] ?? '' ) );
		if ( '' !== $provider ) {
			return $provider;
		}

		$inheritance_provider = $this->inheritance_provider( $input, $inheritance );
		if ( '' !== $inheritance_provider ) {
			return $inheritance_provider;
		}

		if ( function_exists( 'apply_filters' ) ) {
			$provider = (string) apply_filters( 'wp_codebox_default_provider', '' );
		}

		return trim( $provider );
	}

	private function model( array $input, ?array $inheritance = null ): string {
		$model = trim( (string) ( $input['model'] ?? '' ) );
		if ( '' !== $model ) {
			return $model;
		}

		$inheritance_model = $this->inheritance_model( $input, $inheritance );
		if ( '' !== $inheritance_model ) {
			return $inheritance_model;
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
	private function secret_env_names( array $input, ?array $inheritance = null ): array {
		$names = is_array( $input['secret_env'] ?? null ) ? $input['secret_env'] : array();
		$names = array_merge( $names, $this->inheritance_secret_env_names( $input, $inheritance ) );
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

	/** @param array<string,mixed> $input Ability input. @return array{connectors:string[],settings:string[]} */
	private function inheritance_request( array $input ): array {
		$inherit = is_array( $input['inherit'] ?? null ) ? $input['inherit'] : array();

		return array(
			'connectors' => $this->string_list( $inherit['connectors'] ?? array() ),
			'settings'   => $this->string_list( $inherit['settings'] ?? array() ),
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} */
	private function inheritance_resolution( array $input ): array {
		return $this->inheritance_resolution_payload( $input )['inheritance'];
	}

	/** @param array<string,mixed> $input Ability input. @return array{inheritance:array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>},secret_env:array<string,string>} */
	private function inheritance_resolution_payload( array $input ): array {
		$request    = $this->inheritance_request( $input );
		$resolution = array(
			'connectors' => array_map(
				static fn( string $name ): array => array(
					'name'   => $name,
					'status' => 'unresolved',
				),
				$request['connectors']
			),
			'settings'   => array_map(
				static fn( string $name ): array => array(
					'name'   => $name,
					'status' => 'unresolved',
				),
				$request['settings']
			),
		);

		if ( function_exists( 'apply_filters' ) && ( ! empty( $request['connectors'] ) || ! empty( $request['settings'] ) ) ) {
			$filtered = apply_filters( 'wp_codebox_resolve_inheritance', $resolution, $request, $input );
			if ( is_array( $filtered ) ) {
				$resolution = $filtered;
			}
		}

		return array(
			'inheritance' => array(
				'connectors' => $this->sanitize_inheritance_connectors( $resolution['connectors'] ?? array() ),
				'settings'   => $this->sanitize_inheritance_settings( $resolution['settings'] ?? array() ),
			),
			'secret_env'  => $this->inheritance_secret_env_values( $resolution['connectors'] ?? array() ),
		);
	}

	/** @param array<int,mixed> $connectors Raw inheritance connector rows. @return array<string,string> */
	private function inheritance_secret_env_values( array $connectors ): array {
		$values = array();
		foreach ( $connectors as $connector ) {
			if ( ! is_array( $connector ) ) {
				continue;
			}

			foreach ( array( 'secret_env_values', 'secretEnvValues' ) as $field ) {
				if ( is_array( $connector[ $field ] ?? null ) ) {
					$values = array_merge( $values, $this->sanitize_secret_env_values( $connector[ $field ] ) );
				}
			}

			$credentials = is_array( $connector['credentials'] ?? null ) ? $connector['credentials'] : array();
			foreach ( is_array( $credentials['secrets'] ?? null ) ? $credentials['secrets'] : array() as $secret ) {
				if ( ! is_array( $secret ) || ! isset( $secret['value'] ) ) {
					continue;
				}

				$name = trim( (string) ( $secret['name'] ?? '' ) );
				if ( 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) {
					$value = (string) $secret['value'];
					if ( '' !== $value ) {
						$values[ $name ] = $value;
					}
				}
			}
		}

		return $values;
	}

	/** @param array<mixed> $raw_values Raw secret env map. @return array<string,string> */
	private function sanitize_secret_env_values( array $raw_values ): array {
		$values = array();
		foreach ( $raw_values as $name => $value ) {
			$name = trim( (string) $name );
			if ( 1 !== preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) {
				continue;
			}

			$value = (string) $value;
			if ( '' !== $value ) {
				$values[ $name ] = $value;
			}
		}

		return $values;
	}

	/** @param array<int,mixed> $connectors Inheritance connector rows. @return array<int,array<string,mixed>> */
	private function sanitize_inheritance_connectors( array $connectors ): array {
		$sanitized = array();
		foreach ( $connectors as $connector ) {
			if ( ! is_array( $connector ) ) {
				continue;
			}

			$name = trim( (string) ( $connector['name'] ?? '' ) );
			if ( '' === $name ) {
				continue;
			}

			$entry = array(
				'name'   => $name,
				'status' => trim( (string) ( $connector['status'] ?? 'resolved' ) ),
			);

			foreach ( array( 'provider', 'model' ) as $field ) {
				$value = trim( (string) ( $connector[ $field ] ?? '' ) );
				if ( '' !== $value ) {
					$entry[ $field ] = $value;
				}
			}

			$secret_env = $this->string_list( $connector['secret_env'] ?? $connector['secretEnv'] ?? array() );
			$secret_env = array_values( array_filter( $secret_env, static fn( string $name ): bool => 1 === preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) );
			if ( ! empty( $secret_env ) ) {
				$entry['secretEnv'] = array_values( array_unique( $secret_env ) );
			}

			$credentials = $this->sanitize_connector_credentials( $connector['credentials'] ?? null, $name );
			if ( ! empty( $credentials ) ) {
				$entry['credentials'] = $credentials;
			}

			$sanitized[] = $entry;
		}

		return $sanitized;
	}

	/** @return array<string,mixed> */
	private function sanitize_connector_credentials( mixed $credentials, string $connector_name ): array {
		if ( ! is_array( $credentials ) ) {
			return array();
		}

		$status = $this->credential_status( (string) ( $credentials['status'] ?? 'missing' ) );
		$entry  = array(
			'schema'    => 'wp-codebox/connector-credentials/v1',
			'connector' => $connector_name,
			'scope'     => 'connector',
			'status'    => $status,
			'secrets'   => array(),
		);

		$reason = $this->redacted_reason( $credentials['reason'] ?? '' );
		if ( '' !== $reason ) {
			$entry['reason'] = $reason;
		}

		foreach ( is_array( $credentials['secrets'] ?? null ) ? $credentials['secrets'] : array() as $secret ) {
			if ( ! is_array( $secret ) ) {
				continue;
			}

			$name = trim( (string) ( $secret['name'] ?? '' ) );
			if ( 1 !== preg_match( '/^[A-Z_][A-Z0-9_]*$/', $name ) ) {
				continue;
			}

			$secret_entry = array(
				'name'   => $name,
				'status' => $this->credential_status( (string) ( $secret['status'] ?? $status ) ),
			);

			foreach ( array( 'scope', 'source', 'reason' ) as $field ) {
				$value = 'reason' === $field ? $this->redacted_reason( $secret[ $field ] ?? '' ) : trim( (string) ( $secret[ $field ] ?? '' ) );
				if ( '' !== $value ) {
					$secret_entry[ $field ] = $value;
				}
			}

			$entry['secrets'][] = $secret_entry;
		}

		return $entry;
	}

	private function credential_status( string $status ): string {
		return in_array( $status, array( 'available', 'missing', 'denied' ), true ) ? $status : 'missing';
	}

	private function redacted_reason( mixed $reason ): string {
		$reason = trim( (string) $reason );
		if ( '' === $reason ) {
			return '';
		}

		return substr( preg_replace( '/[^A-Za-z0-9 .:_-]/', '', $reason ) ?? '', 0, 160 );
	}

	/** @param array{connectors:array<int,array<string,mixed>>,settings:array<int,array<string,mixed>>} $inheritance */
	private function connector_credentials_error( array $inheritance ): WP_Error|null {
		$failures = array();
		foreach ( $inheritance['connectors'] as $connector ) {
			$credentials = is_array( $connector['credentials'] ?? null ) ? $connector['credentials'] : array();
			if ( empty( $credentials ) ) {
				continue;
			}

			$status = (string) ( $credentials['status'] ?? 'missing' );
			$secrets = array_filter(
				is_array( $credentials['secrets'] ?? null ) ? $credentials['secrets'] : array(),
				static fn( mixed $secret ): bool => is_array( $secret ) && in_array( (string) ( $secret['status'] ?? '' ), array( 'missing', 'denied' ), true )
			);

			if ( in_array( $status, array( 'missing', 'denied' ), true ) || ! empty( $secrets ) ) {
				$failures[] = array(
					'name'        => (string) ( $connector['name'] ?? '' ),
					'status'      => (string) ( $connector['status'] ?? '' ),
					'credentials' => $credentials,
				);
			}
		}

		if ( empty( $failures ) ) {
			return null;
		}

		return new WP_Error(
			'wp_codebox_connector_credentials_unavailable',
			'Requested connector credentials are missing or denied for this sandbox scope.',
			array(
				'status'     => 403,
				'schema'     => 'wp-codebox/connector-credential-failure/v1',
				'connectors' => $failures,
			)
		);
	}

	/** @param array<int,mixed> $settings Inheritance setting rows. @return array<int,array<string,mixed>> */
	private function sanitize_inheritance_settings( array $settings ): array {
		$sanitized = array();
		foreach ( $settings as $setting ) {
			if ( ! is_array( $setting ) ) {
				continue;
			}

			$name = trim( (string) ( $setting['name'] ?? '' ) );
			if ( '' === $name ) {
				continue;
			}

			$entry = array(
				'name'   => $name,
				'status' => trim( (string) ( $setting['status'] ?? 'resolved' ) ),
			);

			$scope = trim( (string) ( $setting['scope'] ?? '' ) );
			if ( '' !== $scope ) {
				$entry['scope'] = $scope;
			}

			$sanitized[] = $entry;
		}

		return $sanitized;
	}

	/** @param array<string,mixed> $input Ability input. */
	private function inheritance_provider( array $input, ?array $inheritance = null ): string {
		foreach ( ( $inheritance ?? $this->inheritance_resolution( $input ) )['connectors'] as $connector ) {
			$provider = trim( (string) ( $connector['provider'] ?? '' ) );
			if ( '' !== $provider ) {
				return $provider;
			}
		}

		return '';
	}

	/** @param array<string,mixed> $input Ability input. */
	private function inheritance_model( array $input, ?array $inheritance = null ): string {
		foreach ( ( $inheritance ?? $this->inheritance_resolution( $input ) )['connectors'] as $connector ) {
			$model = trim( (string) ( $connector['model'] ?? '' ) );
			if ( '' !== $model ) {
				return $model;
			}
		}

		return '';
	}

	/** @param array<string,mixed> $input Ability input. @return string[] */
	private function inheritance_secret_env_names( array $input, ?array $inheritance = null ): array {
		$names = array();
		foreach ( ( $inheritance ?? $this->inheritance_resolution( $input ) )['connectors'] as $connector ) {
			if ( is_array( $connector['secretEnv'] ?? null ) ) {
				$names = array_merge( $names, $connector['secretEnv'] );
			}

			$credentials = is_array( $connector['credentials'] ?? null ) ? $connector['credentials'] : array();
			foreach ( is_array( $credentials['secrets'] ?? null ) ? $credentials['secrets'] : array() as $secret ) {
				if ( is_array( $secret ) && 'available' === ( $secret['status'] ?? '' ) ) {
					$names[] = (string) ( $secret['name'] ?? '' );
				}
			}
		}

		return $names;
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
		return WP_Codebox_Agent_Task::normalize_input( $input, fn( array $tools ): WP_Error|null => $this->validate_allowed_tools( $tools ) );
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
		return WP_Codebox_Agent_Task::prompt( $task_input );
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

	/** @param string[] $tools */
	public function validate_allowed_tools( array $tools ): WP_Error|null {
		$allowed = $this->sandbox_tool_allowlist();
		$denied  = array();

		foreach ( $tools as $tool ) {
			if ( ! str_starts_with( $tool, 'datamachine/' ) ) {
				continue;
			}

			$reason = in_array( $tool, self::parent_only_sandbox_tools(), true ) ? 'parent-only' : 'not-allowlisted';
			if ( 'parent-only' === $reason || ! in_array( $tool, $allowed, true ) ) {
				$denied[] = array(
					'tool'   => $tool,
					'reason' => $reason,
				);
			}
		}

		if ( empty( $denied ) ) {
			return null;
		}

		return new WP_Error(
			'wp_codebox_tool_not_allowed',
			'One or more requested Data Machine tools are not allowed in the sandbox scope.',
			array(
				'status'        => 403,
				'schema'        => self::TOOL_DENIAL_SCHEMA,
				'denied_tools'  => $denied,
				'allowed_tools' => $allowed,
			)
		);
	}

	/** @param array<string,mixed> $task_input Normalized task input. */
	private function strict_remediation_outcome( array $task_input ): bool {
		$target = is_array( $task_input['target'] ?? null ) ? $task_input['target'] : array();
		$policy = is_array( $task_input['policy'] ?? null ) ? $task_input['policy'] : array();
		$expected_artifacts = is_array( $task_input['expected_artifacts'] ?? null ) ? $task_input['expected_artifacts'] : array();

		foreach ( array( $target['kind'] ?? '', $policy['kind'] ?? '', $policy['outcome_contract'] ?? '', $policy['outcomeContract'] ?? '' ) as $value ) {
			$value = strtolower( str_replace( '_', '-', trim( (string) $value ) ) );
			if ( in_array( $value, array( 'audit-remediation', 'agent-sandbox-remediation', 'remediation-outcome' ), true ) ) {
				return true;
			}
		}

		foreach ( $expected_artifacts as $artifact ) {
			$artifact = strtolower( str_replace( '_', '-', trim( (string) $artifact ) ) );
			if ( in_array( $artifact, array( 'fix-artifact', 'false-positive-artifact', 'remediation-artifact', 'fix-pr', 'false-positive-pr', 'remediation-pr' ), true ) ) {
				return true;
			}
		}

		return false;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	private function remediation_outcome( array $run, int $exit_code, string $output ): array {
		$datamachine = $this->first_datamachine_metadata( $run );
		$max_turns_reached = $this->recursive_truthy_key( $run, 'max_turns_reached' ) || true === ( $datamachine['max_turns_reached'] ?? false );
		$provider_error = $this->provider_error_details( $run, $output );
		$pr_url = $this->first_url_for_keys( $run, array( 'pr_url', 'pull_request_url', 'pullRequestUrl' ) );
		$false_positive_pr_url = $this->first_url_for_keys( $run, array( 'false_positive_pr_url', 'falsePositivePrUrl' ) );
		$artifact = $this->remediation_artifact_details( $run );
		$has_artifact_changes = ! empty( $artifact['changed_files'] );
		$false_positive = $this->remediation_false_positive( $run );

		$outcome = array(
			'schema'      => self::REMEDIATION_OUTCOME_SCHEMA,
			'success'     => true,
			'kind'        => 'unable_to_remediate',
			'failure'     => '',
			'exit_code'   => $exit_code,
			'retryable'   => false,
			'diagnostics' => array_filter(
				array(
					'datamachine_completed' => array_key_exists( 'completed', $datamachine ) ? (bool) $datamachine['completed'] : null,
					'max_turns_reached'     => $max_turns_reached,
				),
				static fn( mixed $value ): bool => null !== $value
			),
		);

		if ( ! empty( $datamachine ) ) {
			$outcome['metadata'] = array( 'datamachine' => $datamachine );
		}

		if ( $has_artifact_changes && $false_positive ) {
			$outcome['success'] = true;
			$outcome['kind'] = 'false_positive_artifact';
			$outcome['artifact'] = $artifact;
			$outcome['false_positive'] = true;
			unset( $outcome['failure'] );
			return $outcome;
		}

		if ( $has_artifact_changes ) {
			$outcome['success'] = true;
			$outcome['kind'] = 'fix_artifact';
			$outcome['artifact'] = $artifact;
			unset( $outcome['failure'] );
			if ( '' !== $pr_url ) {
				$outcome['pr_url'] = $pr_url;
			}
			if ( '' !== $false_positive_pr_url ) {
				$outcome['false_positive_pr_url'] = $false_positive_pr_url;
			}
			return $outcome;
		}

		if ( '' !== $false_positive_pr_url ) {
			$outcome['success'] = true;
			$outcome['kind'] = 'false_positive_pr';
			$outcome['false_positive_pr_url'] = $false_positive_pr_url;
			unset( $outcome['failure'] );
			return $outcome;
		}

		if ( '' !== $pr_url ) {
			$outcome['success'] = true;
			$outcome['kind'] = 'fix_pr';
			$outcome['pr_url'] = $pr_url;
			unset( $outcome['failure'] );
			return $outcome;
		}

		if ( $max_turns_reached ) {
			$outcome['success'] = false;
			$outcome['kind'] = 'max_turns_exceeded';
			$outcome['failure'] = 'max_turns_exceeded';
			$outcome['retryable'] = true;
			return $outcome;
		}

		if ( 0 !== $exit_code || ! empty( $provider_error ) ) {
			$outcome['success'] = false;
			$outcome['kind'] = 'provider_error';
			$outcome['failure'] = 'provider_error';
			$outcome['provider_error'] = $provider_error;
			$outcome['retryable'] = (bool) ( $provider_error['retryable'] ?? true );
			return $outcome;
		}

		if ( $false_positive ) {
			$outcome['kind'] = 'noop_artifact';
			$outcome['false_positive'] = true;
		}

		return $outcome;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. */
	private function remediation_false_positive( array $run ): bool {
		foreach ( array_merge( array( $run ), $this->agent_payloads( $run ) ) as $payload ) {
			if ( $this->recursive_truthy_key( $payload, 'false_positive' ) || $this->recursive_truthy_key( $payload, 'falsePositive' ) ) {
				return true;
			}

			$encoded = function_exists( 'wp_json_encode' ) ? wp_json_encode( $payload, JSON_UNESCAPED_SLASHES ) : json_encode( $payload, JSON_UNESCAPED_SLASHES );
			$text    = strtolower( is_string( $encoded ) ? $encoded : '' );
			if ( str_contains( $text, 'false positive' ) || str_contains( $text, 'false_positive' ) ) {
				return true;
			}
		}

		return false;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	private function remediation_artifact_details( array $run ): array {
		$artifacts = is_array( $run['artifacts'] ?? null ) ? $run['artifacts'] : array();
		$directory = $this->clean_path( (string) ( $artifacts['directory'] ?? $artifacts['path'] ?? '' ) );
		$changed_files = array();

		if ( '' !== $directory ) {
			$changed_files_path = $directory . DIRECTORY_SEPARATOR . 'files' . DIRECTORY_SEPARATOR . 'changed-files.json';
			if ( is_readable( $changed_files_path ) ) {
				$decoded = json_decode( (string) file_get_contents( $changed_files_path ), true );
				foreach ( is_array( $decoded['files'] ?? null ) ? $decoded['files'] : array() as $file ) {
					if ( is_array( $file ) ) {
						$changed_files[] = array_filter(
							array(
								'path'          => (string) ( $file['path'] ?? '' ),
								'relative_path' => (string) ( $file['relativePath'] ?? $file['relative_path'] ?? '' ),
								'status'        => (string) ( $file['status'] ?? '' ),
							),
							static fn( mixed $value ): bool => '' !== $value
						);
					}
				}
			}
		}

		return array_filter(
			array(
				'id'            => (string) ( $artifacts['id'] ?? '' ),
				'directory'     => $directory,
				'changed_files' => $changed_files,
			),
			static fn( mixed $value ): bool => '' !== $value && array() !== $value
		);
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	private function first_datamachine_metadata( array $run ): array {
		$payloads = array_merge( array( $run ), $this->agent_payloads( $run ) );
		foreach ( $payloads as $payload ) {
			$metadata = is_array( $payload['metadata'] ?? null ) ? $payload['metadata'] : array();
			$datamachine = is_array( $metadata['datamachine'] ?? null ) ? $metadata['datamachine'] : array();
			if ( ! empty( $datamachine ) ) {
				return $datamachine;
			}
		}

		return array();
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<int,array<string,mixed>> */
	private function agent_payloads( array $run ): array {
		$payloads = array();
		foreach ( is_array( $run['executions'] ?? null ) ? $run['executions'] : array() as $execution ) {
			if ( ! is_array( $execution ) ) {
				continue;
			}

			foreach ( array( 'stdout', 'stderr' ) as $stream ) {
				$decoded = $this->decode_json_fragment( (string) ( $execution[ $stream ] ?? '' ) );
				if ( is_array( $decoded ) ) {
					$payloads[] = is_array( $decoded['result'] ?? null ) ? $decoded['result'] : $decoded;
				}
			}
		}

		return $payloads;
	}

	/** @return array<string,mixed>|null */
	private function decode_json_fragment( string $text ): ?array {
		$text = trim( $text );
		if ( '' === $text ) {
			return null;
		}

		$decoded = json_decode( $text, true );
		if ( is_array( $decoded ) ) {
			return $decoded;
		}

		$start = strpos( $text, '{' );
		$end   = strrpos( $text, '}' );
		if ( false === $start || false === $end || $end <= $start ) {
			return null;
		}

		$decoded = json_decode( substr( $text, $start, $end - $start + 1 ), true );

		return is_array( $decoded ) ? $decoded : null;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @param string[] $keys */
	private function first_url_for_keys( array $run, array $keys ): string {
		foreach ( array_merge( array( $run ), $this->agent_payloads( $run ) ) as $payload ) {
			$url = $this->recursive_first_string_key( $payload, $keys );
			if ( '' !== $url && preg_match( '#^https://github\.com/[^/\s]+/[^/\s]+/pull/\d+#', $url ) ) {
				return $url;
			}
		}

		return '';
	}

	/** @param array<string,mixed> $payload @param string[] $keys */
	private function recursive_first_string_key( array $payload, array $keys ): string {
		foreach ( $payload as $key => $value ) {
			if ( in_array( (string) $key, $keys, true ) && ! is_array( $value ) && '' !== trim( (string) $value ) ) {
				return trim( (string) $value );
			}

			if ( is_array( $value ) ) {
				$nested = $this->recursive_first_string_key( $value, $keys );
				if ( '' !== $nested ) {
					return $nested;
				}
			}
		}

		return '';
	}

	/** @param array<string,mixed> $payload */
	private function recursive_truthy_key( array $payload, string $needle ): bool {
		foreach ( $payload as $key => $value ) {
			if ( $needle === (string) $key && true === (bool) $value ) {
				return true;
			}

			if ( is_array( $value ) && $this->recursive_truthy_key( $value, $needle ) ) {
				return true;
			}
		}

		return false;
	}

	/** @param array<string,mixed> $run Decoded CLI run output. @return array<string,mixed> */
	private function provider_error_details( array $run, string $output ): array {
		$payloads = array_merge( array( $run ), $this->agent_payloads( $run ) );
		$json     = function_exists( 'wp_json_encode' ) ? wp_json_encode( $payloads, JSON_UNESCAPED_SLASHES ) : json_encode( $payloads, JSON_UNESCAPED_SLASHES );
		$encoded  = strtolower( is_string( $json ) ? $json : '' );
		$output_l = strtolower( $output );
		$haystack = $encoded . "\n" . $output_l;

		if ( ! preg_match( '/provider|timeout|timed out|429|rate limit|too many requests|openai|anthropic/', $haystack ) ) {
			return array();
		}

		$message = $this->recursive_first_string_key( $run, array( 'message', 'error', 'error_message', 'errorMessage', 'details' ) );
		if ( '' === $message ) {
			$message = $this->bound_output( $output );
		}

		return array_filter(
			array(
				'message'   => $this->bound_output( $message ),
				'retryable' => (bool) preg_match( '/timeout|timed out|429|rate limit|too many requests/', $haystack ),
			),
			static fn( mixed $value ): bool => null !== $value && '' !== $value
		);
	}

	/** @return string[] */
	private function sandbox_tool_allowlist(): array {
		$tools = $this->config_option( 'wp_codebox_allowed_sandbox_tools', self::default_sandbox_tools() );
		if ( function_exists( 'apply_filters' ) ) {
			$tools = apply_filters( 'wp_codebox_allowed_sandbox_tools', $tools );
		}

		if ( ! is_array( $tools ) ) {
			$tools = array();
		}

		return array_values(
			array_unique(
				array_filter(
					array_map(
						static fn( $tool ): string => trim( (string) $tool ),
						$tools
					),
					static fn( string $tool ): bool => str_starts_with( $tool, 'datamachine/' ) && ! in_array( $tool, self::parent_only_sandbox_tools(), true )
				)
			)
		);
	}

	/** @return array<string,mixed> */
	private static function sandbox_tool_policy(): array {
		static $policy = null;

		if ( null !== $policy ) {
			return $policy;
		}

		$loaded = is_readable( self::SANDBOX_TOOL_POLICY_FILE ) ? require self::SANDBOX_TOOL_POLICY_FILE : array();
		$policy = is_array( $loaded ) ? $loaded : array();

		return $policy;
	}

	/** @return string[] */
	private static function default_sandbox_tools(): array {
		$policy = self::sandbox_tool_policy();

		return is_array( $policy['safe_tools'] ?? null ) ? array_values( $policy['safe_tools'] ) : array();
	}

	/** @return string[] */
	private static function parent_only_sandbox_tools(): array {
		$policy = self::sandbox_tool_policy();

		return is_array( $policy['parent_only_tools'] ?? null ) ? array_values( $policy['parent_only_tools'] ) : array();
	}

	private function default_artifacts_path(): string {
		$configured = $this->clean_path( (string) $this->config_option( 'wp_codebox_artifacts_root', '' ) );
		if ( '' !== $configured ) {
			return $configured . DIRECTORY_SEPARATOR . $this->generate_run_id();
		}

		$base = function_exists( 'wp_upload_dir' ) ? wp_upload_dir() : array( 'basedir' => sys_get_temp_dir() );
		$root = is_array( $base ) && ! empty( $base['basedir'] ) ? (string) $base['basedir'] : sys_get_temp_dir();

		return rtrim( $root, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . 'wp-codebox' . DIRECTORY_SEPARATOR . $this->generate_run_id();
	}

	private function default_bin(): string {
		$bundled = defined( 'WP_CODEBOX_PLUGIN_PATH' ) ? WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin/wp-codebox' : '';
		$default = is_string( $bundled ) && is_file( $bundled ) ? $bundled : 'wp-codebox';
		$bin     = (string) $this->config_option( 'wp_codebox_bin', $default );

		if ( function_exists( 'apply_filters' ) ) {
			$bin = (string) apply_filters( 'wp_codebox_bin', $bin );
		}

		return $bin;
	}

	private function clean_path( string $path ): string {
		return rtrim( trim( $path ), DIRECTORY_SEPARATOR );
	}

	private function preview_hold_seconds( array $input ): int {
		return WP_Codebox_Preview_Options::preview_hold_seconds( $input );
	}

	private function preview_args( array $input ): string|WP_Error {
		$options = WP_Codebox_Preview_Options::normalize( $input );
		if ( is_wp_error( $options ) ) {
			return $options;
		}

		$args = $options['preview_hold_seconds'] > 0 ? ' --preview-hold ' . escapeshellarg( (string) $options['preview_hold_seconds'] ) : '';
		$port = $options['preview_port'];
		$bind = $options['preview_bind'];
		$public = $options['preview_public_url'];

		if ( null !== $port ) {
			$args .= ' --preview-port ' . escapeshellarg( (string) $port );
		}
		if ( null !== $bind ) {
			$args .= ' --preview-bind ' . escapeshellarg( $bind );
		}
		if ( null !== $public ) {
			$args .= ' --preview-public-url ' . escapeshellarg( $public );
		}

		return $args;
	}

	private function preview_hold_arg( array $input ): string {
		$seconds = $this->preview_hold_seconds( $input );

		return $seconds > 0 ? ' --preview-hold ' . escapeshellarg( (string) $seconds ) : '';
	}

	private function config_option( string $name, mixed $default ): mixed {
		if ( function_exists( 'is_multisite' ) && is_multisite() && function_exists( 'get_site_option' ) ) {
			return get_site_option( $name, $default );
		}

		if ( function_exists( 'get_option' ) ) {
			return get_option( $name, $default );
		}

		return $default;
	}

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
	private function recipe_mounts( array $input ): array|WP_Error {
		$mounts = is_array( $input['mounts'] ?? null ) ? $input['mounts'] : array();
		$normalized = array();

		foreach ( $mounts as $index => $mount ) {
			if ( ! is_array( $mount ) ) {
				return new WP_Error( 'wp_codebox_mount_invalid', 'Each WP Codebox mount must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			$source = $this->clean_path( (string) ( $mount['source'] ?? '' ) );
			$target = trim( (string) ( $mount['target'] ?? '' ) );
			if ( '' === $source || ! is_dir( $source ) ) {
				return new WP_Error( 'wp_codebox_mount_source_invalid', 'WP Codebox mount source must be an existing directory.', array( 'status' => 400, 'index' => $index ) );
			}

			if ( '' === $target || ! str_starts_with( $target, '/' ) ) {
				return new WP_Error( 'wp_codebox_mount_target_invalid', 'WP Codebox mount target must be an absolute sandbox path.', array( 'status' => 400, 'index' => $index ) );
			}

			$mode = (string) ( $mount['mode'] ?? 'readwrite' );
			if ( 'readonly' !== $mode && 'readwrite' !== $mode ) {
				return new WP_Error( 'wp_codebox_mount_mode_invalid', 'WP Codebox mount mode must be readonly or readwrite.', array( 'status' => 400, 'index' => $index ) );
			}

			$entry = array(
				'source' => $source,
				'target' => $target,
				'mode'   => $mode,
			);

			if ( isset( $mount['metadata'] ) && ! is_array( $mount['metadata'] ) ) {
				return new WP_Error( 'wp_codebox_mount_metadata_invalid', 'WP Codebox mount metadata must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			if ( isset( $mount['metadata'] ) ) {
				$entry['metadata'] = $mount['metadata'];
			}

			$normalized[] = $entry;
		}

		return $normalized;
	}

	private function command_prefix( string $bin ): string|WP_Error {
		if ( str_ends_with( $bin, '.js' ) && is_file( $bin ) ) {
			$node = $this->node_binary();
			if ( is_wp_error( $node ) ) {
				return $node;
			}

			return escapeshellarg( $node ) . ' ' . escapeshellarg( $bin );
		}

		if ( $this->is_bundled_cli_wrapper( $bin ) ) {
			$node = $this->node_binary();
			if ( is_wp_error( $node ) ) {
				return $node;
			}
		}

		return escapeshellarg( $bin );
	}

	private function node_binary(): string|WP_Error {
		$configured = trim( (string) ( getenv( 'WP_CODEBOX_NODE_BIN' ) ?: '' ) );
		if ( '' !== $configured ) {
			if ( is_file( $configured ) && is_executable( $configured ) ) {
				return $configured;
			}

			return new WP_Error( 'wp_codebox_node_runtime_unavailable', 'WP_CODEBOX_NODE_BIN is configured but is not an executable file.', array( 'status' => 500, 'path' => $configured ) );
		}

		$bundled = $this->bundled_node_binary();
		if ( '' !== $bundled ) {
			return $bundled;
		}

		foreach ( array( 'node', 'nodejs' ) as $command ) {
			$resolved = $this->resolve_command( $command );
			if ( '' !== $resolved ) {
				return $resolved;
			}
		}

		return new WP_Error(
			'wp_codebox_node_runtime_unavailable',
			'WP Codebox could not find an executable Node.js runtime. Use the packaged plugin with vendor/wp-codebox-cli/vendor/node/bin/node, set WP_CODEBOX_NODE_BIN, or install node on PATH.',
			array( 'status' => 500 )
		);
	}

	private function bundled_node_binary(): string {
		if ( ! defined( 'WP_CODEBOX_PLUGIN_PATH' ) ) {
			return '';
		}

		$path = WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/vendor/node/bin/node';
		return is_file( $path ) && is_executable( $path ) ? $path : '';
	}

	private function is_bundled_cli_wrapper( string $bin ): bool {
		if ( ! defined( 'WP_CODEBOX_PLUGIN_PATH' ) ) {
			return false;
		}

		return $bin === WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin/wp-codebox';
	}

	private function resolve_command( string $command ): string {
		if ( isset( $this->callbacks['command_resolver'] ) ) {
			$resolved = ( $this->callbacks['command_resolver'] )( $command );
			return is_string( $resolved ) ? $resolved : '';
		}

		if ( ! function_exists( 'exec' ) ) {
			return '';
		}

		$output = array();
		$exit   = 1;
		// phpcs:ignore WordPress.PHP.DiscouragedPHPFunctions.system_calls_exec -- Used for executable preflight only.
		exec( 'command -v ' . escapeshellarg( $command ) . ' 2>/dev/null', $output, $exit );
		$resolved = 0 === $exit && ! empty( $output[0] ) ? (string) $output[0] : '';

		return '' !== $resolved && is_executable( $resolved ) ? $resolved : '';
	}

	/**
	 * @param array{agents_api:string,data_machine:string,data_machine_code:string} $paths Component paths.
	 * @param array<string,mixed> $input Ability input.
	 * @param string[] $task_prompts Encoded task prompts.
	 */
	private function write_agent_recipe( array $paths, array $input, array $task_prompts, string $wp_version, ?array $inheritance = null ): array|WP_Error {
		$inheritance = $inheritance ?? $this->inheritance_resolution( $input );
		$credential_error = $this->connector_credentials_error( $inheritance );
		if ( null !== $credential_error ) {
			return $credential_error;
		}

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
				'provider=' . $this->provider( $input, $inheritance ),
				'model=' . $this->model( $input, $inheritance ),
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

		$mounts = $this->recipe_mounts( $input );
		if ( is_wp_error( $mounts ) ) {
			return $mounts;
		}

		$site_seed_payload = $this->parent_site_seed_recipe_entries( $input );
		if ( is_wp_error( $site_seed_payload ) ) {
			return $site_seed_payload;
		}

		$recipe_inputs = array(
			'mounts'       => $mounts,
			'inherit'      => $this->inheritance_request( $input ),
			'inheritance'  => $inheritance,
			'extraPlugins' => array_merge( $this->component_plugins( $paths ), $provider_plugins ),
			'secretEnv'    => $this->secret_env_names( $input, $inheritance ),
		);
		if ( ! empty( $site_seed_payload['siteSeeds'] ) ) {
			$recipe_inputs['siteSeeds'] = $site_seed_payload['siteSeeds'];
		}

		$recipe = array(
			'schema'   => 'wp-codebox/workspace-recipe/v1',
			'runtime'  => array(
				'wp'        => $wp_version,
				'blueprint' => array( 'steps' => array() ),
			),
			'inputs'   => $recipe_inputs,
			'workflow' => array( 'steps' => $steps ),
		);

		$file = tempnam( sys_get_temp_dir(), 'wp-codebox-recipe-' );
		if ( false === $file ) {
			return new WP_Error( 'wp_codebox_recipe_temp_failed', 'Could not create a temporary WP Codebox recipe.', array( 'status' => 500 ) );
		}

		$encoded = function_exists( 'wp_json_encode' ) ? wp_json_encode( $recipe, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) : json_encode( $recipe, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
		if ( ! is_string( $encoded ) || false === file_put_contents( $file, $encoded ) ) {
			@unlink( $file );
			foreach ( $site_seed_payload['cleanup_paths'] as $cleanup_path ) {
				@unlink( (string) $cleanup_path );
			}
			return new WP_Error( 'wp_codebox_recipe_write_failed', 'Could not write the temporary WP Codebox recipe.', array( 'status' => 500 ) );
		}

		return array(
			'path'          => $file,
			'cleanup_paths' => $site_seed_payload['cleanup_paths'],
		);
	}

	/**
	 * @param array<string,mixed> $input Ability input.
	 * @return array{siteSeeds:array<int,array<string,mixed>>,cleanup_paths:array<int,string>}|WP_Error
	 */
	private function parent_site_seed_recipe_entries( array $input ): array|WP_Error {
		$declarations = is_array( $input['site_seeds'] ?? null ) ? $input['site_seeds'] : array();
		if ( empty( $declarations ) ) {
			return array( 'siteSeeds' => array(), 'cleanup_paths' => array() );
		}

		$site_seeds    = array();
		$cleanup_paths = array();
		foreach ( $declarations as $index => $declaration ) {
			if ( ! is_array( $declaration ) ) {
				return new WP_Error( 'wp_codebox_site_seed_invalid', 'Each site_seeds entry must be an object.', array( 'status' => 400, 'index' => $index ) );
			}
			if ( 'parent_site' !== (string) ( $declaration['type'] ?? '' ) ) {
				return new WP_Error( 'wp_codebox_site_seed_type_invalid', 'Only parent_site site_seeds are accepted by the WordPress host exporter.', array( 'status' => 400, 'index' => $index ) );
			}
			$name = (string) ( $declaration['name'] ?? 'parent-site' );
			if ( ! preg_match( '/^[A-Za-z0-9][A-Za-z0-9_.-]*$/', $name ) ) {
				return new WP_Error( 'wp_codebox_site_seed_name_invalid', 'site_seeds entries require a stable name.', array( 'status' => 400, 'index' => $index ) );
			}
			$scopes = is_array( $declaration['scopes'] ?? null ) ? $declaration['scopes'] : array();
			$validation = $this->validate_parent_site_seed_scopes( $scopes );
			if ( is_wp_error( $validation ) ) {
				return $validation;
			}

			$seed = $this->export_parent_site_seed( $name, $scopes );
			if ( is_wp_error( $seed ) ) {
				return $seed;
			}

			$file = tempnam( sys_get_temp_dir(), 'wp-codebox-site-seed-' );
			if ( false === $file ) {
				return new WP_Error( 'wp_codebox_site_seed_temp_failed', 'Could not create a temporary WP Codebox site seed fixture.', array( 'status' => 500 ) );
			}

			$encoded = function_exists( 'wp_json_encode' ) ? wp_json_encode( $seed, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) : json_encode( $seed, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );
			if ( ! is_string( $encoded ) || false === file_put_contents( $file, $encoded ) ) {
				@unlink( $file );
				return new WP_Error( 'wp_codebox_site_seed_write_failed', 'Could not write a temporary WP Codebox site seed fixture.', array( 'status' => 500 ) );
			}

			$cleanup_paths[] = $file;
			$site_seeds[] = array(
				'type'   => 'fixture',
				'name'   => $name,
				'source' => $file,
				'format' => 'json',
				'scopes' => $scopes,
			);
		}

		return array( 'siteSeeds' => $site_seeds, 'cleanup_paths' => $cleanup_paths );
	}

	/** @param array<string,mixed> $scopes Parent-site seed scopes. */
	private function validate_parent_site_seed_scopes( array $scopes ): true|WP_Error {
		if ( empty( $scopes ) ) {
			return new WP_Error( 'wp_codebox_site_seed_scopes_missing', 'parent_site site_seeds require explicit scopes.', array( 'status' => 400 ) );
		}

		foreach ( array( 'posts', 'terms', 'options', 'users', 'media' ) as $scope_name ) {
			$scope = $scopes[ $scope_name ] ?? null;
			if ( null === $scope ) {
				continue;
			}
			if ( ! is_array( $scope ) ) {
				return new WP_Error( 'wp_codebox_site_seed_scope_invalid', 'Record site seed scopes must be objects.', array( 'status' => 400, 'scope' => $scope_name ) );
			}
			$max = isset( $scope['maxRecords'] ) ? (int) $scope['maxRecords'] : 0;
			if ( $max < 1 || $max > 100 ) {
				return new WP_Error( 'wp_codebox_site_seed_scope_unbounded', 'Parent-site record scopes require maxRecords between 1 and 100.', array( 'status' => 400, 'scope' => $scope_name ) );
			}
		}

		if ( isset( $scopes['options'] ) && empty( $scopes['options']['names'] ) ) {
			return new WP_Error( 'wp_codebox_site_seed_options_unbounded', 'Parent-site option seeds require an explicit names allow-list.', array( 'status' => 400 ) );
		}
		if ( isset( $scopes['users'] ) && false === ( $scopes['users']['anonymize'] ?? true ) ) {
			return new WP_Error( 'wp_codebox_site_seed_users_unsafe', 'Parent-site user seeds must be anonymized.', array( 'status' => 400 ) );
		}
		if ( isset( $scopes['media'] ) && true === ( $scopes['media']['includeFiles'] ?? false ) ) {
			return new WP_Error( 'wp_codebox_site_seed_media_files_unsupported', 'Parent-site media seed export includes metadata only; file export is not supported.', array( 'status' => 400 ) );
		}

		return true;
	}

	/** @param array<string,mixed> $scopes Parent-site seed scopes. @return array<string,mixed>|WP_Error */
	private function export_parent_site_seed( string $name, array $scopes ): array|WP_Error {
		$seed = array(
			'schema'     => 'wp-codebox/site-seed-fixture/v1',
			'name'       => $name,
			'provenance' => array(
				'source'      => 'parent_site',
				'source_url'  => function_exists( 'home_url' ) ? home_url( '/' ) : '',
				'exported_at' => gmdate( 'c' ),
				'limitations' => array(
					'media file bytes are not exported',
					'user credentials and raw user emails are not exported',
					'full database state, revisions, comments, post meta, term meta, and arbitrary options are not replayed',
				),
			),
		);

		if ( isset( $scopes['posts'] ) ) {
			$seed['posts'] = $this->export_parent_site_posts( $scopes['posts'] );
		}
		if ( isset( $scopes['terms'] ) ) {
			$seed['terms'] = $this->export_parent_site_terms( $scopes['terms'] );
		}
		if ( isset( $scopes['options'] ) ) {
			$seed['options'] = $this->export_parent_site_options( $scopes['options'] );
		}
		if ( isset( $scopes['users'] ) ) {
			$seed['users'] = $this->export_parent_site_users( $scopes['users'] );
		}
		if ( isset( $scopes['media'] ) ) {
			$seed['media'] = $this->export_parent_site_media( $scopes['media'] );
		}
		if ( true === ( $scopes['activePlugins'] ?? false ) ) {
			$seed['activePlugins'] = array_slice( array_values( (array) get_option( 'active_plugins', array() ) ), 0, 100 );
		}
		if ( true === ( $scopes['activeTheme'] ?? false ) && function_exists( 'get_stylesheet' ) ) {
			$seed['activeTheme'] = get_stylesheet();
		}

		return $seed;
	}

	/** @param array<string,mixed> $scope Parent-site posts scope. @return array<int,array<string,mixed>> */
	private function export_parent_site_posts( array $scope ): array {
		$query = array(
			'post_type'      => ! empty( $scope['postTypes'] ) && is_array( $scope['postTypes'] ) ? array_map( 'sanitize_key', $scope['postTypes'] ) : array( 'post', 'page' ),
			'post_status'    => ! empty( $scope['statuses'] ) && is_array( $scope['statuses'] ) ? array_map( 'sanitize_key', $scope['statuses'] ) : array( 'publish' ),
			'posts_per_page' => min( 100, max( 1, (int) $scope['maxRecords'] ) ),
			'orderby'        => 'ID',
			'order'          => 'ASC',
			'no_found_rows'  => true,
		);
		if ( ! empty( $scope['ids'] ) && is_array( $scope['ids'] ) ) {
			$query['post__in'] = array_map( 'absint', $scope['ids'] );
			$query['orderby']  = 'post__in';
		}
		if ( ! empty( $scope['slugs'] ) && is_array( $scope['slugs'] ) ) {
			$query['post_name__in'] = array_map( 'sanitize_title', $scope['slugs'] );
		}

		$posts = function_exists( 'get_posts' ) ? get_posts( $query ) : array();
		return array_map(
			static fn( WP_Post $post ): array => array(
				'id'           => (int) $post->ID,
				'post_type'    => $post->post_type,
				'post_status'  => $post->post_status,
				'post_name'    => $post->post_name,
				'post_title'   => $post->post_title,
				'post_content' => $post->post_content,
				'post_excerpt' => $post->post_excerpt,
			),
			$posts
		);
	}

	/** @param array<string,mixed> $scope Parent-site terms scope. @return array<int,array<string,mixed>> */
	private function export_parent_site_terms( array $scope ): array {
		$args = array(
			'taxonomy'   => ! empty( $scope['taxonomies'] ) && is_array( $scope['taxonomies'] ) ? array_map( 'sanitize_key', $scope['taxonomies'] ) : array( 'category', 'post_tag' ),
			'number'     => min( 100, max( 1, (int) $scope['maxRecords'] ) ),
			'hide_empty' => false,
			'orderby'    => 'term_id',
			'order'      => 'ASC',
		);
		if ( ! empty( $scope['ids'] ) && is_array( $scope['ids'] ) ) {
			$args['include'] = array_map( 'absint', $scope['ids'] );
		}
		if ( ! empty( $scope['slugs'] ) && is_array( $scope['slugs'] ) ) {
			$args['slug'] = array_map( 'sanitize_title', $scope['slugs'] );
		}
		if ( ! empty( $scope['names'] ) && is_array( $scope['names'] ) ) {
			$args['name'] = array_values( array_map( 'sanitize_text_field', $scope['names'] ) );
		}

		$terms = function_exists( 'get_terms' ) ? get_terms( $args ) : array();
		if ( is_wp_error( $terms ) || ! is_array( $terms ) ) {
			return array();
		}

		return array_map(
			static fn( WP_Term $term ): array => array(
				'id'          => (int) $term->term_id,
				'taxonomy'    => $term->taxonomy,
				'slug'        => $term->slug,
				'name'        => $term->name,
				'description' => $term->description,
			),
			array_slice( $terms, 0, min( 100, max( 1, (int) $scope['maxRecords'] ) ) )
		);
	}

	/** @param array<string,mixed> $scope Parent-site options scope. @return array<string,mixed> */
	private function export_parent_site_options( array $scope ): array {
		$options = array();
		$names   = ! empty( $scope['names'] ) && is_array( $scope['names'] ) ? array_slice( $scope['names'], 0, min( 100, max( 1, (int) $scope['maxRecords'] ) ) ) : array();
		foreach ( $names as $name ) {
			$name = sanitize_key( (string) $name );
			if ( '' === $name ) {
				continue;
			}
			$options[ $name ] = get_option( $name );
		}

		return $options;
	}

	/** @param array<string,mixed> $scope Parent-site users scope. @return array<int,array<string,mixed>> */
	private function export_parent_site_users( array $scope ): array {
		$args = array(
			'number'  => min( 100, max( 1, (int) $scope['maxRecords'] ) ),
			'orderby' => 'ID',
			'order'   => 'ASC',
			'fields'  => array( 'ID', 'display_name', 'roles' ),
		);
		if ( ! empty( $scope['ids'] ) && is_array( $scope['ids'] ) ) {
			$args['include'] = array_map( 'absint', $scope['ids'] );
		}
		if ( ! empty( $scope['roles'] ) && is_array( $scope['roles'] ) ) {
			$args['role__in'] = array_map( 'sanitize_key', $scope['roles'] );
		}

		$users = function_exists( 'get_users' ) ? get_users( $args ) : array();
		return array_map(
			static fn( WP_User $user ): array => array(
				'id'           => (int) $user->ID,
				'user_login'   => 'seed-user-' . (int) $user->ID,
				'user_email'   => 'seed-user-' . (int) $user->ID . '@example.invalid',
				'display_name' => 'Seed user ' . (int) $user->ID,
				'roles'        => array_values( array_map( 'sanitize_key', (array) $user->roles ) ),
			),
			$users
		);
	}

	/** @param array<string,mixed> $scope Parent-site media scope. @return array<int,array<string,mixed>> */
	private function export_parent_site_media( array $scope ): array {
		$query = array(
			'post_type'      => 'attachment',
			'post_status'    => ! empty( $scope['statuses'] ) && is_array( $scope['statuses'] ) ? array_map( 'sanitize_key', $scope['statuses'] ) : array( 'inherit' ),
			'posts_per_page' => min( 100, max( 1, (int) $scope['maxRecords'] ) ),
			'orderby'        => 'ID',
			'order'          => 'ASC',
			'no_found_rows'  => true,
		);
		if ( ! empty( $scope['ids'] ) && is_array( $scope['ids'] ) ) {
			$query['post__in'] = array_map( 'absint', $scope['ids'] );
			$query['orderby']  = 'post__in';
		}
		if ( ! empty( $scope['slugs'] ) && is_array( $scope['slugs'] ) ) {
			$query['post_name__in'] = array_map( 'sanitize_title', $scope['slugs'] );
		}

		$attachments = function_exists( 'get_posts' ) ? get_posts( $query ) : array();
		return array_map(
			static fn( WP_Post $post ): array => array(
				'id'             => (int) $post->ID,
				'post_name'      => $post->post_name,
				'post_title'     => $post->post_title,
				'post_excerpt'   => $post->post_excerpt,
				'post_mime_type' => $post->post_mime_type,
				'post_status'    => $post->post_status,
			),
			$attachments
		);
	}

	/**
	 * @param array{agents_api:string,data_machine:string,data_machine_code:string} $paths Component paths.
	 * @return array<int,array{source:string,slug:string,activate:bool}>
	 */
	private function component_plugins( array $paths ): array {
		$plugins = array();
		foreach (
			array(
				'agents_api'        => 'agents-api',
				'data_machine'      => 'data-machine',
				'data_machine_code' => 'data-machine-code',
			) as $key => $slug
		) {
			if ( '' === $paths[ $key ] ) {
				continue;
			}

			$plugins[] = array(
				'source'   => $paths[ $key ],
				'slug'     => $slug,
				'activate' => false,
				'loadAs'   => 'mu-plugin',
			);
		}

		return $plugins;
	}

	private function generate_run_id(): string {
		if ( function_exists( 'wp_generate_uuid4' ) ) {
			return wp_generate_uuid4();
		}

		return bin2hex( random_bytes( 16 ) );
	}

	private function sandbox_session_id( array $input ): string {
		$id = trim( (string) ( $input['sandbox_session_id'] ?? '' ) );
		if ( '' !== $id ) {
			return $id;
		}

		$id = trim( (string) ( $input['session_id'] ?? '' ) );
		return '' !== $id ? $id : $this->generate_run_id();
	}

	/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $run Decoded CLI run output. */
	private function sandbox_session( string $session_id, string $status, array $input, array $run, string $artifacts ): array {
		return WP_Codebox_Agent_Task::session(
			$session_id,
			$status,
			$input,
			array_filter(
				array(
					'path'        => $artifacts,
					'bundle_id'   => is_array( $run['artifacts'] ?? null ) ? (string) ( $run['artifacts']['id'] ?? '' ) : '',
					'preview_url' => is_array( $run['artifacts']['preview'] ?? null ) ? (string) ( $run['artifacts']['preview']['url'] ?? '' ) : '',
				),
				static fn( mixed $value ): bool => '' !== $value
			)
		);
	}

	private function error_payload( WP_Error $error ): array {
		return array_filter(
			array(
				'code'    => $error->get_error_code(),
				'message' => $error->get_error_message(),
				'data'    => $error->get_error_data(),
			),
			static fn( mixed $value ): bool => null !== $value && array() !== $value && '' !== $value
		);
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

	/** @param array<string,string> $secret_env Secret env values for the child process. @return array{exit_code:int,output:string} */
	private function run_command( string $command, array $secret_env = array() ): array {
		if ( isset( $this->callbacks['command_runner'] ) ) {
			return ( $this->callbacks['command_runner'] )( $command, $secret_env );
		}

		if ( ! empty( $secret_env ) && ! function_exists( 'proc_open' ) ) {
			return array(
				'exit_code' => 1,
				'output'    => 'WP Codebox inherited secret environment requires proc_open support.',
			);
		}

		if ( ! empty( $secret_env ) ) {
			$descriptor_spec = array(
				1 => array( 'pipe', 'w' ),
				2 => array( 'pipe', 'w' ),
			);
			$current_env = getenv();
			$process     = proc_open( $command, $descriptor_spec, $pipes, null, array_merge( is_array( $current_env ) ? $current_env : array(), $_ENV, $secret_env ) );
			if ( is_resource( $process ) ) {
				$output = stream_get_contents( $pipes[1] );
				$error  = stream_get_contents( $pipes[2] );
				fclose( $pipes[1] );
				fclose( $pipes[2] );

				return array(
					'exit_code' => proc_close( $process ),
					'output'    => trim( (string) $output . "\n" . (string) $error ),
				);
			}
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
