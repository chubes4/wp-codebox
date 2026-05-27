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
	private const SESSION_SCHEMA = 'wp-codebox/sandbox-session/v1';
	private const TASK_INPUT_SCHEMA = 'wp-codebox/task-input/v1';
	private const TOOL_DENIAL_SCHEMA = 'wp-codebox/tool-allowlist-denial/v1';
	private const DEFAULT_SANDBOX_TOOLS = array(
		'datamachine/workspace-read',
		'datamachine/workspace-ls',
		'datamachine/workspace-grep',
		'datamachine/workspace-write',
		'datamachine/workspace-edit',
		'datamachine/workspace-apply-patch',
		'datamachine/workspace-git-status',
		'datamachine/workspace-git-log',
		'datamachine/workspace-git-diff',
		'datamachine/list-github-issues',
		'datamachine/get-github-issue',
		'datamachine/list-github-pulls',
		'datamachine/get-github-pull',
		'datamachine/list-github-pull-files',
		'datamachine/get-github-check-runs',
		'datamachine/get-github-commit-statuses',
		'datamachine/list-github-tree',
		'datamachine/get-github-file',
		'datamachine/list-github-repos',
	);
	private const PARENT_ONLY_SANDBOX_TOOLS = array(
		'datamachine/workspace-clone',
		'datamachine/workspace-adopt',
		'datamachine/workspace-remove',
		'datamachine/workspace-delete',
		'datamachine/workspace-git-pull',
		'datamachine/workspace-git-add',
		'datamachine/workspace-git-commit',
		'datamachine/workspace-git-push',
		'datamachine/workspace-git-rebase',
		'datamachine/workspace-git-reset',
		'datamachine/workspace-pr-rebase',
		'datamachine/workspace-worktree-add',
		'datamachine/workspace-worktree-finalize',
		'datamachine/workspace-worktree-remove',
		'datamachine/workspace-worktree-prune',
		'datamachine/workspace-worktree-cleanup',
		'datamachine/workspace-cleanup-apply',
		'datamachine/create-github-issue',
		'datamachine/update-github-issue',
		'datamachine/create-github-pull-request',
		'datamachine/comment-github-issue',
		'datamachine/comment-github-pull-request',
		'datamachine/upsert-github-pull-review-comment',
		'datamachine/merge-github-pull-request',
		'datamachine/cleanup-github-pull-request',
		'datamachine/create-or-update-github-file',
		'datamachine/create-code-task',
		'datamachine/gitsync-bind',
		'datamachine/gitsync-unbind',
		'datamachine/gitsync-pull',
		'datamachine/gitsync-submit',
		'datamachine/gitsync-push',
		'datamachine/gitsync-policy-update',
	);

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
		$command .= $this->preview_hold_arg( $input );

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
			'session'   => $this->sandbox_session( $session_id, 'completed', $input, $decoded, $artifacts ),
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
				'artifacts'   => $task_result['session']['artifacts'] ?? array(),
				'run'         => $task_result['run'] ?? array(),
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
			'connectors' => $this->sanitize_inheritance_connectors( $resolution['connectors'] ?? array() ),
			'settings'   => $this->sanitize_inheritance_settings( $resolution['settings'] ?? array() ),
		);
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
				if ( 'allowed_tools' === $field ) {
					$tool_error = $this->allowed_tools_error( $values );
					if ( is_wp_error( $tool_error ) ) {
						return $tool_error;
					}
				}
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

	/** @param string[] $tools */
	private function allowed_tools_error( array $tools ): WP_Error|null {
		$allowed = $this->sandbox_tool_allowlist();
		$denied  = array();

		foreach ( $tools as $tool ) {
			if ( ! str_starts_with( $tool, 'datamachine/' ) ) {
				continue;
			}

			$reason = in_array( $tool, self::PARENT_ONLY_SANDBOX_TOOLS, true ) ? 'parent-only' : 'not-allowlisted';
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

	/** @return string[] */
	private function sandbox_tool_allowlist(): array {
		$tools = $this->config_option( 'wp_codebox_allowed_sandbox_tools', self::DEFAULT_SANDBOX_TOOLS );
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
					static fn( string $tool ): bool => str_starts_with( $tool, 'datamachine/' ) && ! in_array( $tool, self::PARENT_ONLY_SANDBOX_TOOLS, true )
				)
			)
		);
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
		$bin = (string) $this->config_option( 'wp_codebox_bin', 'wp-codebox' );

		if ( function_exists( 'apply_filters' ) ) {
			$bin = (string) apply_filters( 'wp_codebox_bin', $bin );
		}

		return $bin;
	}

	private function clean_path( string $path ): string {
		return rtrim( trim( $path ), DIRECTORY_SEPARATOR );
	}

	private function preview_hold_seconds( array $input ): int {
		$seconds = (int) ( $input['preview_hold_seconds'] ?? $input['preview_hold'] ?? 0 );

		return max( 0, min( 3600, $seconds ) );
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
		$inheritance = $this->inheritance_resolution( $input );
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

		$recipe = array(
			'schema'   => 'wp-codebox/workspace-recipe/v1',
			'runtime'  => array(
				'wp'        => $wp_version,
				'blueprint' => array( 'steps' => array() ),
			),
			'inputs'   => array(
				'mounts'       => $mounts,
				'inherit'      => $this->inheritance_request( $input ),
				'inheritance'  => $inheritance,
				'extraPlugins' => array_merge(
					array(
						array( 'source' => $paths['agents_api'], 'slug' => 'agents-api', 'activate' => false ),
						array( 'source' => $paths['data_machine'], 'slug' => 'data-machine', 'activate' => false ),
						array( 'source' => $paths['data_machine_code'], 'slug' => 'data-machine-code', 'activate' => false ),
					),
					$provider_plugins
				),
				'secretEnv'    => $this->secret_env_names( $input, $inheritance ),
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
		$session = array(
			'schema'      => self::SESSION_SCHEMA,
			'id'          => $session_id,
			'status'      => $status,
			'persistence' => 'external-orchestrator',
			'artifacts'   => array_filter(
				array(
					'path'       => $artifacts,
					'bundle_id'  => is_array( $run['artifacts'] ?? null ) ? (string) ( $run['artifacts']['id'] ?? '' ) : '',
					'preview_url' => is_array( $run['artifacts']['preview'] ?? null ) ? (string) ( $run['artifacts']['preview']['url'] ?? '' ) : '',
				),
				static fn( mixed $value ): bool => '' !== $value
			),
		);

		if ( ! empty( $input['session_id'] ) ) {
			$session['agent_session_id'] = (string) $input['session_id'];
		}

		if ( isset( $input['orchestrator'] ) && is_array( $input['orchestrator'] ) ) {
			$session['orchestrator'] = array_filter(
				array(
					'id'     => isset( $input['orchestrator']['id'] ) ? (string) $input['orchestrator']['id'] : '',
					'type'   => isset( $input['orchestrator']['type'] ) ? (string) $input['orchestrator']['type'] : '',
					'job_id' => isset( $input['orchestrator']['job_id'] ) ? (string) $input['orchestrator']['job_id'] : '',
				),
				static fn( mixed $value ): bool => '' !== $value
			);
		}

		return $session;
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
