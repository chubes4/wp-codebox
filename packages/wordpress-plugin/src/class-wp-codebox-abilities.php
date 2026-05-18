<?php
/**
 * WP Codebox abilities.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Abilities {

	private static bool $registered = false;

	public function __construct() {
		if ( ! class_exists( 'WP_Ability' ) ) {
			return;
		}

		if ( self::$registered ) {
			return;
		}

		$this->register();
		self::$registered = true;
	}

	private function register(): void {
		$register_callback = function (): void {
			wp_register_ability(
				'wp-codebox/run-agent-task',
				array(
					'label'               => 'Run Agent Sandbox Task',
					'description'         => 'Run a bounded task inside an isolated WP Codebox WordPress agent sandbox and return artifacts.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'task' ),
						'properties' => array(
							'task'                   => array(
								'type'        => 'string',
								'description' => 'Task description to run inside the isolated sandbox.',
							),
							'agent'                  => array(
								'type'        => 'string',
								'description' => 'Sandbox agent slug to invoke through agents/chat. Defaults through wp_codebox_default_agent.',
							),
							'mode'                   => array(
								'type'        => 'string',
								'description' => 'Agent execution mode. Defaults to sandbox.',
							),
							'provider'               => array(
								'type'        => 'string',
								'description' => 'AI provider id to seed into the sandbox agent config.',
							),
							'model'                  => array(
								'type'        => 'string',
								'description' => 'AI model id to seed into the sandbox agent config.',
							),
							'provider_plugin_paths'  => array(
								'type'        => 'array',
								'description' => 'AI provider plugin directories to mount and activate inside the sandbox.',
								'items'       => array( 'type' => 'string' ),
							),
							'secret_env'             => array(
								'type'        => 'array',
								'description' => 'Parent environment variable names to expose inside the sandbox. Values are read from the parent process, not from this payload.',
								'items'       => array( 'type' => 'string' ),
							),
							'session_id'             => array(
								'type'        => 'string',
								'description' => 'Existing sandbox conversation session id.',
							),
							'max_turns'              => array(
								'type'        => 'integer',
								'description' => 'Maximum agent loop turns for this sandbox task.',
							),
							'code'                   => array(
								'type'        => 'string',
								'description' => 'Optional PHP code body to execute after the sandbox agent stack boots.',
							),
							'code_file'              => array(
								'type'        => 'string',
								'description' => 'Optional PHP file to execute after the sandbox agent stack boots.',
							),
							'wp'                     => array(
								'type'        => 'string',
								'description' => 'WordPress version passed to Playground. Defaults to trunk.',
							),
							'artifacts_path'         => array(
								'type'        => 'string',
								'description' => 'Directory where WP Codebox should write artifact bundles.',
							),
							'wp_codebox_bin'    => array(
								'type'        => 'string',
								'description' => 'WP Codebox CLI binary or path. JS dist files are run through node.',
							),
							'agents_api_path'        => array( 'type' => 'string' ),
							'data_machine_path'      => array( 'type' => 'string' ),
							'data_machine_code_path' => array( 'type' => 'string' ),
						),
					),
					'output_schema'       => array(
						'type'       => 'object',
						'properties' => array(
							'success'   => array( 'type' => 'boolean' ),
							'schema'    => array( 'type' => 'string' ),
							'task'      => array( 'type' => 'string' ),
							'wp'        => array( 'type' => 'string' ),
							'paths'     => array( 'type' => 'object' ),
							'artifacts' => array( 'type' => 'string' ),
							'exit_code' => array( 'type' => 'integer' ),
							'run'       => array( 'type' => 'object' ),
						),
					),
					'execute_callback'    => array( self::class, 'run_agent_task' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/run-agent-task-batch',
				array(
					'label'               => 'Run Agent Sandbox Task Batch',
					'description'         => 'Run multiple tasks in isolated WP Codebox WordPress agent sandboxes and return artifacts for each run.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'tasks' ),
						'properties' => array(
							'tasks'                  => array(
								'type'        => 'array',
								'description' => 'Task descriptions. Each task runs in its own isolated sandbox.',
								'items'       => array( 'type' => 'string' ),
							),
							'concurrency'            => array(
								'type'        => 'integer',
								'description' => 'Maximum number of concurrent sandbox runs. Defaults to 2.',
							),
							'agent'                  => array( 'type' => 'string' ),
							'mode'                   => array( 'type' => 'string' ),
							'provider'               => array( 'type' => 'string' ),
							'model'                  => array( 'type' => 'string' ),
							'provider_plugin_paths'  => array(
								'type'  => 'array',
								'items' => array( 'type' => 'string' ),
							),
							'secret_env'             => array(
								'type'  => 'array',
								'items' => array( 'type' => 'string' ),
							),
							'max_turns'              => array( 'type' => 'integer' ),
							'wp'                     => array( 'type' => 'string' ),
							'artifacts_path'         => array( 'type' => 'string' ),
							'wp_codebox_bin'    => array( 'type' => 'string' ),
							'agents_api_path'        => array( 'type' => 'string' ),
							'data_machine_path'      => array( 'type' => 'string' ),
							'data_machine_code_path' => array( 'type' => 'string' ),
						),
					),
					'output_schema'       => array(
						'type'       => 'object',
						'properties' => array(
							'success'     => array( 'type' => 'boolean' ),
							'schema'      => array( 'type' => 'string' ),
							'tasks'       => array( 'type' => 'array' ),
							'concurrency' => array( 'type' => 'integer' ),
							'paths'       => array( 'type' => 'object' ),
							'artifacts'   => array( 'type' => 'string' ),
							'exit_code'   => array( 'type' => 'integer' ),
							'run'         => array( 'type' => 'object' ),
						),
					),
					'execute_callback'    => array( self::class, 'run_agent_task_batch' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);
		};

		if ( function_exists( 'doing_action' ) && doing_action( 'wp_abilities_api_init' ) ) {
			$register_callback();
			return;
		}

		add_action( 'wp_abilities_api_init', $register_callback );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function run_agent_task( array $input ): array|WP_Error {
		return ( new WP_Codebox_Agent_Sandbox_Runner() )->run( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function run_agent_task_batch( array $input ): array|WP_Error {
		return ( new WP_Codebox_Agent_Sandbox_Runner() )->run_batch( $input );
	}

	public static function can_run_agent_task(): bool {
		$allowed = current_user_can( 'manage_options' );

		return (bool) apply_filters( 'wp_codebox_can_run_agent_task', $allowed );
	}
}
