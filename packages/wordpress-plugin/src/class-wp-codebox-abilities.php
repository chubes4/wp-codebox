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
			$site_seed_schema  = self::site_seed_schema();
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
							'site_seeds'             => $site_seed_schema,
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
							'task_timeout_seconds'   => array(
								'type'        => 'integer',
								'description' => 'Maximum wall-clock seconds for this sandbox task. Zero or omitted disables the host-side timeout.',
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
								'items'       => array(
									'type'       => 'object',
									'properties' => array(
										'slug'     => array( 'type' => 'string' ),
										'url'      => array( 'type' => 'string' ),
										'activate' => array( 'type' => 'boolean' ),
										'sha256'   => array( 'type' => 'string' ),
									),
								),
							),
							'runtime'            => array(
								'type'        => 'object',
								'description' => 'Structured browser Playground runtime dependencies compiled by WP Codebox into the session blueprint.',
								'properties'  => array(
									'plugins'    => array( 'type' => 'array' ),
									'mu_plugins' => array( 'type' => 'array' ),
									'themes'     => array( 'type' => 'array' ),
									'bootstrap'  => array( 'type' => 'array' ),
								),
							),
							'blueprint'          => array(
								'type'        => 'object',
								'description' => 'Optional WordPress Playground blueprint for the browser to compile and run.',
							),
							'site_blueprint_artifact' => array(
								'type'        => 'object',
								'description' => 'Caller-owned pulled-site Playground blueprint artifact to compile into the browser sandbox before Codebox runs.',
								'properties'  => array(
									'schema'     => array( 'type' => 'string' ),
									'id'         => array( 'type' => 'string' ),
									'blueprint'  => array( 'type' => 'object' ),
									'provenance' => array( 'type' => 'object' ),
								),
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
					'description'         => 'Low-level adapter/test hook that validates an approved canonical artifact patch, delegates to the configured apply-back adapter, and returns wp-codebox/apply-result/v1.',
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
					'description'         => 'Preferred user-facing API: stage a reviewed WP Codebox artifact apply-back request through Data Machine pending actions before resolving via apply-approved-artifact.',
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
	private static function site_seed_schema(): array {
		$scope_schema = array(
			'type'       => 'object',
			'properties' => array(
				'ids'          => array( 'type' => 'array', 'items' => array( 'type' => 'integer' ) ),
				'slugs'        => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
				'names'        => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
				'postTypes'    => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
				'taxonomies'   => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
				'roles'        => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
				'statuses'     => array( 'type' => 'array', 'items' => array( 'type' => 'string' ) ),
				'includeFiles' => array( 'type' => 'boolean' ),
				'anonymize'    => array( 'type' => 'boolean' ),
				'maxRecords'   => array( 'type' => 'integer', 'minimum' => 1, 'maximum' => 100 ),
			),
		);

		return array(
			'type'        => 'array',
			'description' => 'Explicit opt-in bounded parent-site seed exports for existing-site sandboxes. Exported data is written to a temporary JSON fixture and imported into the sandbox before the task runs.',
			'items'       => array(
				'type'       => 'object',
				'required'   => array( 'type', 'name', 'scopes' ),
				'properties' => array(
					'type'   => array( 'type' => 'string', 'enum' => array( 'parent_site' ) ),
					'name'   => array( 'type' => 'string' ),
					'scopes' => array(
						'type'       => 'object',
						'properties' => array(
							'posts'         => $scope_schema,
							'terms'         => $scope_schema,
							'options'       => $scope_schema,
							'users'         => $scope_schema,
							'media'         => $scope_schema,
							'activePlugins' => array( 'type' => 'boolean' ),
							'activeTheme'   => array( 'type' => 'boolean' ),
						),
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
		return WP_Codebox_Preview_Options::input_schema();
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
					'enum'        => array( 'ready', 'completed' ),
					'description' => 'Synchronous WP Codebox preparation/run status. Durable queued/running/cancelled/expired state belongs to the external orchestrator.',
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
				'execution_scope'  => array(
					'type'        => 'string',
					'enum'        => array( 'disposable-playground' ),
					'description' => 'Browser sessions run inside a disposable WordPress Playground sandbox, not the host site.',
				),
				'permission_model' => array(
					'type'        => 'string',
					'enum'        => array( 'sandbox-bypass' ),
					'description' => 'The generated browser runner bypasses agents/chat permission checks only inside the disposable Playground sandbox.',
				),
				'session'    => array( 'type' => 'object' ),
				'task_input' => self::task_input_schema(),
				'playground' => array( 'type' => 'object' ),
				'runtime'    => array( 'type' => 'object' ),
				'site_blueprint_artifact' => array( 'type' => 'object' ),
				'recipe'     => array( 'type' => 'object' ),
				'signals'    => array( 'type' => 'object' ),
				'artifacts'  => array( 'type' => 'object' ),
			),
		);
	}

	/** @return array<string,mixed> */
	private static function task_input_schema(): array {
		return WP_Codebox_Task_Input_Contract::schema();
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

		$playground = self::browser_playground( $input );
		if ( is_wp_error( $playground ) ) {
			return $playground;
		}

		$browser_runner  = is_array( $input['browser_runner'] ?? null ) ? $input['browser_runner'] : array();
		$legacy_plugins  = self::browser_plugins( $input );
		if ( is_wp_error( $legacy_plugins ) ) {
			return $legacy_plugins;
		}
		$runtime = self::browser_runtime_dependencies( $input, $legacy_plugins );
		if ( is_wp_error( $runtime ) ) {
			return $runtime;
		}
		$browser_plugins = $runtime['plugins'];

		$site_blueprint_artifact = self::browser_site_blueprint_artifact( $input );
		if ( is_wp_error( $site_blueprint_artifact ) ) {
			return $site_blueprint_artifact;
		}

		$base_blueprint = self::browser_blueprint_with_site_artifact( is_array( $input['blueprint'] ?? null ) ? $input['blueprint'] : array(), $site_blueprint_artifact );
		$blueprint      = self::browser_blueprint_with_runtime( $base_blueprint, $runtime, $playground );
		$artifacts      = self::browser_artifact_files( $input );
		if ( is_wp_error( $artifacts ) ) {
			return $artifacts;
		}
		$ready_to_code = self::browser_ready_to_code_signal( $input, $runtime );
		if ( false === ( $ready_to_code['emitted'] ?? false ) ) {
			return self::blocked_browser_playground_session( $session_id, $input, $task_input, $ready_to_code, $browser_plugins, $runtime, $artifacts, $playground, $blueprint, $site_blueprint_artifact );
		}

		$recipe = self::browser_agent_recipe( $task_input, $session_id, $browser_runner, $blueprint, $playground );
		if ( is_wp_error( $recipe ) ) {
			return $recipe;
		}

		return array(
			'success'          => true,
			'schema'           => 'wp-codebox/browser-playground-session/v1',
			'execution'        => 'browser-playground',
			'execution_scope'  => 'disposable-playground',
			'permission_model' => 'sandbox-bypass',
			'session'          => self::browser_session_envelope( $session_id, 'ready', $input ),
			'task'             => (string) $task_input['goal'],
			'task_input' => $task_input,
			'agent'      => (string) ( $input['agent'] ?? 'wp-codebox-sandbox' ),
			'plugins'    => $browser_plugins,
			'runtime'    => $runtime,
			'site_blueprint_artifact' => $site_blueprint_artifact,
			'playground' => array(
				'client_module_url'  => $playground['client_module_url'],
				'remote_url'         => $playground['remote_url'],
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
				'provenance'         => $playground['provenance'],
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

	/**
	 * @param array<string,mixed> $input Ability input.
	 * @param array<string,mixed> $task_input Normalized task input.
	 * @param array<string,mixed> $ready_to_code Readiness signal.
	 * @param array<int,array<string,string>> $browser_plugins Browser plugin specs.
	 * @param array<string,mixed> $runtime Normalized runtime dependency specs.
	 * @param array<int,array<string,string>> $artifacts Browser artifact specs.
	 * @param array<string,mixed> $playground Playground input.
	 * @param array<string,mixed> $blueprint Playground blueprint.
	 * @param array<string,mixed> $site_blueprint_artifact Normalized site blueprint artifact.
	 * @return array<string,mixed>
	 */
	private static function blocked_browser_playground_session( string $session_id, array $input, array $task_input, array $ready_to_code, array $browser_plugins, array $runtime, array $artifacts, array $playground, array $blueprint, array $site_blueprint_artifact ): array {
		return array(
			'success'          => false,
			'schema'           => 'wp-codebox/browser-playground-session/v1',
			'execution'        => 'browser-playground',
			'execution_scope'  => 'disposable-playground',
			'permission_model' => 'sandbox-bypass',
			'status'           => 'blocked',
			'error'            => array(
				'code'    => 'wp_codebox_browser_prerequisites_missing',
				'message' => 'Browser Playground sandbox is missing required coding prerequisites.',
				'missing' => $ready_to_code['missing'] ?? array(),
			),
			'session'          => self::browser_session_envelope( $session_id, 'blocked', $input ),
			'task'             => (string) $task_input['goal'],
			'task_input' => $task_input,
			'agent'      => (string) ( $input['agent'] ?? 'wp-codebox-sandbox' ),
			'plugins'    => $browser_plugins,
			'runtime'    => $runtime,
			'site_blueprint_artifact' => $site_blueprint_artifact,
			'playground' => array(
				'client_module_url'  => $playground['client_module_url'],
				'remote_url'         => $playground['remote_url'],
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
				'provenance'         => $playground['provenance'],
			),
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

	/** @return array<string,mixed> */
	private static function browser_session_envelope( string $session_id, string $status, array $input ): array {
		$session = WP_Codebox_Agent_Task::session( $session_id, $status, $input );
		$session['execution_scope']  = 'disposable-playground';
		$session['permission_model'] = 'sandbox-bypass';

		return $session;
	}

	/** @param array<string,mixed> $input Ability input. @param array<string,mixed> $runtime Normalized runtime dependency specs. @return array<string,mixed> */
	private static function browser_ready_to_code_signal( array $input, array $runtime ): array {
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
			'agents_api'        => self::agents_api_ready() && self::browser_runtime_has_plugin( $runtime, 'agents-api' ),
			'data_machine'      => self::browser_runtime_has_plugin( $runtime, 'data-machine' ),
			'data_machine_code' => self::browser_runtime_has_plugin( $runtime, 'data-machine-code' ),
			'provider_plugin'   => ! empty( $provider_plugin_paths ) && self::all_paths_ready( $provider_plugin_paths ),
			'provider_secret'   => ! empty( $connectors ) || ! empty( $secret_env ),
			'runtime_dependencies' => true,
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
			'requirement_metadata' => array(
				'runtime_dependencies' => self::browser_runtime_readiness_metadata( $runtime ),
			),
			'missing'      => $missing,
		);
	}

	private static function agents_api_ready(): bool {
		if ( ! function_exists( 'wp_get_ability' ) ) {
			return false;
		}

		return (bool) wp_get_ability( 'agents/chat' );
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

	/** @param array<string,mixed> $runtime Normalized runtime dependencies. */
	private static function browser_runtime_has_plugin( array $runtime, string $slug ): bool {
		foreach ( is_array( $runtime['plugins'] ?? null ) ? $runtime['plugins'] : array() as $plugin ) {
			if ( is_array( $plugin ) && $slug === self::safe_key( (string) ( $plugin['slug'] ?? '' ) ) ) {
				return true;
			}
		}

		return false;
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
		return WP_Codebox_Agent_Task::normalize_input( $input, fn( array $tools ): WP_Error|null => ( new WP_Codebox_Agent_Sandbox_Runner() )->validate_allowed_tools( $tools ), true );
	}

	/** @return string[] */
	private static function string_list( mixed $value ): array {
		return WP_Codebox_Agent_Task::string_list( $value );
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

	/** @param array<int,mixed> $mu_plugins Mu-plugin dependency specs. @return array<int,array<string,mixed>>|WP_Error */
	private static function normalize_browser_mu_plugins( array $mu_plugins ): array|WP_Error {
		$normalized = array();
		foreach ( $mu_plugins as $index => $mu_plugin ) {
			if ( ! is_array( $mu_plugin ) ) {
				return new WP_Error( 'wp_codebox_browser_mu_plugin_invalid', 'Each browser mu-plugin must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			$slug = self::safe_key( (string) ( $mu_plugin['slug'] ?? '' ) );
			$file = trim( (string) ( $mu_plugin['file'] ?? ( '' !== $slug ? $slug . '.php' : '' ) ) );
			if ( '' === $file || str_contains( $file, '..' ) || str_contains( $file, '/' ) || ! str_ends_with( $file, '.php' ) || ! preg_match( '#^[A-Za-z0-9_.-]+$#', $file ) ) {
				return new WP_Error( 'wp_codebox_browser_mu_plugin_file_invalid', 'Browser mu-plugin files must be safe PHP filenames.', array( 'status' => 400, 'index' => $index ) );
			}

			$content = (string) ( $mu_plugin['content'] ?? '' );
			if ( '' === trim( $content ) ) {
				return new WP_Error( 'wp_codebox_browser_mu_plugin_content_missing', 'Browser mu-plugin content is required.', array( 'status' => 400, 'index' => $index ) );
			}

			$normalized[] = array(
				'slug'            => '' !== $slug ? $slug : self::safe_key( basename( $file, '.php' ) ),
				'file'            => $file,
				'path'            => '/wordpress/wp-content/mu-plugins/' . $file,
				'content'         => $content,
				'readiness'       => 'compiled',
			);
		}

		return $normalized;
	}

	/** @param array<int,mixed> $themes Theme dependency specs. @return array<int,array<string,mixed>>|WP_Error */
	private static function normalize_browser_themes( array $themes ): array|WP_Error {
		$normalized = array();
		foreach ( $themes as $index => $theme ) {
			if ( ! is_array( $theme ) ) {
				return new WP_Error( 'wp_codebox_browser_theme_invalid', 'Each browser theme must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			$slug  = self::safe_key( (string) ( $theme['slug'] ?? '' ) );
			$url   = trim( (string) ( $theme['url'] ?? '' ) );
			$files = is_array( $theme['files'] ?? null ) ? $theme['files'] : array();
			if ( '' === $slug ) {
				return new WP_Error( 'wp_codebox_browser_theme_slug_missing', 'Browser theme slug is required.', array( 'status' => 400, 'index' => $index ) );
			}
			if ( '' === $url && empty( $files ) ) {
				return new WP_Error( 'wp_codebox_browser_theme_source_missing', 'Browser themes require a zip URL or files.', array( 'status' => 400, 'index' => $index ) );
			}

			$source = null;
			if ( '' !== $url ) {
				$source = self::browser_theme_url( $url, $index );
				if ( is_wp_error( $source ) ) {
					return $source;
				}
			}

			$normalized_files = self::normalize_browser_theme_files( $files, $slug, $index );
			if ( is_wp_error( $normalized_files ) ) {
				return $normalized_files;
			}

			$normalized[] = array_filter(
				array(
					'slug'       => $slug,
					'url'        => $source['url'] ?? '',
					'activate'   => ! array_key_exists( 'activate', $theme ) || (bool) $theme['activate'],
					'files'      => $normalized_files,
					'readiness'  => 'compiled',
					'provenance' => $source ? array_filter( array( 'schema' => 'wp-codebox/browser-theme-provenance/v1', 'url' => $source['url'], 'origin' => $source['origin'], 'host' => $source['host'] ) ) : array(),
				),
				static fn( mixed $value ): bool => array() !== $value && '' !== $value
			);
		}

		return $normalized;
	}

	/** @param array<int,mixed> $files Theme file specs. @return array<int,array<string,string>>|WP_Error */
	private static function normalize_browser_theme_files( array $files, string $slug, int $theme_index ): array|WP_Error {
		$normalized = array();
		foreach ( $files as $index => $file ) {
			if ( ! is_array( $file ) ) {
				return new WP_Error( 'wp_codebox_browser_theme_file_invalid', 'Each browser theme file must be an object.', array( 'status' => 400, 'theme_index' => $theme_index, 'index' => $index ) );
			}

			$path = trim( (string) ( $file['path'] ?? '' ) );
			if ( '' === $path || str_contains( $path, '..' ) || str_starts_with( $path, '/' ) || ! preg_match( '#^[A-Za-z0-9_./-]+$#', $path ) ) {
				return new WP_Error( 'wp_codebox_browser_theme_file_path_invalid', 'Browser theme file paths must be safe relative paths.', array( 'status' => 400, 'theme_index' => $theme_index, 'index' => $index ) );
			}

			$normalized[] = array(
				'path'            => $path,
				'playground_path' => '/wordpress/wp-content/themes/' . $slug . '/' . $path,
				'content'         => (string) ( $file['content'] ?? '' ),
			);
		}

		return $normalized;
	}

	/** @param array<int,mixed> $operations Bootstrap operation specs. @return array<int,array<string,mixed>>|WP_Error */
	private static function normalize_browser_bootstrap( array $operations ): array|WP_Error {
		$normalized = array();
		foreach ( $operations as $index => $operation ) {
			if ( ! is_array( $operation ) ) {
				return new WP_Error( 'wp_codebox_browser_bootstrap_invalid', 'Each browser bootstrap operation must be an object.', array( 'status' => 400, 'index' => $index ) );
			}

			$name = self::safe_key( (string) ( $operation['operation'] ?? $operation['name'] ?? '' ) );
			if ( ! in_array( $name, array( 'set_option', 'activate_plugin', 'activate_theme', 'flush_rewrite_rules' ), true ) ) {
				return new WP_Error( 'wp_codebox_browser_bootstrap_operation_invalid', 'Browser bootstrap operation is not supported.', array( 'status' => 400, 'index' => $index, 'operation' => $name ) );
			}

			$normalized[] = array(
				'operation' => $name,
				'args'      => is_array( $operation['args'] ?? null ) ? $operation['args'] : array_diff_key( $operation, array( 'operation' => true, 'name' => true ) ),
				'readiness' => 'compiled',
			);
		}

		return $normalized;
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private static function browser_playground( array $input ): array|WP_Error {
		$playground = is_array( $input['playground'] ?? null ) ? $input['playground'] : array();
		$client     = self::browser_trusted_url(
			(string) ( $playground['client_module_url'] ?? 'https://playground.automattic.ai/client/index.js' ),
			'client_module_url',
			'wp_codebox_browser_playground_allowed_origins',
			array( 'https://playground.automattic.ai' )
		);
		if ( is_wp_error( $client ) ) {
			return $client;
		}

		$remote = self::browser_trusted_url(
			(string) ( $playground['remote_url'] ?? 'https://playground.automattic.ai/remote.html' ),
			'remote_url',
			'wp_codebox_browser_playground_allowed_origins',
			array( 'https://playground.automattic.ai' )
		);
		if ( is_wp_error( $remote ) ) {
			return $remote;
		}

		$playground['client_module_url'] = $client['url'];
		$playground['remote_url']        = $remote['url'];
		$playground['provenance']        = array(
			'schema'            => 'wp-codebox/browser-playground-provenance/v1',
			'client_module_url' => $client,
			'remote_url'        => $remote,
		);

		return $playground;
	}

	/** @return array{url:string,origin:string,host:string} | WP_Error */
	private static function browser_trusted_url( string $url, string $field, string $filter, array $default_allowed_origins ): array|WP_Error {
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return new WP_Error( 'wp_codebox_browser_url_invalid', 'Browser Playground URL must be absolute.', array( 'status' => 400, 'field' => $field ) );
		}

		$scheme = strtolower( (string) $parts['scheme'] );
		if ( 'https' !== $scheme ) {
			return new WP_Error( 'wp_codebox_browser_url_insecure', 'Browser Playground URL must use https://.', array( 'status' => 400, 'field' => $field ) );
		}

		$origin  = self::url_origin( $parts );
		$allowed = self::normalized_origins( apply_filters( $filter, $default_allowed_origins, $field, $url ) );
		if ( ! in_array( $origin, $allowed, true ) ) {
			return new WP_Error( 'wp_codebox_browser_origin_not_allowed', 'Browser Playground URL origin is not allowed.', array( 'status' => 400, 'field' => $field, 'origin' => $origin ) );
		}

		return array(
			'url'    => $url,
			'origin' => $origin,
			'host'   => strtolower( (string) $parts['host'] ),
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<int,array<string,mixed>>|WP_Error */
	private static function browser_plugins( array $input ): array|WP_Error {
		$plugins = is_array( $input['browser_plugins'] ?? null ) ? $input['browser_plugins'] : array();
		return self::normalize_browser_plugins( $plugins, 'browser_plugins' );
	}

	/** @param array<string,mixed> $input Ability input. @param array<int,array<string,mixed>> $legacy_plugins Legacy browser_plugins specs. @return array<string,mixed>|WP_Error */
	private static function browser_runtime_dependencies( array $input, array $legacy_plugins ): array|WP_Error {
		$runtime = is_array( $input['runtime'] ?? null ) ? $input['runtime'] : array();
		$runtime_plugin_specs = self::browser_runtime_plugin_specs( is_array( $runtime['plugins'] ?? null ) ? $runtime['plugins'] : array() );
		if ( is_wp_error( $runtime_plugin_specs ) ) {
			return $runtime_plugin_specs;
		}

		$runtime_plugins = self::normalize_browser_plugins( $runtime_plugin_specs, 'runtime.plugins' );
		if ( is_wp_error( $runtime_plugins ) ) {
			return $runtime_plugins;
		}

		$mu_plugins = self::normalize_browser_mu_plugins( is_array( $runtime['mu_plugins'] ?? null ) ? $runtime['mu_plugins'] : array() );
		if ( is_wp_error( $mu_plugins ) ) {
			return $mu_plugins;
		}

		$themes = self::normalize_browser_themes( is_array( $runtime['themes'] ?? null ) ? $runtime['themes'] : array() );
		if ( is_wp_error( $themes ) ) {
			return $themes;
		}

		$bootstrap = self::normalize_browser_bootstrap( is_array( $runtime['bootstrap'] ?? null ) ? $runtime['bootstrap'] : array() );
		if ( is_wp_error( $bootstrap ) ) {
			return $bootstrap;
		}

		$component_plugins = self::browser_component_plugins( $input, array_merge( $legacy_plugins, $runtime_plugins ) );
		if ( is_wp_error( $component_plugins ) ) {
			return $component_plugins;
		}

		$plugins = self::dedupe_browser_plugins( array_merge( $legacy_plugins, $component_plugins, $runtime_plugins ) );

		return array(
			'schema'                 => 'wp-codebox/browser-runtime-dependencies/v1',
			'plugins'                => $plugins,
			'mu_plugins'             => $mu_plugins,
			'themes'                 => $themes,
			'bootstrap'              => $bootstrap,
			'component_plugins'      => count( $component_plugins ),
			'legacy_browser_plugins' => count( $legacy_plugins ),
			'summary'                => array(
				'plugins'    => count( $plugins ),
				'mu_plugins' => count( $mu_plugins ),
				'themes'     => count( $themes ),
				'bootstrap'  => count( $bootstrap ),
			),
		);
	}

	/** @param array<int,mixed> $plugins Runtime plugin specs. @return array<int,array<string,mixed>>|WP_Error */
	private static function browser_runtime_plugin_specs( array $plugins ): array|WP_Error {
		$resolved = array();

		foreach ( $plugins as $index => $plugin ) {
			if ( ! is_array( $plugin ) ) {
				return new WP_Error( 'wp_codebox_browser_plugin_invalid', 'Each browser plugin must be an object.', array( 'status' => 400, 'field' => 'runtime.plugins', 'index' => $index ) );
			}

			$resource = (string) ( $plugin['resource'] ?? 'url' );
			if ( 'server' === (string) ( $plugin['package'] ?? '' ) ) {
				$slug = self::safe_key( (string) ( $plugin['slug'] ?? '' ) );
				if ( '' === $slug ) {
					return new WP_Error( 'wp_codebox_browser_plugin_slug_missing', 'Server-packaged browser plugin specs require a slug.', array( 'status' => 400, 'field' => 'runtime.plugins', 'index' => $index ) );
				}

				$package = self::browser_package_remote_plugin( $slug, (string) ( $plugin['url'] ?? '' ), $index, (string) ( $plugin['sha256'] ?? '' ) );
				if ( is_wp_error( $package ) ) {
					return $package;
				}

				$resolved[] = array_merge(
					$plugin,
					array(
						'slug'          => $slug,
						'url'           => $package['url'],
						'sha256'        => $package['sha256'],
						'local_package' => true,
						'provenance'    => array(
							'schema' => 'wp-codebox/browser-plugin-provenance/v1',
							'source' => 'runtime-plugin-remote-package',
							'url'    => (string) ( $plugin['url'] ?? '' ),
						),
					)
				);
				continue;
			}

			$path = 'git:directory' === $resource ? '' : self::browser_clean_path( (string) ( $plugin['path'] ?? '' ) );
			if ( '' === $path ) {
				$resolved[] = $plugin;
				continue;
			}

			$slug = self::safe_key( (string) ( $plugin['slug'] ?? basename( $path ) ) );
			if ( '' === $slug ) {
				return new WP_Error( 'wp_codebox_browser_plugin_slug_missing', 'Browser plugin path specs require a slug.', array( 'status' => 400, 'field' => 'runtime.plugins', 'index' => $index ) );
			}

			if ( ! is_dir( $path ) ) {
				return new WP_Error( 'wp_codebox_browser_plugin_path_missing', 'Browser plugin path does not exist.', array( 'status' => 400, 'field' => 'runtime.plugins', 'index' => $index, 'slug' => $slug ) );
			}

			$package = self::browser_package_component_plugin( $slug, $path );
			if ( is_wp_error( $package ) ) {
				return $package;
			}

			$resolved[] = array_merge(
				$plugin,
				array(
					'slug'          => $slug,
					'url'           => $package['url'],
					'sha256'        => $package['sha256'],
					'local_package' => true,
					'provenance'    => array(
						'schema' => 'wp-codebox/browser-plugin-provenance/v1',
						'source' => 'runtime-plugin-path',
						'path'   => $path,
					),
				)
			);
		}

		return $resolved;
	}

	/** @param array<string,mixed> $input Ability input. @param array<int,array<string,mixed>> $declared_plugins Caller/runtime plugin specs. @return array<int,array<string,mixed>>|WP_Error */
	private static function browser_component_plugins( array $input, array $declared_plugins ): array|WP_Error {
		$paths = self::browser_component_paths( $input );
		$declared_slugs = array_values(
			array_filter(
				array_map( static fn( array $plugin ): string => self::safe_key( (string) ( $plugin['slug'] ?? '' ) ), $declared_plugins )
			)
		);

		$plugins = array();
		foreach (
			array(
				'agents_api'        => 'agents-api',
				'data_machine'      => 'data-machine',
				'data_machine_code' => 'data-machine-code',
			) as $key => $slug
		) {
			if ( in_array( $slug, $declared_slugs, true ) ) {
				continue;
			}

			$path = (string) ( $paths[ $key ] ?? '' );
			if ( '' === $path || ! is_dir( $path ) ) {
				continue;
			}

			$package = self::browser_package_component_plugin( $slug, $path );
			if ( is_wp_error( $package ) ) {
				return $package;
			}

			$plugins[] = array(
				'url'        => $package['url'],
				'slug'       => $slug,
				'activate'   => true,
				'provenance' => array(
					'schema'       => 'wp-codebox/browser-component-plugin-provenance/v1',
					'source'       => 'host-component-path',
					'sha256'       => $package['sha256'],
				),
			);
		}

		return $plugins;
	}

	/** @param array<string,mixed> $input Ability input. @return array{agents_api:string,data_machine:string,data_machine_code:string} */
	private static function browser_component_paths( array $input ): array {
		$configured = array_merge( self::browser_default_component_paths(), self::browser_configured_component_paths() );

		return array(
			'agents_api'        => self::browser_clean_path( (string) ( $input['agents_api_path'] ?? $configured['agents_api'] ?? '' ) ),
			'data_machine'      => self::browser_clean_path( (string) ( $input['data_machine_path'] ?? $configured['data_machine'] ?? '' ) ),
			'data_machine_code' => self::browser_clean_path( (string) ( $input['data_machine_code_path'] ?? $configured['data_machine_code'] ?? '' ) ),
		);
	}

	/** @return array{agents_api:string,data_machine:string,data_machine_code:string} */
	private static function browser_default_component_paths(): array {
		$paths = array(
			'agents_api'        => '',
			'data_machine'      => '',
			'data_machine_code' => '',
		);

		if ( ! defined( 'WP_PLUGIN_DIR' ) ) {
			return $paths;
		}

		$plugin_dir = self::browser_clean_path( (string) WP_PLUGIN_DIR );
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
	private static function browser_configured_component_paths(): array {
		$paths = array();
		if ( function_exists( 'is_multisite' ) && is_multisite() && function_exists( 'get_site_option' ) ) {
			$option = get_site_option( 'wp_codebox_component_paths', array() );
		} elseif ( function_exists( 'get_option' ) ) {
			$option = get_option( 'wp_codebox_component_paths', array() );
		} else {
			$option = array();
		}

		if ( is_array( $option ) ) {
			$paths = $option;
		}

		if ( function_exists( 'apply_filters' ) ) {
			$paths = apply_filters( 'wp_codebox_component_paths', $paths );
		}

		return is_array( $paths ) ? $paths : array();
	}

	private static function browser_clean_path( string $path ): string {
		$path = trim( $path );
		if ( '' === $path ) {
			return '';
		}

		$real = realpath( $path );
		return false !== $real ? $real : rtrim( $path, '/\\' );
	}

	/** @return array{url:string,path:string,sha256:string}|WP_Error */
	private static function browser_package_component_plugin( string $slug, string $source_path ): array|WP_Error {
		if ( ! class_exists( 'ZipArchive' ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_packager_missing', 'Browser runtime plugin packaging requires ZipArchive.', array( 'status' => 500, 'slug' => $slug ) );
		}

		$upload = function_exists( 'wp_upload_dir' ) ? wp_upload_dir() : array( 'basedir' => sys_get_temp_dir(), 'baseurl' => '' );
		if ( ! is_array( $upload ) || empty( $upload['basedir'] ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_upload_dir_missing', 'Browser runtime plugin packaging requires an upload directory.', array( 'status' => 500, 'slug' => $slug ) );
		}

		$base_dir = rtrim( (string) $upload['basedir'], '/\\' ) . DIRECTORY_SEPARATOR . 'wp-codebox' . DIRECTORY_SEPARATOR . 'browser-runtime-plugins';
		if ( ! is_dir( $base_dir ) && ! mkdir( $base_dir, 0777, true ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_package_dir_failed', 'Could not create browser runtime plugin package directory.', array( 'status' => 500, 'slug' => $slug ) );
		}

		$package_id = substr( hash( 'sha256', $slug . "\n" . $source_path . "\n" . self::browser_component_source_fingerprint( $source_path ) ), 0, 16 );
		$zip_path   = $base_dir . DIRECTORY_SEPARATOR . $slug . '-' . $package_id . '.zip';
		if ( ! is_file( $zip_path ) ) {
			$result = self::write_browser_plugin_zip( $slug, $source_path, $zip_path );
			if ( is_wp_error( $result ) ) {
				return $result;
			}
		}

		$base_url = is_array( $upload ) && ! empty( $upload['baseurl'] ) ? rtrim( (string) $upload['baseurl'], '/' ) : '';
		$url      = '' !== $base_url ? $base_url . '/wp-codebox/browser-runtime-plugins/' . rawurlencode( basename( $zip_path ) ) : '';
		if ( '' === $url ) {
			return new WP_Error( 'wp_codebox_browser_plugin_package_url_missing', 'Browser runtime plugin package URL is missing.', array( 'status' => 500, 'slug' => $slug ) );
		}

		$sha256 = hash_file( 'sha256', $zip_path );
		if ( ! is_string( $sha256 ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_package_hash_failed', 'Could not hash browser runtime plugin package.', array( 'status' => 500, 'slug' => $slug ) );
		}

		return array(
			'url'    => $url,
			'path'   => $zip_path,
			'sha256' => $sha256,
		);
	}

	/** @return array{url:string,path:string,sha256:string}|WP_Error */
	private static function browser_package_remote_plugin( string $slug, string $url, int $index, string $expected_sha256 = '' ): array|WP_Error {
		$source = self::browser_plugin_url( $url, $index );
		if ( is_wp_error( $source ) ) {
			return $source;
		}

		$expected_sha256 = strtolower( trim( $expected_sha256 ) );
		if ( '' !== $expected_sha256 && ! preg_match( '/^[a-f0-9]{64}$/', $expected_sha256 ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_sha256_invalid', 'Browser plugin sha256 must be a 64-character hex digest.', array( 'status' => 400, 'index' => $index ) );
		}

		$upload = function_exists( 'wp_upload_dir' ) ? wp_upload_dir() : array( 'basedir' => sys_get_temp_dir(), 'baseurl' => '' );
		if ( ! is_array( $upload ) || empty( $upload['basedir'] ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_upload_dir_missing', 'Browser runtime plugin packaging requires an upload directory.', array( 'status' => 500, 'slug' => $slug ) );
		}

		$base_dir = rtrim( (string) $upload['basedir'], '/\\' ) . DIRECTORY_SEPARATOR . 'wp-codebox' . DIRECTORY_SEPARATOR . 'browser-runtime-plugins';
		if ( ! is_dir( $base_dir ) && ! mkdir( $base_dir, 0777, true ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_package_dir_failed', 'Could not create browser runtime plugin package directory.', array( 'status' => 500, 'slug' => $slug ) );
		}

		$package_id = substr( hash( 'sha256', $slug . "\n" . $source['url'] . "\n" . $expected_sha256 ), 0, 16 );
		$zip_path   = $base_dir . DIRECTORY_SEPARATOR . $slug . '-' . $package_id . '.zip';
		if ( ! is_file( $zip_path ) ) {
			$downloaded = self::browser_download_remote_plugin( $source['url'], $zip_path, $slug );
			if ( is_wp_error( $downloaded ) ) {
				return $downloaded;
			}
		}

		$sha256 = hash_file( 'sha256', $zip_path );
		if ( ! is_string( $sha256 ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_package_hash_failed', 'Could not hash browser runtime plugin package.', array( 'status' => 500, 'slug' => $slug ) );
		}

		if ( '' !== $expected_sha256 && ! hash_equals( $expected_sha256, $sha256 ) ) {
			@unlink( $zip_path );
			return new WP_Error( 'wp_codebox_browser_plugin_package_hash_mismatch', 'Downloaded browser runtime plugin package does not match the expected sha256.', array( 'status' => 500, 'slug' => $slug ) );
		}

		$base_url = is_array( $upload ) && ! empty( $upload['baseurl'] ) ? rtrim( (string) $upload['baseurl'], '/' ) : '';
		$url      = '' !== $base_url ? $base_url . '/wp-codebox/browser-runtime-plugins/' . rawurlencode( basename( $zip_path ) ) : '';
		if ( '' === $url ) {
			return new WP_Error( 'wp_codebox_browser_plugin_package_url_missing', 'Browser runtime plugin package URL is missing.', array( 'status' => 500, 'slug' => $slug ) );
		}

		return array(
			'url'    => $url,
			'path'   => $zip_path,
			'sha256' => $sha256,
		);
	}

	private static function browser_download_remote_plugin( string $url, string $zip_path, string $slug ): true|WP_Error {
		$request = function_exists( 'wp_safe_remote_get' ) ? 'wp_safe_remote_get' : ( function_exists( 'wp_remote_get' ) ? 'wp_remote_get' : null );
		if ( null === $request ) {
			return new WP_Error( 'wp_codebox_browser_plugin_http_missing', 'Browser runtime plugin remote packaging requires the WordPress HTTP API.', array( 'status' => 500, 'slug' => $slug ) );
		}

		$response = $request(
			$url,
			array(
				'timeout'     => 60,
				'redirection' => 5,
			)
		);
		if ( is_wp_error( $response ) ) {
			return $response;
		}

		$code = function_exists( 'wp_remote_retrieve_response_code' ) ? (int) wp_remote_retrieve_response_code( $response ) : (int) ( $response['response']['code'] ?? 0 );
		if ( $code < 200 || $code >= 300 ) {
			return new WP_Error( 'wp_codebox_browser_plugin_download_failed', 'Could not download browser runtime plugin package.', array( 'status' => 502, 'slug' => $slug, 'http_status' => $code ) );
		}

		$body = function_exists( 'wp_remote_retrieve_body' ) ? (string) wp_remote_retrieve_body( $response ) : (string) ( $response['body'] ?? '' );
		if ( '' === $body ) {
			return new WP_Error( 'wp_codebox_browser_plugin_download_empty', 'Downloaded browser runtime plugin package is empty.', array( 'status' => 502, 'slug' => $slug ) );
		}

		if ( false === file_put_contents( $zip_path, $body ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_package_write_failed', 'Could not write browser runtime plugin package.', array( 'status' => 500, 'slug' => $slug ) );
		}

		return true;
	}

	private static function browser_component_source_fingerprint( string $source_path ): string {
		$source_path = rtrim( $source_path, '/\\' );
		$entries     = array();
		$iterator    = self::browser_component_file_iterator( $source_path );
		foreach ( $iterator as $file ) {
			if ( ! $file instanceof SplFileInfo || ! $file->isFile() ) {
				continue;
			}

			$path = $file->getPathname();
			$relative = ltrim( substr( $path, strlen( $source_path ) ), '/\\' );
			if ( '' === $relative ) {
				continue;
			}

			$entries[] = str_replace( DIRECTORY_SEPARATOR, '/', $relative ) . ':' . $file->getSize() . ':' . $file->getMTime();
		}

		sort( $entries, SORT_STRING );

		return hash( 'sha256', implode( "\n", $entries ) );
	}

	private static function write_browser_plugin_zip( string $slug, string $source_path, string $zip_path ): true|WP_Error {
		$zip = new ZipArchive();
		if ( true !== $zip->open( $zip_path, ZipArchive::CREATE | ZipArchive::OVERWRITE ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_zip_open_failed', 'Could not open browser runtime plugin package.', array( 'status' => 500, 'slug' => $slug ) );
		}

		$source_path = rtrim( $source_path, '/\\' );
		$iterator    = self::browser_component_file_iterator( $source_path );

		foreach ( $iterator as $file ) {
			if ( ! $file instanceof SplFileInfo || ! $file->isFile() ) {
				continue;
			}

			$path = $file->getPathname();
			$relative = ltrim( substr( $path, strlen( $source_path ) ), '/\\' );
			if ( '' === $relative ) {
				continue;
			}

			$zip->addFile( $path, $slug . '/' . str_replace( DIRECTORY_SEPARATOR, '/', $relative ) );
		}

		if ( true !== $zip->close() ) {
			return new WP_Error( 'wp_codebox_browser_plugin_zip_close_failed', 'Could not close browser runtime plugin package.', array( 'status' => 500, 'slug' => $slug ) );
		}

		return true;
	}

	private static function browser_component_file_iterator( string $source_path ): RecursiveIteratorIterator {
		return new RecursiveIteratorIterator(
			new RecursiveCallbackFilterIterator(
				new RecursiveDirectoryIterator( $source_path, FilesystemIterator::SKIP_DOTS ),
				static fn( SplFileInfo $file ): bool => ! in_array( $file->getFilename(), array( '.git', '.svn', '.hg', 'node_modules' ), true )
			)
		);
	}

	/** @param array<int,array<string,mixed>> $plugins Browser plugin specs. @return array<int,array<string,mixed>> */
	private static function dedupe_browser_plugins( array $plugins ): array {
		$deduped = array();
		$slugs   = array();
		foreach ( $plugins as $plugin ) {
			$slug = self::safe_key( (string) ( $plugin['slug'] ?? '' ) );
			if ( '' !== $slug ) {
				if ( isset( $slugs[ $slug ] ) ) {
					continue;
				}

				$slugs[ $slug ] = true;
			}

			$deduped[] = $plugin;
		}

		return $deduped;
	}

	/** @param array<int,mixed> $plugins Plugin dependency specs. @return array<int,array<string,mixed>>|WP_Error */
	private static function normalize_browser_plugins( array $plugins, string $field ): array|WP_Error {
		$normalized = array();

		foreach ( $plugins as $index => $plugin ) {
			if ( ! is_array( $plugin ) ) {
				return new WP_Error( 'wp_codebox_browser_plugin_invalid', 'Each browser plugin must be an object.', array( 'status' => 400, 'field' => $field, 'index' => $index ) );
			}

			$url      = trim( (string) ( $plugin['url'] ?? '' ) );
			$slug     = self::safe_key( (string) ( $plugin['slug'] ?? '' ) );
			$resource = (string) ( $plugin['resource'] ?? 'url' );
			if ( ! in_array( $resource, array( 'url', 'git:directory' ), true ) ) {
				return new WP_Error( 'wp_codebox_browser_plugin_resource_invalid', 'Browser plugin resource is not supported.', array( 'status' => 400, 'index' => $index, 'resource' => $resource ) );
			}

			$source = ! empty( $plugin['local_package'] ) ? self::browser_local_plugin_url( $url, $index ) : self::browser_plugin_url( $url, $index );
			if ( is_wp_error( $source ) ) {
				return $source;
			}

			$sha256 = strtolower( trim( (string) ( $plugin['sha256'] ?? '' ) ) );
			if ( '' !== $sha256 && ! preg_match( '/^[a-f0-9]{64}$/', $sha256 ) ) {
				return new WP_Error( 'wp_codebox_browser_plugin_sha256_invalid', 'Browser plugin sha256 must be a 64-character hex digest.', array( 'status' => 400, 'index' => $index ) );
			}

			$provenance = is_array( $plugin['provenance'] ?? null ) ? $plugin['provenance'] : array();

			$normalized[] = array(
				'url'              => $source['url'],
				'slug'             => $slug,
				'resource'         => $resource,
				'activate'         => ! array_key_exists( 'activate', $plugin ) || (bool) $plugin['activate'],
				'ref'              => sanitize_text_field( (string) ( $plugin['ref'] ?? '' ) ),
				'refType'          => sanitize_key( (string) ( $plugin['refType'] ?? '' ) ),
				'path'             => 'git:directory' === $resource ? ltrim( str_replace( '\\', '/', (string) ( $plugin['path'] ?? '' ) ), '/' ) : '',
				'targetFolderName' => sanitize_key( (string) ( $plugin['targetFolderName'] ?? '' ) ),
				'provenance'       => array_filter(
					array(
						'schema' => 'wp-codebox/browser-plugin-provenance/v1',
						'url'    => $source['url'],
						'origin' => $source['origin'],
						'host'   => $source['host'],
						'source' => is_string( $provenance['source'] ?? null ) ? $provenance['source'] : '',
						'sha256' => $sha256,
					)
				),
			);
		}

		return $normalized;
	}

	/** @return array{url:string,origin:string,host:string}|WP_Error */
	private static function browser_local_plugin_url( string $url, int $index ): array|WP_Error {
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_url_invalid', 'Browser plugin URL must be absolute.', array( 'status' => 400, 'index' => $index ) );
		}

		return array(
			'url'    => $url,
			'origin' => self::url_origin( $parts ),
			'host'   => strtolower( (string) $parts['host'] ),
		);
	}

	/** @return array{url:string,origin:string,host:string}|WP_Error */
	private static function browser_plugin_url( string $url, int $index ): array|WP_Error {
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_url_invalid', 'Browser plugin URL must be absolute.', array( 'status' => 400, 'index' => $index ) );
		}

		$scheme     = strtolower( (string) $parts['scheme'] );
		$host       = strtolower( (string) $parts['host'] );
		$allow_http = self::is_loopback_host( $host ) || (bool) apply_filters( 'wp_codebox_browser_plugin_allow_http', false, $url, $index );
		if ( 'https' !== $scheme && ! ( $allow_http && 'http' === $scheme ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_url_insecure', 'Browser plugin URL must use https://.', array( 'status' => 400, 'index' => $index ) );
		}

		$origin        = self::url_origin( $parts );
		$default_hosts = self::is_loopback_host( $host ) ? array( 'downloads.wordpress.org', $host ) : array( 'downloads.wordpress.org' );
		$allowed_hosts = array_map( 'strtolower', self::string_list( apply_filters( 'wp_codebox_browser_plugin_allowed_hosts', $default_hosts, $url, $index ) ) );
		if ( ! in_array( $host, $allowed_hosts, true ) ) {
			return new WP_Error( 'wp_codebox_browser_plugin_host_not_allowed', 'Browser plugin URL host is not allowed.', array( 'status' => 400, 'index' => $index, 'host' => $host ) );
		}

		return array( 'url' => $url, 'origin' => $origin, 'host' => $host );
	}

	/** @return array{url:string,origin:string,host:string}|WP_Error */
	private static function browser_theme_url( string $url, int $index ): array|WP_Error {
		$parts = wp_parse_url( $url );
		if ( ! is_array( $parts ) || empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			return new WP_Error( 'wp_codebox_browser_theme_url_invalid', 'Browser theme URL must be absolute.', array( 'status' => 400, 'index' => $index ) );
		}

		$scheme     = strtolower( (string) $parts['scheme'] );
		$host       = strtolower( (string) $parts['host'] );
		$allow_http = self::is_loopback_host( $host );
		if ( 'https' !== $scheme && ! ( $allow_http && 'http' === $scheme ) ) {
			return new WP_Error( 'wp_codebox_browser_theme_url_insecure', 'Browser theme URL must use https://.', array( 'status' => 400, 'index' => $index ) );
		}

		$origin        = self::url_origin( $parts );
		$default_hosts = self::is_loopback_host( $host ) ? array( 'downloads.wordpress.org', $host ) : array( 'downloads.wordpress.org' );
		$allowed_hosts = array_map( 'strtolower', self::string_list( apply_filters( 'wp_codebox_browser_theme_allowed_hosts', $default_hosts, $url, $index ) ) );
		if ( ! in_array( $host, $allowed_hosts, true ) ) {
			return new WP_Error( 'wp_codebox_browser_theme_host_not_allowed', 'Browser theme URL host is not allowed.', array( 'status' => 400, 'index' => $index, 'host' => $host ) );
		}

		return array( 'url' => $url, 'origin' => $origin, 'host' => $host );
	}

	/** @param array<string,string|int> $parts URL parts. */
	private static function url_origin( array $parts ): string {
		$scheme = strtolower( (string) ( $parts['scheme'] ?? '' ) );
		$host   = strtolower( (string) ( $parts['host'] ?? '' ) );
		$port   = isset( $parts['port'] ) ? ':' . (int) $parts['port'] : '';
		return $scheme . '://' . $host . $port;
	}

	private static function is_loopback_host( string $host ): bool {
		$host = strtolower( trim( $host, '[]' ) );
		return 'localhost' === $host || '127.0.0.1' === $host || '::1' === $host;
	}

	/** @return string[] */
	private static function normalized_origins( mixed $origins ): array {
		$normalized = array();
		foreach ( self::string_list( $origins ) as $origin ) {
			$parts = wp_parse_url( $origin );
			if ( is_array( $parts ) && ! empty( $parts['scheme'] ) && ! empty( $parts['host'] ) ) {
				$normalized[] = self::url_origin( $parts );
			}
		}
		return array_values( array_unique( $normalized ) );
	}

	private static function safe_key( string $value ): string {
		if ( function_exists( 'sanitize_key' ) ) {
			return sanitize_key( $value );
		}

		return strtolower( preg_replace( '/[^a-zA-Z0-9_-]/', '', $value ) ?? '' );
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private static function browser_site_blueprint_artifact( array $input ): array|WP_Error {
		$artifact = is_array( $input['site_blueprint_artifact'] ?? null ) ? $input['site_blueprint_artifact'] : array();
		if ( empty( $artifact ) ) {
			return array();
		}

		$blueprint = $artifact['blueprint'] ?? null;
		if ( ! is_array( $blueprint ) ) {
			return new WP_Error( 'wp_codebox_site_blueprint_artifact_invalid', 'site_blueprint_artifact.blueprint must be a Playground blueprint object.', array( 'status' => 400 ) );
		}

		return array(
			'schema'     => (string) ( $artifact['schema'] ?? 'wp-codebox/site-blueprint-artifact/v1' ),
			'id'         => (string) ( $artifact['id'] ?? '' ),
			'blueprint'  => $blueprint,
			'provenance' => is_array( $artifact['provenance'] ?? null ) ? $artifact['provenance'] : array(),
		);
	}

	/** @param array<string,mixed> $blueprint Blueprint override. @param array<string,mixed> $site_blueprint_artifact Normalized site blueprint artifact. @return array<string,mixed> */
	private static function browser_blueprint_with_site_artifact( array $blueprint, array $site_blueprint_artifact ): array {
		$site_blueprint = is_array( $site_blueprint_artifact['blueprint'] ?? null ) ? $site_blueprint_artifact['blueprint'] : array();
		if ( empty( $site_blueprint ) ) {
			return $blueprint;
		}

		$site_steps = is_array( $site_blueprint['steps'] ?? null ) ? $site_blueprint['steps'] : array();
		$base_steps = is_array( $blueprint['steps'] ?? null ) ? $blueprint['steps'] : array();
		$merged     = array_merge( $site_blueprint, $blueprint );
		$merged['steps'] = array_values( array_merge( $site_steps, $base_steps ) );

		if ( isset( $site_blueprint['features'] ) && isset( $blueprint['features'] ) && is_array( $site_blueprint['features'] ) && is_array( $blueprint['features'] ) ) {
			$merged['features'] = array_merge( $site_blueprint['features'], $blueprint['features'] );
		}

		return $merged;
	}

	/** @param array<string,mixed> $blueprint Blueprint override. @param array<string,mixed> $runtime Runtime dependency specs. @return array<string,mixed> */
	private static function browser_blueprint_with_runtime( array $blueprint, array $runtime, array $playground = array() ): array {
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

		foreach ( $runtime['plugins'] as $plugin ) {
			$plugin_data = array(
				'resource' => (string) ( $plugin['resource'] ?? 'url' ),
				'url'      => $plugin['url'],
			);

			if ( 'git:directory' === $plugin_data['resource'] ) {
				$plugin_data['ref']     = (string) ( $plugin['ref'] ?? 'main' );
				$plugin_data['refType'] = (string) ( $plugin['refType'] ?? 'branch' );
				if ( '' !== (string) ( $plugin['path'] ?? '' ) ) {
					$plugin_data['path'] = (string) $plugin['path'];
				}
			}

			$options = array(
				'activate' => (bool) $plugin['activate'],
			);
			if ( '' !== (string) ( $plugin['targetFolderName'] ?? '' ) ) {
				$options['targetFolderName'] = (string) $plugin['targetFolderName'];
			}

			$steps[] = array(
				'step'       => 'installPlugin',
				'pluginData' => $plugin_data,
				'options'    => $options,
			);
		}

		foreach ( $runtime['mu_plugins'] as $mu_plugin ) {
			$steps[] = array(
				'step' => 'runPHP',
				'code' => self::browser_mu_plugin_install_php( $mu_plugin ),
			);
		}

		foreach ( $runtime['themes'] as $theme ) {
			if ( ! empty( $theme['url'] ) ) {
				$steps[] = array(
					'step'      => 'installTheme',
					'themeData' => array(
						'resource' => 'url',
						'url'      => $theme['url'],
					),
					'options'   => array(
						'activate' => (bool) $theme['activate'],
					),
				);
			}

			if ( ! empty( $theme['files'] ) ) {
				$steps[] = array(
					'step' => 'runPHP',
					'code' => self::browser_theme_files_install_php( $theme ),
				);
			}
		}

		foreach ( $runtime['bootstrap'] as $operation ) {
			$steps[] = array(
				'step' => 'runPHP',
				'code' => self::browser_bootstrap_operation_php( $operation ),
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

	/** @param array<string,mixed> $mu_plugin Mu-plugin spec. */
	private static function browser_mu_plugin_install_php( array $mu_plugin ): string {
		return '<?php
$path = ' . var_export( $mu_plugin['path'], true ) . ';
$directory = dirname( $path );
if ( ! is_dir( $directory ) ) {
	mkdir( $directory, 0777, true );
}
file_put_contents( $path, ' . var_export( $mu_plugin['content'], true ) . ' );
';
	}

	/** @param array<string,mixed> $theme Theme spec. */
	private static function browser_theme_files_install_php( array $theme ): string {
		$files = array();
		foreach ( $theme['files'] as $file ) {
			$files[ $file['playground_path'] ] = $file['content'];
		}

		return '<?php
$files = ' . var_export( $files, true ) . ';
foreach ( $files as $path => $content ) {
	$directory = dirname( $path );
	if ( ! is_dir( $directory ) ) {
		mkdir( $directory, 0777, true );
	}
	file_put_contents( $path, $content );
}
' . ( (bool) $theme['activate'] ? self::browser_theme_activation_php( (string) $theme['slug'] ) : '' ) . '
';
	}

	private static function browser_theme_activation_php( string $slug ): string {
		return self::browser_wordpress_bootstrap_php() . '
if ( ! function_exists( \'switch_theme\' ) ) {
	require_once ABSPATH . WPINC . \'/theme.php\';
}
switch_theme( ' . var_export( $slug, true ) . ' );';
	}

	private static function browser_wordpress_bootstrap_php(): string {
		return 'if ( ! defined( \'ABSPATH\' ) ) {
	require_once \'/wordpress/wp-load.php\';
}';
	}

	/** @param array<string,mixed> $operation Bootstrap operation spec. */
	private static function browser_bootstrap_operation_php( array $operation ): string {
		$args = is_array( $operation['args'] ?? null ) ? $operation['args'] : array();
		switch ( $operation['operation'] ) {
			case 'set_option':
				return '<?php
' . self::browser_wordpress_bootstrap_php() . '
update_option( ' . var_export( (string) ( $args['name'] ?? $args['option'] ?? '' ), true ) . ', ' . var_export( $args['value'] ?? '', true ) . ' );
';
			case 'activate_plugin':
				return '<?php
' . self::browser_wordpress_bootstrap_php() . '
activate_plugin( ' . var_export( (string) ( $args['plugin'] ?? '' ), true ) . ' );
';
			case 'activate_theme':
				return '<?php
' . self::browser_theme_activation_php( (string) ( $args['slug'] ?? $args['theme'] ?? '' ) ) . '
';
			case 'flush_rewrite_rules':
				return '<?php
' . self::browser_wordpress_bootstrap_php() . '
flush_rewrite_rules();
';
		}

		return '<?php';
	}

	/** @param array<string,mixed> $runtime Runtime dependency specs. @return array<string,mixed> */
	private static function browser_runtime_readiness_metadata( array $runtime ): array {
		return array(
			'schema'    => 'wp-codebox/browser-runtime-readiness/v1',
			'compiled'  => true,
			'summary'   => $runtime['summary'] ?? array(),
			'plugins'   => array_map( static fn( array $plugin ): array => array( 'slug' => $plugin['slug'] ?? '', 'activate' => (bool) ( $plugin['activate'] ?? true ), 'readiness' => 'compiled' ), $runtime['plugins'] ?? array() ),
			'mu_plugins' => array_map( static fn( array $mu_plugin ): array => array( 'slug' => $mu_plugin['slug'] ?? '', 'file' => $mu_plugin['file'] ?? '', 'readiness' => $mu_plugin['readiness'] ?? 'compiled' ), $runtime['mu_plugins'] ?? array() ),
			'themes'    => array_map( static fn( array $theme ): array => array( 'slug' => $theme['slug'] ?? '', 'activate' => (bool) ( $theme['activate'] ?? true ), 'readiness' => $theme['readiness'] ?? 'compiled' ), $runtime['themes'] ?? array() ),
			'bootstrap' => array_map( static fn( array $operation ): array => array( 'operation' => $operation['operation'] ?? '', 'readiness' => $operation['readiness'] ?? 'compiled' ), $runtime['bootstrap'] ?? array() ),
		);
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
				'directory' => self::browser_artifact_base_path( $playground ),
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

$wp_codebox_playground_root = defined( \'ABSPATH\' ) ? wp_normalize_path( ABSPATH ) : \'\';
$wp_codebox_is_playground = \'Emscripten\' === PHP_OS_FAMILY && \'/wordpress/\' === $wp_codebox_playground_root;

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
if ( ! $wp_codebox_is_playground ) {
	$result = array(
		\'success\' => false,
		\'error\' => array(
			\'code\' => \'wp_codebox_browser_runner_not_playground\',
			\'message\' => \'The browser agent runner permission bypass is only allowed inside the disposable WordPress Playground sandbox.\',
			\'data\' => array(
				\'execution_scope\' => \'disposable-playground\',
				\'permission_model\' => \'sandbox-bypass\',
				\'detected_root\' => $wp_codebox_playground_root,
				\'detected_php_os_family\' => PHP_OS_FAMILY,
			),
		),
	);
} elseif ( ! $ability instanceof WP_Ability ) {
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
			\'execution_scope\' => \'disposable-playground\',
			\'permission_model\' => \'sandbox-bypass\',
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
