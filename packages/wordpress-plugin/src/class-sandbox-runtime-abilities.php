<?php
/**
 * Sandbox Runtime abilities.
 *
 * @package SandboxRuntime
 */

defined( 'ABSPATH' ) || exit;

final class Sandbox_Runtime_Abilities {

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
				'sandbox-runtime/run-agent-task',
				array(
					'label'               => 'Run Agent Sandbox Task',
					'description'         => 'Run a bounded task inside an isolated Sandbox Runtime WordPress agent sandbox and return artifacts.',
					'category'            => 'sandbox-runtime',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'task' ),
						'properties' => array(
							'task'                   => array(
								'type'        => 'string',
								'description' => 'Task description to run inside the isolated sandbox.',
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
								'description' => 'Directory where Sandbox Runtime should write artifact bundles.',
							),
							'sandbox_runtime_bin'    => array(
								'type'        => 'string',
								'description' => 'Sandbox Runtime CLI binary or path. JS dist files are run through node.',
							),
							'agents_api_path'        => array( 'type' => 'string' ),
							'data_machine_path'      => array( 'type' => 'string' ),
							'data_machine_code_path' => array( 'type' => 'string' ),
							'openai_provider_path'   => array( 'type' => 'string' ),
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
		};

		if ( function_exists( 'doing_action' ) && doing_action( 'wp_abilities_api_init' ) ) {
			$register_callback();
			return;
		}

		add_action( 'wp_abilities_api_init', $register_callback );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function run_agent_task( array $input ): array|WP_Error {
		return ( new Sandbox_Runtime_Agent_Sandbox_Runner() )->run( $input );
	}

	public static function can_run_agent_task(): bool {
		$allowed = current_user_can( 'manage_options' );

		return (bool) apply_filters( 'sandbox_runtime_can_run_agent_task', $allowed );
	}
}
