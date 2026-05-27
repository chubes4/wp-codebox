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
			$task_input_schema  = self::task_input_schema();
			$mount_schema      = self::mount_schema();
			$inherit_schema    = self::inherit_schema();
			$session_schema    = self::sandbox_session_schema();
			$session_input     = self::sandbox_session_input_schema();
			$artifact_id_schema = array(
				'artifact_id'    => array(
					'type'        => 'string',
					'description' => 'Artifact bundle id from manifest.json.',
				),
				'artifacts_path' => array(
					'type'        => 'string',
					'description' => 'Root directory containing WP Codebox artifact bundles.',
				),
			);

			wp_register_ability(
				'wp-codebox/run-agent-task',
				array(
					'label'               => 'Run Agent Sandbox Task',
					'description'         => 'Run a bounded task inside an isolated WP Codebox WordPress agent sandbox and return artifacts.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'anyOf'      => array(
							array( 'required' => array( 'goal' ) ),
							array( 'required' => array( 'task' ) ),
						),
						'properties' => array(
							'goal'                   => $task_input_schema['properties']['goal'],
							'task'                   => array(
								'type'        => 'string',
								'description' => 'Legacy task description. Prefer goal for new product callers.',
							),
							'target'                 => $task_input_schema['properties']['target'],
							'allowed_tools'          => $task_input_schema['properties']['allowed_tools'],
							'expected_artifacts'     => $task_input_schema['properties']['expected_artifacts'],
							'policy'                 => $task_input_schema['properties']['policy'],
							'context'                => $task_input_schema['properties']['context'],
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
							'mounts'                 => $mount_schema,
							'inherit'                => $inherit_schema,
							'sandbox_session_id'     => $session_input['sandbox_session_id'],
							'orchestrator'           => $session_input['orchestrator'],
							'secret_env'             => array(
								'type'        => 'array',
								'description' => 'Explicit parent environment variable names to expose inside the sandbox. Prefer connector-scoped inheritance credentials for product flows. Values are read from the parent process and are not accepted in this payload.',
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
							'preview_hold_seconds'   => array(
								'type'        => 'integer',
								'description' => 'Seconds to keep the live Playground preview URL available after capture. Max 3600.',
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
							'session'   => $session_schema,
							'task'      => array( 'type' => 'string' ),
							'task_input' => $task_input_schema,
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
								'description' => 'Task descriptions or structured task inputs. Each task runs in its own isolated sandbox.',
								'items'       => array(
									'anyOf' => array(
										array( 'type' => 'string' ),
										$task_input_schema,
									),
								),
							),
							'agent'                  => array( 'type' => 'string' ),
							'mode'                   => array( 'type' => 'string' ),
							'provider'               => array( 'type' => 'string' ),
							'model'                  => array( 'type' => 'string' ),
							'provider_plugin_paths'  => array(
								'type'  => 'array',
								'items' => array( 'type' => 'string' ),
							),
							'mounts'                 => $mount_schema,
							'inherit'                => $inherit_schema,
							'sandbox_session_id'     => $session_input['sandbox_session_id'],
							'orchestrator'           => $session_input['orchestrator'],
							'secret_env'             => array(
								'type'  => 'array',
								'items' => array( 'type' => 'string' ),
							),
							'max_turns'              => array( 'type' => 'integer' ),
							'preview_hold_seconds'   => array( 'type' => 'integer' ),
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
							'session'     => $session_schema,
							'tasks'       => array( 'type' => 'array' ),
							'task_inputs' => array(
								'type'  => 'array',
								'items' => $task_input_schema,
							),
							'execution'   => array( 'type' => 'string' ),
							'total'       => array( 'type' => 'integer' ),
							'completed'   => array( 'type' => 'integer' ),
							'failed'      => array( 'type' => 'integer' ),
							'paths'       => array( 'type' => 'object' ),
							'artifacts'   => array( 'type' => 'string' ),
							'runs'        => array(
								'type'  => 'array',
								'items' => array(
									'type'       => 'object',
									'properties' => array(
										'index'       => array( 'type' => 'integer' ),
										'task'        => array( 'type' => 'string' ),
										'task_input'  => $task_input_schema,
										'success'     => array( 'type' => 'boolean' ),
										'status'      => array( 'type' => 'string' ),
										'exit_code'   => array( 'type' => 'integer' ),
										'session'     => $session_schema,
										'artifact_id' => array( 'type' => 'string' ),
										'preview_url' => array( 'type' => 'string' ),
										'artifacts'   => array( 'type' => 'object' ),
										'run'         => array( 'type' => 'object' ),
										'error'       => array( 'type' => 'object' ),
									),
								),
							),
						),
					),
					'execute_callback'    => array( self::class, 'run_agent_task_batch' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/list-artifacts',
				array(
					'label'               => 'List WP Codebox Artifacts',
					'description'         => 'List artifact bundles under the configured WP Codebox artifact root.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'properties' => array(
							'artifacts_path' => $artifact_id_schema['artifacts_path'],
						),
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'list_artifacts' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/get-artifact',
				array(
					'label'               => 'Get WP Codebox Artifact',
					'description'         => 'Read one WP Codebox artifact bundle by id.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'artifact_id' ),
						'properties' => $artifact_id_schema,
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'get_artifact' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/discard-artifact',
				array(
					'label'               => 'Discard WP Codebox Artifact',
					'description'         => 'Delete one WP Codebox artifact bundle from the configured artifact root.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'artifact_id' ),
						'properties' => $artifact_id_schema,
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'discard_artifact' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/apply-approved-artifact',
				array(
					'label'               => 'Apply Approved WP Codebox Artifact',
					'description'         => 'Validate an approved canonical artifact patch and hand it to the configured apply-back adapter.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'artifact_id', 'approved_files' ),
						'properties' => array_merge(
							$artifact_id_schema,
							array(
								'approved_files' => array(
									'type'        => 'array',
									'description' => 'Explicit sandbox file paths approved by the parent-site reviewer.',
									'items'       => array( 'type' => 'string' ),
								),
								'approver'       => array(
									'type'        => 'string',
									'description' => 'Parent-site approver principal for audit records.',
								),
							)
						),
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'apply_approved_artifact' ),
					'permission_callback' => array( self::class, 'can_run_agent_task' ),
					'meta'                => array( 'show_in_rest' => true ),
				)
			);

			wp_register_ability(
				'wp-codebox/stage-artifact-apply',
				array(
					'label'               => 'Stage WP Codebox Artifact Apply',
					'description'         => 'Stage a reviewed WP Codebox artifact apply-back request through Data Machine pending actions.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'required'   => array( 'artifact_id', 'approved_files' ),
						'properties' => array_merge(
							$artifact_id_schema,
							array(
								'approved_files' => array(
									'type'        => 'array',
									'description' => 'Explicit sandbox file paths approved by the parent-site reviewer.',
									'items'       => array( 'type' => 'string' ),
								),
								'approver'       => array(
									'type'        => 'string',
									'description' => 'Parent-site approver principal for audit records.',
								),
								'apply_target'   => array(
									'type'        => 'object',
									'description' => 'Optional parent-control-plane target metadata consumed by the apply adapter.',
								),
								'summary'        => array(
									'type'        => 'string',
									'description' => 'Optional human-readable pending-action summary.',
								),
								'agent_id'       => array( 'type' => 'integer' ),
								'user_id'        => array( 'type' => 'integer' ),
								'context'        => array( 'type' => 'object' ),
							)
						),
					),
					'output_schema'       => array( 'type' => 'object' ),
					'execute_callback'    => array( self::class, 'stage_artifact_apply' ),
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

	/** @return array<string,mixed> */
	private static function mount_schema(): array {
		return array(
			'type'        => 'array',
			'description' => 'Additional host directories to mount into the sandbox. Callers may attach repo metadata for downstream tools that need to map sandbox paths back to source repositories.',
			'items'       => array(
				'type'       => 'object',
				'required'   => array( 'source', 'target' ),
				'properties' => array(
					'source'   => array(
						'type'        => 'string',
						'description' => 'Host directory path to mount.',
					),
					'target'   => array(
						'type'        => 'string',
						'description' => 'Absolute sandbox path, such as /wordpress/wp-content/plugins/example.',
					),
					'mode'     => array(
						'type' => 'string',
						'enum' => array( 'readonly', 'readwrite' ),
					),
					'metadata' => array(
						'type'        => 'object',
						'description' => 'Opaque caller metadata, for example repo, default_branch, repo_root_relative_to_mount, and editable flags.',
					),
				),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function inherit_schema(): array {
		$credential_secret_schema = array(
			'type'       => 'object',
			'required'   => array( 'name', 'status' ),
			'properties' => array(
				'name'   => array(
					'type'        => 'string',
					'description' => 'Sandbox environment variable name. Secret values are never transported.',
				),
				'status' => array(
					'type' => 'string',
					'enum' => array( 'available', 'missing', 'denied' ),
				),
				'scope'  => array(
					'type'        => 'string',
					'description' => 'Parent-side connector scope that authorized this secret name.',
				),
				'source' => array(
					'type'        => 'string',
					'description' => 'Redacted source label, such as parent-env or connector.',
				),
				'reason' => array(
					'type'        => 'string',
					'description' => 'Redacted missing/denied reason for audit surfaces.',
				),
			),
		);

		return array(
			'type'        => 'object',
			'description' => 'Declarative request for parent-environment connector or setting inheritance. Parent filters resolve names into a sanitized sandbox payload with explicit connector-scoped credential envelopes; secret values are never accepted here.',
			'properties'  => array(
				'connectors' => array(
					'type'        => 'array',
					'description' => 'Connector names the parent environment should resolve for this sandbox run.',
					'items'       => array( 'type' => 'string' ),
				),
				'settings'   => array(
					'type'        => 'array',
					'description' => 'Setting names the parent environment should resolve for artifact/audit metadata. Values are not transported in this slice.',
					'items'       => array( 'type' => 'string' ),
				),
				'credentials' => array(
					'type'        => 'object',
					'description' => 'Observable credential envelope shape returned under inheritance.connectors[].credentials by parent filters. Values are not accepted.',
					'properties'  => array(
						'schema'    => array( 'type' => 'string' ),
						'connector' => array( 'type' => 'string' ),
						'scope'     => array( 'type' => 'string', 'enum' => array( 'connector' ) ),
						'status'    => array( 'type' => 'string', 'enum' => array( 'available', 'missing', 'denied' ) ),
						'reason'    => array( 'type' => 'string' ),
						'secrets'   => array( 'type' => 'array', 'items' => $credential_secret_schema ),
					),
				),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function sandbox_session_input_schema(): array {
		return array(
			'sandbox_session_id' => array(
				'type'        => 'string',
				'description' => 'Caller-owned sandbox session id for external job/session systems. WP Codebox returns it in the response but does not persist sessions itself.',
			),
			'orchestrator'       => array(
				'type'        => 'object',
				'description' => 'Optional caller-owned job/session metadata, such as external job system, job id, or control-plane id. Values are copied into the response session envelope for correlation only.',
				'properties'  => array(
					'id'     => array( 'type' => 'string' ),
					'type'   => array( 'type' => 'string' ),
					'job_id' => array( 'type' => 'string' ),
				),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function sandbox_session_schema(): array {
		return array(
			'type'       => 'object',
			'properties' => array(
				'schema'           => array(
					'type'        => 'string',
					'description' => 'Session envelope contract version. Use wp-codebox/sandbox-session/v1.',
				),
				'id'               => array(
					'type'        => 'string',
					'description' => 'Caller-owned sandbox session id echoed for external orchestration correlation.',
				),
				'status'           => array(
					'type'        => 'string',
					'enum'        => array( 'completed' ),
					'description' => 'Synchronous WP Codebox run status. Durable queued/running/cancelled/expired state belongs to the external orchestrator.',
				),
				'persistence'      => array(
					'type'        => 'string',
					'enum'        => array( 'external-orchestrator' ),
					'description' => 'WP Codebox does not persist host-site session lifecycle state; callers own durable records.',
				),
				'agent_session_id' => array( 'type' => 'string' ),
				'orchestrator'     => array( 'type' => 'object' ),
				'artifacts'        => array( 'type' => 'object' ),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function task_input_schema(): array {
		return array(
			'type'       => 'object',
			'required'   => array( 'goal' ),
			'properties' => array(
				'schema'             => array(
					'type'        => 'string',
					'description' => 'Task input contract version. Use wp-codebox/task-input/v1.',
				),
				'goal'               => array(
					'type'        => 'string',
					'description' => 'User-facing outcome the sandboxed coding agent should accomplish.',
				),
				'target'             => array(
					'type'        => 'object',
					'description' => 'Bounded target for the task, such as a repo, site, plugin, or theme.',
					'properties'  => array(
						'kind' => array( 'type' => 'string' ),
						'ref'  => array( 'type' => 'string' ),
						'path' => array( 'type' => 'string' ),
						'url'  => array( 'type' => 'string' ),
					),
				),
				'allowed_tools'      => array(
					'type'        => 'array',
					'description' => 'Tool names the product caller expects the sandboxed agent to stay within.',
					'items'       => array( 'type' => 'string' ),
				),
				'expected_artifacts' => array(
					'type'        => 'array',
					'description' => 'Artifact kinds the caller wants back, such as patch, review, tests, preview, or package.',
					'items'       => array( 'type' => 'string' ),
				),
				'policy'             => array(
					'type'        => 'object',
					'description' => 'Caller policy hints for approvals, apply-back, sandboxing, and risk controls.',
				),
				'context'            => array(
					'type'        => 'object',
					'description' => 'Additional non-secret caller context for the sandboxed task.',
				),
			),
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function run_agent_task( array $input ): array|WP_Error {
		return ( new WP_Codebox_Agent_Sandbox_Runner() )->run( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function run_agent_task_batch( array $input ): array|WP_Error {
		return ( new WP_Codebox_Agent_Sandbox_Runner() )->run_batch( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function list_artifacts( array $input = array() ): array|WP_Error {
		return ( new WP_Codebox_Artifacts() )->list( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function get_artifact( array $input ): array|WP_Error {
		return ( new WP_Codebox_Artifacts() )->get( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function discard_artifact( array $input ): array|WP_Error {
		return ( new WP_Codebox_Artifacts() )->discard( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function apply_approved_artifact( array $input ): array|WP_Error {
		return ( new WP_Codebox_Artifacts() )->apply_approved( $input );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function stage_artifact_apply( array $input ): array|WP_Error {
		return WP_Codebox_Data_Machine_Pending_Actions::stage_apply_artifact( $input );
	}

	public static function can_run_agent_task(): bool {
		$allowed = current_user_can( 'manage_options' );

		return (bool) apply_filters( 'wp_codebox_can_run_agent_task', $allowed );
	}
}
