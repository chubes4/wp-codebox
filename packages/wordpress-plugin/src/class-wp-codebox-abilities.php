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

		$this->register_category();
		$this->register();
		self::$registered = true;
	}

	/**
	 * Register the `wp-codebox` ability category.
	 *
	 * As of WordPress 6.9 the Abilities API requires the category to be
	 * registered before any ability that declares it; unregistered categories
	 * cause `wp_register_ability()` to return `null` and silently drop the
	 * ability. Categories must be registered on `wp_abilities_api_categories_init`.
	 */
	private function register_category(): void {
		if ( ! function_exists( 'wp_register_ability_category' ) ) {
			return;
		}

		$register_category = static function (): void {
			wp_register_ability_category(
				'wp-codebox',
				array(
					'label'       => 'WP Codebox',
					'description' => 'Disposable WordPress Playground sandbox runs, artifact capture, and reviewed apply-back.',
				)
			);
		};

		if ( function_exists( 'doing_action' ) && doing_action( 'wp_abilities_api_categories_init' ) ) {
			$register_category();
			return;
		}

		add_action( 'wp_abilities_api_categories_init', $register_category );
	}

	private function register(): void {
		$register_callback = function (): void {
			$task_input_schema  = self::task_input_schema();
			$mount_schema      = self::mount_schema();
			$inherit_schema    = self::inherit_schema();
			$session_schema    = self::sandbox_session_schema();
			$browser_session_schema = self::browser_playground_session_schema();
			$session_input     = self::sandbox_session_input_schema();
			$preview_schema    = self::preview_input_schema();
			$outcome_schema    = self::remediation_outcome_schema();
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
							'preview_hold_seconds'   => $preview_schema['preview_hold_seconds'],
							'preview_port'           => $preview_schema['preview_port'],
							'preview_bind'           => $preview_schema['preview_bind'],
							'preview_public_url'     => $preview_schema['preview_public_url'],
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
							'outcome'   => $outcome_schema,
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
							'preview_hold_seconds'   => $preview_schema['preview_hold_seconds'],
							'preview_port'           => $preview_schema['preview_port'],
							'preview_bind'           => $preview_schema['preview_bind'],
							'preview_public_url'     => $preview_schema['preview_public_url'],
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
										'outcome'     => $outcome_schema,
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
				'wp-codebox/create-browser-playground-session',
				array(
					'label'               => 'Create Browser Playground Session',
					'description'         => 'Prepare a WP Codebox browser-executed WordPress Playground session without requiring the host to run the WP Codebox CLI or Node.',
					'category'            => 'wp-codebox',
					'input_schema'        => array(
						'type'       => 'object',
						'anyOf'      => array(
							array( 'required' => array( 'goal' ) ),
							array( 'required' => array( 'task' ) ),
						),
						'properties' => array(
							'goal'               => $task_input_schema['properties']['goal'],
							'task'               => array(
								'type'        => 'string',
								'description' => 'Legacy task description. Prefer goal for new product callers.',
							),
							'target'             => $task_input_schema['properties']['target'],
							'allowed_tools'      => $task_input_schema['properties']['allowed_tools'],
							'expected_artifacts' => $task_input_schema['properties']['expected_artifacts'],
							'policy'             => $task_input_schema['properties']['policy'],
							'context'            => $task_input_schema['properties']['context'],
							'provider_plugin_paths' => array(
								'type'        => 'array',
								'description' => 'AI provider plugin directories the browser sandbox should have available before code execution.',
								'items'       => array( 'type' => 'string' ),
							),
							'inherit'            => $inherit_schema,
							'secret_env'         => array(
								'type'        => 'array',
								'description' => 'Parent environment variable names expected to be available to the browser sandbox. Values are never accepted in this payload.',
								'items'       => array( 'type' => 'string' ),
							),
							'sandbox_session_id' => $session_input['sandbox_session_id'],
							'orchestrator'       => $session_input['orchestrator'],
							'playground'         => array(
								'type'        => 'object',
								'description' => 'Optional browser Playground client and artifact preview configuration overrides.',
							),
							'browser_runner'     => array(
								'type'        => 'object',
								'description' => 'Optional PHP-WASM runner paths for executing the task inside the browser Playground site.',
							),
							'browser_plugins'    => array(
								'type'        => 'array',
								'description' => 'Optional plugin zip URLs the browser Playground should install and activate before running the recipe.',
								'items'       => array( 'type' => 'object' ),
							),
							'blueprint'          => array(
								'type'        => 'object',
								'description' => 'Optional WordPress Playground blueprint for the browser to compile and run.',
							),
							'artifact_files'     => array(
								'type'        => 'array',
								'description' => 'Optional text artifact files the browser should write into Playground.',
								'items'       => array(
									'type'       => 'object',
									'required'   => array( 'path', 'content' ),
									'properties' => array(
										'path'        => array( 'type' => 'string' ),
										'content'     => array( 'type' => 'string' ),
										'kind'        => array( 'type' => 'string' ),
										'description' => array( 'type' => 'string' ),
									),
								),
							),
						),
					),
					'output_schema'       => $browser_session_schema,
					'execute_callback'    => array( self::class, 'create_browser_playground_session' ),
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

	/** @return array<string,array<string,mixed>> */
	private static function preview_input_schema(): array {
		return array(
			'preview_hold_seconds' => array(
				'type'        => 'integer',
				'description' => 'Seconds to keep the live Playground preview URL available after capture. Max 3600.',
			),
			'preview_port'         => array(
				'type'        => 'integer',
				'minimum'     => 1,
				'maximum'     => 65535,
				'description' => 'Optional fixed local WP Codebox preview proxy port. Omit to keep the default loopback-only random-port behavior.',
			),
			'preview_bind'         => array(
				'type'        => 'string',
				'description' => 'Optional fixed-port preview proxy bind host or IP. Requires preview_port. Defaults to 127.0.0.1 when omitted.',
			),
			'preview_public_url'   => array(
				'type'        => 'string',
				'format'      => 'uri',
				'description' => 'Optional public http/https URL reported in preview metadata and passed to the sandbox for site URL alignment.',
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
	private static function remediation_outcome_schema(): array {
		return array(
			'type'        => 'object',
			'description' => 'Strict audit-remediation terminal outcome. Sandbox runs return reviewed artifacts when they can remediate, or an explicit terminal no-op/failure outcome when they cannot. Parent orchestrators apply artifacts and open PRs outside the sandbox.',
			'properties'  => array(
				'schema'                => array( 'type' => 'string' ),
				'success'               => array( 'type' => 'boolean' ),
				'kind'                  => array(
					'type' => 'string',
					'enum' => array( 'fix_artifact', 'false_positive_artifact', 'noop_artifact', 'unable_to_remediate', 'fix_pr', 'false_positive_pr', 'provider_error', 'agent_no_pr_outcome', 'max_turns_exceeded' ),
				),
				'failure'               => array(
					'type' => 'string',
					'enum' => array( 'provider_error', 'agent_no_pr_outcome', 'max_turns_exceeded', '' ),
				),
				'pr_url'                => array( 'type' => 'string' ),
				'false_positive_pr_url' => array( 'type' => 'string' ),
				'exit_code'             => array( 'type' => 'integer' ),
				'retryable'             => array( 'type' => 'boolean' ),
				'provider_error'        => array( 'type' => 'object' ),
				'artifact'              => array( 'type' => 'object' ),
				'metadata'              => array( 'type' => 'object' ),
				'diagnostics'           => array( 'type' => 'object' ),
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
	private static function browser_playground_session_schema(): array {
		return array(
			'type'       => 'object',
			'properties' => array(
				'success'    => array( 'type' => 'boolean' ),
				'schema'     => array( 'type' => 'string' ),
				'execution'  => array(
					'type'        => 'string',
					'enum'        => array( 'browser-playground' ),
					'description' => 'The caller browser executes WordPress Playground; the host site does not run the WP Codebox CLI.',
				),
				'session'    => array( 'type' => 'object' ),
				'task_input' => self::task_input_schema(),
				'playground' => array( 'type' => 'object' ),
				'recipe'     => array( 'type' => 'object' ),
				'signals'    => array( 'type' => 'object' ),
				'artifacts'  => array( 'type' => 'object' ),
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
	public static function create_browser_playground_session( array $input ): array|WP_Error {
		$task_input = self::normalize_task_input( $input );
		if ( is_wp_error( $task_input ) ) {
			return $task_input;
		}

		$session_id = trim( (string) ( $input['sandbox_session_id'] ?? $input['session_id'] ?? '' ) );
		if ( '' === $session_id ) {
			$session_id = self::generate_id();
		}

		$playground     = is_array( $input['playground'] ?? null ) ? $input['playground'] : array();
		$browser_runner = is_array( $input['browser_runner'] ?? null ) ? $input['browser_runner'] : array();
		$browser_plugins = self::browser_plugins( $input );
		if ( is_wp_error( $browser_plugins ) ) {
			return $browser_plugins;
		}

		$blueprint      = self::browser_blueprint_with_plugins( is_array( $input['blueprint'] ?? null ) ? $input['blueprint'] : array(), $browser_plugins, $playground );
		$artifacts      = self::browser_artifact_files( $input );
		if ( is_wp_error( $artifacts ) ) {
			return $artifacts;
		}
		$ready_to_code = self::browser_ready_to_code_signal( $input );

		$recipe = self::browser_agent_recipe( $task_input, $session_id, $browser_runner, $blueprint, $playground );
		if ( is_wp_error( $recipe ) ) {
			return $recipe;
		}

		return array(
			'success'    => true,
			'schema'     => 'wp-codebox/browser-playground-session/v1',
			'execution'  => 'browser-playground',
			'session'    => array(
				'schema'       => 'wp-codebox/browser-playground-session/v1',
				'id'           => $session_id,
				'status'       => 'ready',
				'persistence'  => 'external-orchestrator',
				'orchestrator' => is_array( $input['orchestrator'] ?? null ) ? $input['orchestrator'] : array(),
			),
			'task_input' => $task_input,
			'agent'      => (string) ( $input['agent'] ?? 'wp-codebox-sandbox' ),
			'plugins'    => $browser_plugins,
			'playground' => array(
				'client_module_url'  => (string) ( $playground['client_module_url'] ?? 'https://playground.automattic.ai/client/index.js' ),
				'remote_url'         => (string) ( $playground['remote_url'] ?? 'https://playground.automattic.ai/remote.html' ),
				'scope'              => (string) ( $playground['scope'] ?? $session_id ),
				'artifact_base_path' => self::browser_artifact_base_path( $playground ),
				'artifact_base_url'  => self::browser_artifact_base_url( $playground ),
				'preview_url'        => self::browser_preview_url( $artifacts, $playground ),
				'blueprint'          => self::browser_playground_blueprint( $blueprint, $playground ),
				'capabilities'       => array(
					'compile_blueprint' => true,
					'run_blueprint'     => true,
					'write_file'        => true,
					'run_php'           => true,
				),
			),
			'recipe'     => $recipe,
			'signals'    => array(
				'ready_to_code' => $ready_to_code,
			),
			'artifacts'  => array(
				'schema'             => 'wp-codebox/browser-artifacts/v1',
				'files'              => $artifacts,
				'preview_url'        => self::browser_preview_url( $artifacts, $playground ),
				'expected_artifacts' => $task_input['expected_artifacts'],
			),
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed> */
	private static function browser_ready_to_code_signal( array $input ): array {
		$provider_plugin_paths = array_values(
			array_filter(
				array_map( 'strval', is_array( $input['provider_plugin_paths'] ?? null ) ? $input['provider_plugin_paths'] : array() ),
				static fn( string $path ): bool => '' !== trim( $path )
			)
		);
		$inherit      = is_array( $input['inherit'] ?? null ) ? $input['inherit'] : array();
		$connectors   = array_values( array_filter( array_map( 'strval', is_array( $inherit['connectors'] ?? null ) ? $inherit['connectors'] : array() ) ) );
		$secret_env   = array_values( array_filter( array_map( 'strval', is_array( $input['secret_env'] ?? null ) ? $input['secret_env'] : array() ) ) );
		$requirements = array(
			'agents_api'        => self::agents_api_ready(),
			'data_machine'      => self::plugin_path_ready( 'data-machine' ),
			'data_machine_code' => self::plugin_path_ready( 'data-machine-code' ),
			'provider_plugin'   => ! empty( $provider_plugin_paths ) && self::all_paths_ready( $provider_plugin_paths ),
			'provider_secret'   => ! empty( $connectors ) || ! empty( $secret_env ),
		);

		/**
		 * Filters browser sandbox readiness requirements before the signal is emitted.
		 *
		 * @param array<string,bool>  $requirements Named readiness checks.
		 * @param array<string,mixed> $input        Ability input.
		 */
		$requirements = apply_filters( 'wp_codebox_browser_ready_to_code_requirements', $requirements, $input );
		$requirements = is_array( $requirements ) ? array_map( 'boolval', $requirements ) : array();
		$missing      = array_keys( array_filter( $requirements, static fn( bool $ready ): bool => ! $ready ) );
		$emitted      = empty( $missing );

		return array(
			'schema'       => 'wp-codebox/signal/v1',
			'name'         => 'ready_to_code',
			'emitted'      => $emitted,
			'message'      => $emitted ? 'Browser Playground sandbox is ready to code.' : 'Browser Playground sandbox is not ready to code.',
			'requirements' => $requirements,
			'missing'      => $missing,
		);
	}

	private static function agents_api_ready(): bool {
		if ( ! function_exists( 'wp_get_ability' ) ) {
			return false;
		}

		return (bool) wp_get_ability( 'agents/chat' );
	}

	private static function plugin_path_ready( string $plugin_slug ): bool {
		if ( ! defined( 'WP_PLUGIN_DIR' ) ) {
			return false;
		}

		return is_dir( rtrim( WP_PLUGIN_DIR, '/\\' ) . '/' . $plugin_slug );
	}

	/** @param array<int,string> $paths Paths to verify. */
	private static function all_paths_ready( array $paths ): bool {
		foreach ( $paths as $path ) {
			if ( ! is_dir( $path ) ) {
				return false;
			}
		}

		return true;
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

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private static function normalize_task_input( array $input ): array|WP_Error {
		$goal = trim( (string) ( $input['goal'] ?? $input['task'] ?? '' ) );
		if ( '' === $goal ) {
			return new WP_Error( 'wp_codebox_task_missing', 'goal or task is required.', array( 'status' => 400 ) );
		}

		return array(
			'schema'             => 'wp-codebox/task-input/v1',
			'goal'               => $goal,
			'target'             => is_array( $input['target'] ?? null ) ? $input['target'] : array(),
			'allowed_tools'      => self::string_list( $input['allowed_tools'] ?? array() ),
			'expected_artifacts' => self::string_list( $input['expected_artifacts'] ?? array() ),
			'policy'             => is_array( $input['policy'] ?? null ) ? $input['policy'] : array(),
			'context'            => is_array( $input['context'] ?? null ) ? $input['context'] : array(),
		);
	}

	/** @return string[] */
	private static function string_list( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		$items = array();
		foreach ( $value as $item ) {
			$item = trim( (string) $item );
			if ( '' !== $item && ! in_array( $item, $items, true ) ) {
				$items[] = $item;
			}
		}

		return $items;
	}

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,string>>|WP_Error */
	private static function browser_artifact_files( array $input ): array|WP_Error {
		$files      = is_array( $input['artifact_files'] ?? null ) ? $input['artifact_files'] : array();
		$playground = is_array( $input['playground'] ?? null ) ? $input['playground'] : array();
		$base_path  = self::browser_artifact_base_path( $playground );
		$base_url   = self::browser_artifact_base_url( $playground );
		$normalized = array();
		foreach ( $files as $index => $file ) {
			if ( ! is_array( $file ) ) {
				return new WP_Error( 'wp_codebox_browser_artifact_file_invalid', 'Each browser artifact file must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			$path = trim( (string) ( $file['path'] ?? '' ) );
			if ( '' === $path || str_contains( $path, '..' ) || str_starts_with( $path, '/' ) || ! preg_match( '#^[A-Za-z0-9_./-]+$#', $path ) ) {
				return new WP_Error( 'wp_codebox_browser_artifact_path_invalid', 'Browser artifact file paths must be safe relative paths.', array( 'status' => 400, 'index' => $index ) );
			}

			$normalized[] = array(
				'path'            => $path,
				'playground_path' => self::join_browser_path( $base_path, $path ),
				'url_path'        => self::join_browser_path( $base_url, $path ),
				'content'         => (string) ( $file['content'] ?? '' ),
				'kind'            => (string) ( $file['kind'] ?? 'text' ),
				'description'     => (string) ( $file['description'] ?? '' ),
			);
		}

		return $normalized;
	}

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
	private static function browser_plugins( array $input ): array|WP_Error {
		$plugins = is_array( $input['browser_plugins'] ?? null ) ? $input['browser_plugins'] : array();
		$normalized = array();

		foreach ( $plugins as $index => $plugin ) {
			if ( ! is_array( $plugin ) ) {
				return new WP_Error( 'wp_codebox_browser_plugin_invalid', 'Each browser plugin must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			$url = trim( (string) ( $plugin['url'] ?? '' ) );
			$slug = self::safe_key( (string) ( $plugin['slug'] ?? '' ) );
			if ( '' === $url || ! preg_match( '#^https?://#i', $url ) ) {
				return new WP_Error( 'wp_codebox_browser_plugin_url_invalid', 'Browser plugin URL must be an http or https URL.', array( 'status' => 400, 'index' => $index ) );
			}

			$normalized[] = array(
				'url'      => $url,
				'slug'     => $slug,
				'activate' => ! array_key_exists( 'activate', $plugin ) || (bool) $plugin['activate'],
			);
		}

		return $normalized;
	}

	private static function safe_key( string $value ): string {
		if ( function_exists( 'sanitize_key' ) ) {
			return sanitize_key( $value );
		}

		return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', $value ) ?? '' );
	}

	/** @param array<string,mixed> $blueprint Blueprint override. @param array<int,array<string,mixed>> $plugins Browser plugins. @return array<string,mixed> */
	private static function browser_blueprint_with_plugins( array $blueprint, array $plugins, array $playground = array() ): array {
		$steps = is_array( $blueprint['steps'] ?? null ) ? $blueprint['steps'] : array();
		if ( ! self::browser_blueprint_has_login_step( $steps ) ) {
			array_unshift(
				$steps,
				array(
					'step'     => 'login',
					'username' => 'admin',
					'password' => 'password',
				)
			);
		}

		foreach ( $plugins as $plugin ) {
			$steps[] = array(
				'step'       => 'installPlugin',
				'pluginData' => array(
					'resource' => 'url',
					'url'      => $plugin['url'],
				),
				'options'    => array(
					'activate' => (bool) $plugin['activate'],
				),
			);
		}

		$blueprint['steps'] = $steps;
		if ( ! isset( $blueprint['preferredVersions'] ) ) {
			$blueprint['preferredVersions'] = array(
				'wp'  => (string) ( $playground['wp'] ?? 'latest' ),
				'php' => (string) ( $playground['php'] ?? 'latest' ),
			);
		}
		if ( ! isset( $blueprint['features'] ) ) {
			$blueprint['features'] = array( 'networking' => true );
		}

		return $blueprint;
	}

	/** @param array<int,mixed> $steps Blueprint steps. */
	private static function browser_blueprint_has_login_step( array $steps ): bool {
		foreach ( $steps as $step ) {
			if ( is_array( $step ) && 'login' === (string) ( $step['step'] ?? '' ) ) {
				return true;
			}
		}

		return false;
	}

	/** @param array<string,mixed> $task_input Normalized task input. @param array<string,mixed> $runner Runner overrides. @return array<string,mixed>|WP_Error */
	private static function browser_agent_recipe( array $task_input, string $session_id, array $runner, array $blueprint, array $playground ): array|WP_Error {
		$task_path   = (string) ( $runner['task_path'] ?? '/tmp/wp-codebox-agent-task.json' );
		$result_path = (string) ( $runner['result_path'] ?? '/tmp/wp-codebox-agent-result.json' );

		foreach ( array( 'task_path' => $task_path, 'result_path' => $result_path ) as $field => $path ) {
			if ( '' === $path || str_contains( $path, '..' ) || ! str_starts_with( $path, '/' ) || ! preg_match( '#^[A-Za-z0-9_./-]+$#', $path ) ) {
				return new WP_Error( 'wp_codebox_browser_runner_path_invalid', $field . ' must be a safe absolute Playground path.', array( 'status' => 400 ) );
			}
		}

		return array(
			'schema'   => 'wp-codebox/workspace-recipe/v1',
			'runtime'  => array(
				'backend'   => 'wordpress-playground',
				'name'      => 'browser-playground',
				'wp'        => (string) ( $playground['wp'] ?? 'latest' ),
				'blueprint' => self::browser_playground_blueprint( $blueprint, $playground ),
			),
			'inputs'   => array(
				'stagedFiles' => array(
					array(
						'source' => 'task-payload',
						'target' => $task_path,
					),
				),
			),
			'workflow' => array(
				'steps' => array(
					array(
						'command' => 'wordpress.run-php',
						'args'    => array(
							'code=' . self::browser_agent_runner_php( $task_input, $session_id, $task_path, $result_path ),
						),
					),
				),
			),
			'artifacts' => array(
				'directory' => '/wordpress/wp-content/uploads/studio-web',
			),
			'browser'  => array(
				'execution'   => 'php-wasm',
				'task_path'   => $task_path,
				'result_path' => $result_path,
			),
		);
	}

	private static function browser_agent_runner_php( array $task_input, string $session_id, string $task_path, string $result_path ): string {
		$default_payload = array(
			'agent'      => 'wp-codebox-sandbox',
			'message'    => (string) $task_input['goal'],
			'session_id' => $session_id,
			'task_input' => $task_input,
			'artifacts'  => array(),
		);

		return '<?php
require_once \'/wordpress/wp-load.php\';

$task_path = ' . var_export( $task_path, true ) . ';
$result_path = ' . var_export( $result_path, true ) . ';
$payload = ' . var_export( $default_payload, true ) . ';

if ( is_readable( $task_path ) ) {
	$raw_payload = json_decode( (string) file_get_contents( $task_path ), true );
	if ( is_array( $raw_payload ) ) {
		$payload = array_replace_recursive( $payload, $raw_payload );
	}
}

$agent = sanitize_key( (string) ( $payload[\'agent\'] ?? \'wp-codebox-sandbox\' ) );
$message = (string) ( $payload[\'message\'] ?? ( $payload[\'task_input\'][\'goal\'] ?? \'\' ) );
$session_id = (string) ( $payload[\'session_id\'] ?? ' . var_export( $session_id, true ) . ' );
$input = array(
	\'agent\' => $agent,
	\'message\' => $message,
	\'session_id\' => $session_id,
	\'session_owner\' => array(
		\'type\' => \'browser-playground\',
		\'key\' => $session_id,
		\'label\' => \'WP Codebox Browser Playground\',
	),
	\'client_context\' => array(
		\'source\' => \'peer-agent\',
		\'client_name\' => \'wp-codebox-browser-runner\',
		\'peer_agent_call\' => true,
		\'task_input\' => $payload[\'task_input\'] ?? array(),
	),
);

$ability = function_exists( \'wp_get_ability\' ) ? wp_get_ability( \'agents/chat\' ) : null;
if ( ! $ability instanceof WP_Ability ) {
	$result = array(
		\'success\' => false,
		\'error\' => array(
			\'code\' => \'wp_codebox_browser_agents_chat_unavailable\',
			\'message\' => \'The agents/chat ability is not available inside the Playground site.\',
		),
	);
} else {
	add_filter( \'agents_chat_permission\', \'__return_true\', 999 );
	$response = $ability->execute( $input );
	remove_filter( \'agents_chat_permission\', \'__return_true\', 999 );

	if ( is_wp_error( $response ) ) {
		$result = array(
			\'success\' => false,
			\'error\' => array(
				\'code\' => $response->get_error_code(),
				\'message\' => $response->get_error_message(),
				\'data\' => $response->get_error_data(),
			),
		);
	} else {
		$result = array(
			\'success\' => true,
			\'schema\' => \'wp-codebox/browser-agent-run/v1\',
			\'session_id\' => $session_id,
			\'task_input\' => $payload[\'task_input\'] ?? array(),
			\'response\' => $response,
			\'artifacts\' => $payload[\'artifacts\'] ?? array(),
		);
	}
}

file_put_contents( $result_path, wp_json_encode( $result ) );
echo wp_json_encode( $result );
';
	}

	/** @param array<string,mixed> $playground Playground config. */
	private static function browser_artifact_base_path( array $playground ): string {
		return self::normalize_absolute_browser_path( (string) ( $playground['artifact_base_path'] ?? '/wordpress/wp-content/uploads/wp-codebox/artifacts' ) );
	}

	/** @param array<string,mixed> $playground Playground config. */
	private static function browser_artifact_base_url( array $playground ): string {
		return self::normalize_absolute_browser_path( (string) ( $playground['artifact_base_url'] ?? '/wp-content/uploads/wp-codebox/artifacts' ) );
	}

	/** @param array<int,array<string,string>> $artifacts Artifact files. @param array<string,mixed> $playground Playground config. */
	private static function browser_preview_url( array $artifacts, array $playground ): string {
		$preview_url = trim( (string) ( $playground['preview_url'] ?? '' ) );
		if ( '' !== $preview_url ) {
			return self::normalize_absolute_browser_path( $preview_url );
		}

		$first_file = $artifacts[0]['url_path'] ?? '';
		return '' !== $first_file ? $first_file : '/';
	}

	private static function normalize_absolute_browser_path( string $path ): string {
		$path = '/' . ltrim( trim( $path ), '/' );
		$path = rtrim( $path, '/' );
		return '' === $path ? '/' : $path;
	}

	private static function join_browser_path( string $base, string $path ): string {
		return rtrim( $base, '/' ) . '/' . ltrim( $path, '/' );
	}

	/** @param array<string,mixed> $blueprint Blueprint override. @param array<string,mixed> $playground Playground config. @return array<string,mixed> */
	private static function browser_playground_blueprint( array $blueprint, array $playground ): array {
		if ( ! empty( $blueprint ) ) {
			return $blueprint;
		}

		return array(
			'preferredVersions' => array(
				'wp'  => (string) ( $playground['wp'] ?? 'latest' ),
				'php' => (string) ( $playground['php'] ?? 'latest' ),
			),
			'features'          => array(
				'networking' => true,
			),
			'steps'             => array(),
		);
	}

	private static function generate_id(): string {
		if ( function_exists( 'wp_generate_uuid4' ) ) {
			return wp_generate_uuid4();
		}

		return bin2hex( random_bytes( 16 ) );
	}
}
