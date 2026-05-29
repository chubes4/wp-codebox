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

$plugin_bundle_root = sys_get_temp_dir() . '/wp-codebox-wordpress-plugin-bundle-' . getmypid();
if ( ! defined( 'WP_CODEBOX_PLUGIN_PATH' ) ) {
	define( 'WP_CODEBOX_PLUGIN_PATH', $plugin_bundle_root . '/wp-codebox/' );
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

if ( ! class_exists( 'WP_CLI' ) ) {
	class WP_CLI {
		public static function add_command( string $name, callable $callable ): void { $GLOBALS['wp_codebox_cli_commands'][ $name ] = $callable; }
		public static function line( string $message ): void { $GLOBALS['wp_codebox_cli_lines'][] = $message; }
		public static function warning( string $message ): void { $GLOBALS['wp_codebox_cli_warnings'][] = $message; }
		public static function error( string $message ): void { throw new RuntimeException( $message ); }
	}
}

if ( ! class_exists( 'WP_Post' ) ) {
	class WP_Post {
		public function __construct( public int $ID, public string $post_type, public string $post_status, public string $post_name, public string $post_title, public string $post_content = '', public string $post_excerpt = '', public string $post_mime_type = '' ) {}
	}
}

if ( ! class_exists( 'WP_Term' ) ) {
	class WP_Term {
		public function __construct( public int $term_id, public string $taxonomy, public string $slug, public string $name, public string $description = '' ) {}
	}
}

if ( ! class_exists( 'WP_User' ) ) {
	class WP_User {
		public function __construct( public int $ID, public string $display_name, public array $roles ) {}
	}
}

if ( ! function_exists( 'is_wp_error' ) ) {
	function is_wp_error( $thing ): bool { return $thing instanceof WP_Error; }
}

$GLOBALS['wp_codebox_registered_abilities']         = array();
$GLOBALS['wp_codebox_registered_ability_categories'] = array();
$GLOBALS['wp_codebox_actions']                      = array();
$GLOBALS['wp_codebox_current_action']              = null;
$GLOBALS['wp_codebox_filters']                      = array();
$GLOBALS['wp_codebox_mock_abilities']              = array();
$GLOBALS['wp_codebox_options']                      = array();
$GLOBALS['wp_codebox_site_options']                 = array();
$GLOBALS['wp_codebox_cli_commands']                 = array();
$GLOBALS['wp_codebox_cli_lines']                    = array();
$GLOBALS['wp_codebox_cli_warnings']                 = array();

function wp_register_ability( string $name, array $definition ): void {
	if ( isset( $definition['category'] ) && ! isset( $GLOBALS['wp_codebox_registered_ability_categories'][ $definition['category'] ] ) ) {
		return;
	}

	$GLOBALS['wp_codebox_registered_abilities'][ $name ] = $definition;
}

function wp_register_ability_category( string $slug, array $args ): void {
	if ( ! doing_action( 'wp_abilities_api_categories_init' ) ) {
		return;
	}

	$GLOBALS['wp_codebox_registered_ability_categories'][ $slug ] = $args;
}
function wp_get_ability( string $name ): mixed { return $GLOBALS['wp_codebox_mock_abilities'][ $name ] ?? null; }

function doing_action( string $hook ): bool {
	return $hook === $GLOBALS['wp_codebox_current_action'];
}
function add_action( string $hook, callable $callback, int $priority = 10 ): void {
	$GLOBALS['wp_codebox_actions'][ $hook ][ $priority ][] = $callback;
}
function do_action( string $hook ): void {
	$previous_action = $GLOBALS['wp_codebox_current_action'];
	$GLOBALS['wp_codebox_current_action'] = $hook;
	$callbacks = $GLOBALS['wp_codebox_actions'][ $hook ] ?? array();
	ksort( $callbacks );
	foreach ( $callbacks as $priority_callbacks ) {
		foreach ( $priority_callbacks as $callback ) {
			$callback();
		}
	}
	$GLOBALS['wp_codebox_current_action'] = $previous_action;
}
function add_filter( string $hook, callable $callback, int $priority = 10 ): void { $GLOBALS['wp_codebox_filters'][ $hook ] = $callback; }
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
function wp_parse_url( string $url ): array|false { return parse_url( $url ); }
function is_multisite(): bool { return (bool) ( $GLOBALS['wp_codebox_is_multisite'] ?? false ); }
function get_option( string $name, mixed $default = null ): mixed { return $GLOBALS['wp_codebox_options'][ $name ] ?? $default; }
function get_site_option( string $name, mixed $default = null ): mixed { return $GLOBALS['wp_codebox_site_options'][ $name ] ?? $default; }
function home_url( string $path = '' ): string { return 'https://parent.example.test' . $path; }
function wp_upload_dir(): array { return $GLOBALS['wp_codebox_upload_dir']; }
function sanitize_key( string $key ): string { return strtolower( preg_replace( '/[^a-zA-Z0-9_\-]/', '', $key ) ?? '' ); }
function sanitize_title( string $title ): string { return strtolower( preg_replace( '/[^a-zA-Z0-9_\-]/', '-', $title ) ?? '' ); }
function sanitize_text_field( string $text ): string { return trim( preg_replace( '/[\r\n\t]+/', ' ', $text ) ?? '' ); }
function absint( mixed $value ): int { return abs( (int) $value ); }
function get_stylesheet(): string { return 'twentytwentyfive'; }
function get_posts( array $args ): array {
	if ( 'attachment' === ( $args['post_type'] ?? '' ) ) {
		return array( new WP_Post( 5, 'attachment', 'inherit', 'seed-image', 'Seed Image', '', '', 'image/png' ) );
	}

	return array( new WP_Post( 7, 'page', 'publish', 'seed-page', 'Seed Page', '<!-- wp:paragraph --><p>Seeded</p><!-- /wp:paragraph -->' ) );
}
function get_terms( array $args ): array { return array( new WP_Term( 3, 'category', 'seed-category', 'Seed Category' ) ); }
function get_users( array $args ): array { return array( new WP_User( 11, 'Private User', array( 'editor' ) ) ); }

require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-task-input-contract.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-task.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-agent-sandbox-runner.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-artifacts.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-data-machine-pending-actions.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-preview-options.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-abilities.php';
require __DIR__ . '/../packages/wordpress-plugin/src/class-wp-codebox-cli-command.php';

$root = sys_get_temp_dir() . '/wp-codebox-wordpress-plugin-' . getmypid();
foreach ( array( 'agents-api', 'data-machine', 'data-machine-code', 'plugin-root/agents-api', 'ai-provider-test', 'editable-plugin', 'artifacts', 'artifact-network-root' ) as $dir ) {
	mkdir( $root . '/' . $dir, 0777, true );
}
$GLOBALS['wp_codebox_upload_dir'] = array(
	'basedir' => $root . '/uploads',
	'baseurl' => 'https://parent.example.test/uploads',
);
mkdir( $GLOBALS['wp_codebox_upload_dir']['basedir'], 0777, true );
foreach ( array( 'agents-api', 'data-machine', 'data-machine-code' ) as $component_slug ) {
	file_put_contents( $root . '/' . $component_slug . '/' . $component_slug . '.php', '<?php /* ' . $component_slug . ' */' );
}
file_put_contents( $root . '/wp-codebox.js', "#!/usr/bin/env node\n" );
mkdir( WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin', 0777, true );
mkdir( WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/vendor/node/bin', 0777, true );
file_put_contents( WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin/wp-codebox', "#!/usr/bin/env bash\n" );
file_put_contents( WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/vendor/node/bin/node', "#!/usr/bin/env bash\n" );
chmod( WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin/wp-codebox', 0755 );
chmod( WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/vendor/node/bin/node', 0755 );
if ( ! defined( 'WP_PLUGIN_DIR' ) ) {
	define( 'WP_PLUGIN_DIR', $root . '/plugin-root' );
}

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

$preview_fixture = json_decode( file_get_contents( __DIR__ . '/../contracts/preview-options.fixture.json' ), true );
$assert( 'preview option schema matches shared fixture', WP_Codebox_Preview_Options::input_schema() === $preview_fixture['options'] );
foreach ( $preview_fixture['cases'] as $preview_case ) {
	$normalized = WP_Codebox_Preview_Options::normalize( $preview_case['input'] );
	if ( $preview_case['valid'] ) {
		$assert( 'preview fixture valid: ' . $preview_case['name'], ! is_wp_error( $normalized ) && $normalized === $preview_case['normalized'] );
	} else {
		$assert( 'preview fixture invalid: ' . $preview_case['name'], is_wp_error( $normalized ) && $preview_case['code'] === $normalized->get_error_code() );
	}
}

$stable_json = function ( mixed $value ) use ( &$stable_json ): string {
	if ( ! is_array( $value ) ) {
		return json_encode( $value, JSON_UNESCAPED_SLASHES );
	}

	if ( array_is_list( $value ) ) {
		return '[' . implode( ',', array_map( $stable_json, $value ) ) . ']';
	}

	ksort( $value, SORT_STRING );
	$parts = array();
	foreach ( $value as $key => $item ) {
		$parts[] = json_encode( (string) $key, JSON_UNESCAPED_SLASHES ) . ':' . $stable_json( $item );
	}

	return '{' . implode( ',', $parts ) . '}';
};

$task_input_fixtures = json_decode( (string) file_get_contents( __DIR__ . '/fixtures/task-input-normalization.json' ), true );
$task_input_fixtures = is_array( $task_input_fixtures ) ? $task_input_fixtures : array();
$task_input_fixture_by_name = array();
foreach ( $task_input_fixtures as $fixture ) {
	if ( is_array( $fixture ) && isset( $fixture['name'] ) ) {
		$task_input_fixture_by_name[ (string) $fixture['name'] ] = $fixture;
	}
}

$manifest_self_hash = function ( array $manifest ) use ( $stable_json ): string {
	foreach ( $manifest['files'] as &$file ) {
		if ( 'manifest.json' === ( $file['path'] ?? '' ) ) {
			$file['sha256'] = array( 'algorithm' => 'sha256', 'value' => str_repeat( '0', 64 ) );
		}
	}
	unset( $file );

	return hash( 'sha256', "wp-codebox/artifact-manifest-self/v1\n" . $stable_json( $manifest ) );
};

$copy_directory = function ( string $source, string $destination ) use ( &$copy_directory ): void {
	mkdir( $destination, 0777, true );
	foreach ( scandir( $source ) ?: array() as $entry ) {
		if ( '.' === $entry || '..' === $entry ) {
			continue;
		}

		$source_path      = $source . '/' . $entry;
		$destination_path = $destination . '/' . $entry;
		if ( is_dir( $source_path ) ) {
			$copy_directory( $source_path, $destination_path );
			continue;
		}

		copy( $source_path, $destination_path );
	}
};

$refresh_manifest_hashes = function ( string $bundle_path ) use ( $manifest_self_hash ): void {
	$manifest_path = $bundle_path . '/manifest.json';
	$manifest      = json_decode( (string) file_get_contents( $manifest_path ), true );
	foreach ( $manifest['files'] as &$manifest_file ) {
		if ( 'manifest.json' !== $manifest_file['path'] ) {
			$manifest_file['sha256'] = array( 'algorithm' => 'sha256', 'value' => hash_file( 'sha256', $bundle_path . '/' . $manifest_file['path'] ) );
		}
	}
	unset( $manifest_file );
	foreach ( $manifest['files'] as &$manifest_file ) {
		if ( 'manifest.json' === $manifest_file['path'] ) {
			$manifest_file['sha256'] = array( 'algorithm' => 'sha256', 'value' => $manifest_self_hash( $manifest ) );
		}
	}
	unset( $manifest_file );
	file_put_contents( $manifest_path, json_encode( $manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" );
};

$violation_codes = static function ( WP_Error $error ): array {
	$data       = $error->get_error_data();
	$violations = is_array( $data['violations'] ?? null ) ? $data['violations'] : array();

	return array_values( array_filter( array_map( static fn( mixed $violation ): string => is_array( $violation ) ? (string) ( $violation['code'] ?? '' ) : '', $violations ) ) );
};

echo "WP Codebox WordPress plugin - smoke\n";

new WP_Codebox_Data_Machine_Pending_Actions();
new WP_Codebox_Abilities();
WP_Codebox_CLI_Command::register();

do_action( 'wp_abilities_api_init' );
$assert( 'ability registration waits for category registration', ! isset( $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/run-agent-task'] ) );

do_action( 'wp_abilities_api_categories_init' );
do_action( 'wp_abilities_api_init' );

$category = $GLOBALS['wp_codebox_registered_ability_categories']['wp-codebox'] ?? null;
$assert( 'wp-codebox ability category registered', is_array( $category ) );
$assert( 'category exposes label and description', isset( $category['label'] ) && isset( $category['description'] ) );

$cli_commands = $GLOBALS['wp_codebox_cli_commands'];
$assert( 'wp codebox artifacts list command registered', is_callable( $cli_commands['codebox artifacts list'] ?? null ) );
$assert( 'wp codebox artifacts get command registered', is_callable( $cli_commands['codebox artifacts get'] ?? null ) );
$assert( 'wp codebox artifacts stage-apply command registered', is_callable( $cli_commands['codebox artifacts stage-apply'] ?? null ) );
$assert( 'wp codebox artifacts apply command registered', is_callable( $cli_commands['codebox artifacts apply'] ?? null ) );
$assert( 'wp codebox browser-session create command registered', is_callable( $cli_commands['codebox browser-session create'] ?? null ) );
$assert( 'wp codebox run-agent-task command registered', is_callable( $cli_commands['codebox run-agent-task'] ?? null ) );

$ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/run-agent-task'] ?? null;
$assert( 'run-agent-task ability registered', is_array( $ability ) );
$assert( 'ability is REST visible', true === ( $ability['meta']['show_in_rest'] ?? false ) );
$assert( 'ability accepts goal or legacy task', array( 'goal' ) === ( $ability['input_schema']['anyOf'][0]['required'] ?? array() ) && array( 'task' ) === ( $ability['input_schema']['anyOf'][1]['required'] ?? array() ) );
$assert( 'ability exposes task target schema', isset( $ability['input_schema']['properties']['target']['properties']['kind'] ) );
$assert( 'ability exposes canonical task input metadata schema', 'wp-codebox/task-input/v1' === ( $ability['output_schema']['properties']['task_input']['properties']['schema']['const'] ?? '' ) && 1 === ( $ability['output_schema']['properties']['task_input']['properties']['version']['const'] ?? 0 ) );
$assert( 'ability exposes allowed tools schema', 'array' === ( $ability['input_schema']['properties']['allowed_tools']['type'] ?? '' ) );
$assert( 'ability exposes expected artifacts schema', 'array' === ( $ability['input_schema']['properties']['expected_artifacts']['type'] ?? '' ) );
$assert( 'ability exposes policy and context schema', 'object' === ( $ability['input_schema']['properties']['policy']['type'] ?? '' ) && 'object' === ( $ability['input_schema']['properties']['context']['type'] ?? '' ) );
$assert( 'ability exposes generic mounts schema', 'array' === ( $ability['input_schema']['properties']['mounts']['type'] ?? '' ) && 'object' === ( $ability['input_schema']['properties']['mounts']['items']['properties']['metadata']['type'] ?? '' ) );
$assert( 'ability exposes bounded parent-site seed schema', 'array' === ( $ability['input_schema']['properties']['site_seeds']['type'] ?? '' ) && array( 'parent_site' ) === ( $ability['input_schema']['properties']['site_seeds']['items']['properties']['type']['enum'] ?? array() ) );
$assert( 'ability exposes inheritance request schema', 'object' === ( $ability['input_schema']['properties']['inherit']['type'] ?? '' ) && 'array' === ( $ability['input_schema']['properties']['inherit']['properties']['connectors']['type'] ?? '' ) );
$assert( 'ability exposes connector credential envelope schema', 'object' === ( $ability['input_schema']['properties']['inherit']['properties']['credentials']['type'] ?? '' ) && 'array' === ( $ability['input_schema']['properties']['inherit']['properties']['credentials']['properties']['secrets']['type'] ?? '' ) );
$assert( 'ability exposes external sandbox session schema', 'string' === ( $ability['input_schema']['properties']['sandbox_session_id']['type'] ?? '' ) && 'object' === ( $ability['input_schema']['properties']['orchestrator']['type'] ?? '' ) && 'object' === ( $ability['output_schema']['properties']['session']['type'] ?? '' ) );
$assert( 'session schema pins external orchestrator persistence', array( 'external-orchestrator' ) === ( $ability['output_schema']['properties']['session']['properties']['persistence']['enum'] ?? array() ) && str_contains( $ability['output_schema']['properties']['session']['properties']['persistence']['description'] ?? '', 'does not persist' ) );
$assert( 'session schema keeps durable lifecycle external', array( 'ready', 'completed' ) === ( $ability['output_schema']['properties']['session']['properties']['status']['enum'] ?? array() ) && str_contains( $ability['output_schema']['properties']['session']['properties']['status']['description'] ?? '', 'external orchestrator' ) );
$assert( 'ability exposes preview configuration schema', 'integer' === ( $ability['input_schema']['properties']['preview_port']['type'] ?? '' ) && 'string' === ( $ability['input_schema']['properties']['preview_bind']['type'] ?? '' ) && 'string' === ( $ability['input_schema']['properties']['preview_public_url']['type'] ?? '' ) );
$assert( 'ability exposes strict remediation outcome schema', isset( $ability['output_schema']['properties']['outcome']['properties']['kind']['enum'] ) && in_array( 'provider_error', $ability['output_schema']['properties']['outcome']['properties']['kind']['enum'], true ) );
$assert( 'ability omits raw code input', ! isset( $ability['input_schema']['properties']['code'] ) && ! isset( $ability['input_schema']['properties']['code_file'] ) );
$assert( 'permission defaults to manage_options', true === call_user_func( $ability['permission_callback'] ) );

$batch_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/run-agent-task-batch'] ?? null;
$assert( 'run-agent-task-batch ability registered', is_array( $batch_ability ) );
$assert( 'batch ability is REST visible', true === ( $batch_ability['meta']['show_in_rest'] ?? false ) );
$assert( 'batch ability requires tasks', array( 'tasks' ) === ( $batch_ability['input_schema']['required'] ?? array() ) );
$assert( 'batch ability exposes preview configuration schema', 'integer' === ( $batch_ability['input_schema']['properties']['preview_port']['type'] ?? '' ) && 'string' === ( $batch_ability['input_schema']['properties']['preview_bind']['type'] ?? '' ) && 'string' === ( $batch_ability['input_schema']['properties']['preview_public_url']['type'] ?? '' ) );
$assert( 'batch ability contract does not expose unimplemented concurrency', ! isset( $batch_ability['input_schema']['properties']['concurrency'] ) && ! isset( $batch_ability['output_schema']['properties']['concurrency'] ) );
$assert( 'batch ability exposes per-task run outputs', isset( $batch_ability['output_schema']['properties']['runs']['items']['properties']['artifact_id'] ) && isset( $batch_ability['output_schema']['properties']['runs']['items']['properties']['preview_url'] ) && isset( $batch_ability['output_schema']['properties']['runs']['items']['properties']['error'] ) );

$browser_session_ability = $GLOBALS['wp_codebox_registered_abilities']['wp-codebox/create-browser-playground-session'] ?? null;
$assert( 'browser Playground session ability registered', is_array( $browser_session_ability ) );
$assert( 'browser Playground session ability is REST visible', true === ( $browser_session_ability['meta']['show_in_rest'] ?? false ) );
$assert( 'browser Playground session accepts goal or legacy task', array( 'goal' ) === ( $browser_session_ability['input_schema']['anyOf'][0]['required'] ?? array() ) && array( 'task' ) === ( $browser_session_ability['input_schema']['anyOf'][1]['required'] ?? array() ) );
$assert( 'browser Playground session exposes artifact file schema', 'array' === ( $browser_session_ability['input_schema']['properties']['artifact_files']['type'] ?? '' ) );
$assert( 'browser Playground session exposes site blueprint artifact schema', 'object' === ( $browser_session_ability['input_schema']['properties']['site_blueprint_artifact']['type'] ?? '' ) && 'object' === ( $browser_session_ability['input_schema']['properties']['site_blueprint_artifact']['properties']['blueprint']['type'] ?? '' ) );
$assert( 'browser Playground session declares site blueprint artifact output', 'object' === ( $browser_session_ability['output_schema']['properties']['site_blueprint_artifact']['type'] ?? '' ) );
$assert( 'browser Playground session output declares browser execution', array( 'browser-playground' ) === ( $browser_session_ability['output_schema']['properties']['execution']['enum'] ?? array() ) );

$artifact_abilities = array(
	'wp-codebox/list-artifacts',
	'wp-codebox/get-artifact',
	'wp-codebox/discard-artifact',
	'wp-codebox/apply-approved-artifact',
	'wp-codebox/stage-artifact-apply',
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
$GLOBALS['wp_codebox_filters']['wp_codebox_browser_plugin_allowed_hosts'] = array( 'example.test', 'downloads.wordpress.org' );
$GLOBALS['wp_codebox_filters']['wp_codebox_browser_theme_allowed_hosts'] = array( 'example.test', 'downloads.wordpress.org' );
$GLOBALS['wp_codebox_mock_abilities']['agents/chat'] = new WP_Ability();
mkdir( $root . '/plugin-root/data-machine', 0777, true );
mkdir( $root . '/plugin-root/data-machine-code', 0777, true );

$browser_session = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                  => 'Prepare a browser Playground preview.',
		'sandbox_session_id'    => 'browser-session-123',
		'target'                => array( 'kind' => 'static-site' ),
		'allowed_tools'         => array( 'filesystem-write', 'filesystem-write', '' ),
		'expected_artifacts'    => array( 'static-site' ),
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
		'inherit'               => array( 'connectors' => array( 'openai' ) ),
		'orchestrator'          => array( 'id' => 'example-orchestrator' ),
		'browser_plugins'       => array(
			array(
				'slug'   => 'agents-api',
				'url'    => 'https://example.test/agents-api.zip',
				'sha256' => str_repeat( 'a', 64 ),
			),
		),
		'runtime'               => array(
			'plugins'    => array(
				array(
					'slug'     => 'static-site-importer',
					'url'      => 'https://example.test/static-site-importer.zip',
					'activate' => false,
				),
			),
			'mu_plugins' => array(
				array(
					'slug'    => 'example-review',
					'file'    => 'example-review.php',
					'content' => '<?php add_filter( "wp_codebox_review", "__return_true" );',
				),
			),
			'themes'     => array(
				array(
					'slug'     => 'example-starter',
					'activate' => true,
					'files'    => array(
						array(
							'path'    => 'style.css',
							'content' => '/* Theme Name: Example Starter */',
						),
					),
				),
			),
			'bootstrap'  => array(
				array(
					'operation' => 'set_option',
					'args'      => array(
						'name'  => 'blogname',
						'value' => 'Browser Preview',
					),
				),
			),
		),
		'artifact_files'        => array(
			array(
				'path'    => 'static-site/index.html',
				'content' => '<main>Preview</main>',
				'kind'    => 'static-html',
			),
		),
	)
);
$assert( 'browser Playground session returns without shelling out', ! is_wp_error( $browser_session ) && true === ( $browser_session['success'] ?? false ) );
$assert( 'browser Playground session schema is stable', ! is_wp_error( $browser_session ) && 'wp-codebox/browser-playground-session/v1' === ( $browser_session['schema'] ?? '' ) );
$assert( 'browser Playground session pins browser execution', ! is_wp_error( $browser_session ) && 'browser-playground' === ( $browser_session['execution'] ?? '' ) );
$assert( 'browser Playground session identifies disposable execution scope', ! is_wp_error( $browser_session ) && 'disposable-playground' === ( $browser_session['execution_scope'] ?? '' ) && 'disposable-playground' === ( $browser_session['session']['execution_scope'] ?? '' ) );
$assert( 'browser Playground session identifies sandbox permission model', ! is_wp_error( $browser_session ) && 'sandbox-bypass' === ( $browser_session['permission_model'] ?? '' ) && 'sandbox-bypass' === ( $browser_session['session']['permission_model'] ?? '' ) );
$assert( 'browser Playground session emits canonical sandbox session envelope', ! is_wp_error( $browser_session ) && 'wp-codebox/sandbox-session/v1' === ( $browser_session['session']['schema'] ?? '' ) && 'browser-session-123' === ( $browser_session['session']['id'] ?? '' ) && 'ready' === ( $browser_session['session']['status'] ?? '' ) && 'external-orchestrator' === ( $browser_session['session']['persistence'] ?? '' ) );
$assert( 'browser Playground session includes Playground client URLs', ! is_wp_error( $browser_session ) && str_contains( $browser_session['playground']['client_module_url'] ?? '', 'playground.automattic.ai' ) && str_contains( $browser_session['playground']['remote_url'] ?? '', 'playground.automattic.ai' ) );
$assert( 'browser Playground session includes default blueprint', ! is_wp_error( $browser_session ) && true === ( $browser_session['playground']['blueprint']['features']['networking'] ?? false ) && is_array( $browser_session['playground']['blueprint']['steps'] ?? null ) );
$assert( 'browser Playground session defaults to latest WordPress and PHP', ! is_wp_error( $browser_session ) && 'latest' === ( $browser_session['playground']['blueprint']['preferredVersions']['wp'] ?? '' ) && 'latest' === ( $browser_session['playground']['blueprint']['preferredVersions']['php'] ?? '' ) );
$assert( 'browser Playground session logs in before admin workflows', ! is_wp_error( $browser_session ) && 'login' === ( $browser_session['playground']['blueprint']['steps'][0]['step'] ?? '' ) && 'admin' === ( $browser_session['playground']['blueprint']['steps'][0]['username'] ?? '' ) );
$assert( 'browser Playground session installs caller browser plugins without duplicating packaged components', ! is_wp_error( $browser_session ) && 'installPlugin' === ( $browser_session['playground']['blueprint']['steps'][1]['step'] ?? '' ) && 'https://example.test/agents-api.zip' === ( $browser_session['playground']['blueprint']['steps'][1]['pluginData']['url'] ?? '' ) && 1 === count( array_filter( $browser_session['plugins'], static fn( array $plugin ): bool => 'agents-api' === ( $plugin['slug'] ?? '' ) ) ) );
$assert( 'browser Playground session packages required host runtime plugins', ! is_wp_error( $browser_session ) && str_starts_with( (string) ( $browser_session['plugins'][1]['url'] ?? '' ), 'https://parent.example.test/uploads/wp-codebox/browser-runtime-plugins/data-machine-' ) && str_starts_with( (string) ( $browser_session['plugins'][2]['url'] ?? '' ), 'https://parent.example.test/uploads/wp-codebox/browser-runtime-plugins/data-machine-code-' ) && 64 === strlen( (string) ( $browser_session['plugins'][1]['provenance']['sha256'] ?? '' ) ) );
$assert( 'browser Playground session accepts structured runtime dependencies', ! is_wp_error( $browser_session ) && 'wp-codebox/browser-runtime-dependencies/v1' === ( $browser_session['runtime']['schema'] ?? '' ) && 4 === ( $browser_session['runtime']['summary']['plugins'] ?? 0 ) && 2 === ( $browser_session['runtime']['component_plugins'] ?? 0 ) && 1 === ( $browser_session['runtime']['summary']['mu_plugins'] ?? 0 ) && 1 === ( $browser_session['runtime']['summary']['themes'] ?? 0 ) && 1 === ( $browser_session['runtime']['summary']['bootstrap'] ?? 0 ) );
$assert( 'browser Playground session compiles structured runtime plugins after required components', ! is_wp_error( $browser_session ) && 'installPlugin' === ( $browser_session['playground']['blueprint']['steps'][4]['step'] ?? '' ) && 'https://example.test/static-site-importer.zip' === ( $browser_session['playground']['blueprint']['steps'][4]['pluginData']['url'] ?? '' ) && false === ( $browser_session['playground']['blueprint']['steps'][4]['options']['activate'] ?? true ) );
$assert( 'browser Playground session compiles mu-plugin runtime dependency', ! is_wp_error( $browser_session ) && 'runPHP' === ( $browser_session['playground']['blueprint']['steps'][5]['step'] ?? '' ) && str_contains( (string) ( $browser_session['playground']['blueprint']['steps'][5]['code'] ?? '' ), '/wordpress/wp-content/mu-plugins/example-review.php' ) );
$assert( 'browser Playground session compiles theme runtime dependency', ! is_wp_error( $browser_session ) && 'runPHP' === ( $browser_session['playground']['blueprint']['steps'][6]['step'] ?? '' ) && str_contains( (string) ( $browser_session['playground']['blueprint']['steps'][6]['code'] ?? '' ), '/wordpress/wp-content/themes/example-starter/style.css' ) && str_contains( (string) ( $browser_session['playground']['blueprint']['steps'][6]['code'] ?? '' ), "require_once '/wordpress/wp-load.php'" ) && str_contains( (string) ( $browser_session['playground']['blueprint']['steps'][6]['code'] ?? '' ), "require_once ABSPATH . WPINC . '/theme.php'" ) && str_contains( (string) ( $browser_session['playground']['blueprint']['steps'][6]['code'] ?? '' ), "switch_theme( 'example-starter' )" ) );
$assert( 'browser Playground session compiles named bootstrap runtime operation', ! is_wp_error( $browser_session ) && 'runPHP' === ( $browser_session['playground']['blueprint']['steps'][7]['step'] ?? '' ) && str_contains( (string) ( $browser_session['playground']['blueprint']['steps'][7]['code'] ?? '' ), "require_once '/wordpress/wp-load.php'" ) && str_contains( (string) ( $browser_session['playground']['blueprint']['steps'][7]['code'] ?? '' ), "update_option( 'blogname', 'Browser Preview' )" ) );
$assert( 'browser Playground session records trusted origins', ! is_wp_error( $browser_session ) && 'https://playground.automattic.ai' === ( $browser_session['playground']['provenance']['client_module_url']['origin'] ?? '' ) );
$assert( 'browser Playground session records browser plugin provenance', ! is_wp_error( $browser_session ) && 'example.test' === ( $browser_session['plugins'][0]['provenance']['host'] ?? '' ) && str_repeat( 'a', 64 ) === ( $browser_session['plugins'][0]['provenance']['sha256'] ?? '' ) );
$assert( 'browser Playground session includes recipe', ! is_wp_error( $browser_session ) && 'wp-codebox/workspace-recipe/v1' === ( $browser_session['recipe']['schema'] ?? '' ) );
$assert( 'browser Playground recipe uses generic artifact directory', ! is_wp_error( $browser_session ) && '/wordpress/wp-content/uploads/wp-codebox/artifacts' === ( $browser_session['recipe']['artifacts']['directory'] ?? '' ) );
$assert( 'browser Playground recipe calls agents/chat inside site', ! is_wp_error( $browser_session ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), "wp_get_ability( 'agents/chat' )" ) );
$assert( 'browser Playground recipe guards permission bypass to Playground', ! is_wp_error( $browser_session ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), "'Emscripten' === PHP_OS_FAMILY" ) && str_contains( (string) ( $browser_session['recipe']['workflow']['steps'][0]['args'][0] ?? '' ), 'wp_codebox_browser_runner_not_playground' ) );
$assert( 'browser Playground session emits ready-to-code signal only when blueprint prerequisites are present', ! is_wp_error( $browser_session ) && true === ( $browser_session['signals']['ready_to_code']['emitted'] ?? false ) && 'ready_to_code' === ( $browser_session['signals']['ready_to_code']['name'] ?? '' ) && true === ( $browser_session['signals']['ready_to_code']['requirements']['agents_api'] ?? false ) && true === ( $browser_session['signals']['ready_to_code']['requirements']['data_machine'] ?? false ) && true === ( $browser_session['signals']['ready_to_code']['requirements']['data_machine_code'] ?? false ) && true === ( $browser_session['signals']['ready_to_code']['requirements']['provider_secret'] ?? false ) && true === ( $browser_session['signals']['ready_to_code']['requirements']['runtime_dependencies'] ?? false ) );
$assert( 'browser Playground session exposes runtime dependency readiness metadata', ! is_wp_error( $browser_session ) && 'wp-codebox/browser-runtime-readiness/v1' === ( $browser_session['signals']['ready_to_code']['requirement_metadata']['runtime_dependencies']['schema'] ?? '' ) && 'example-review' === ( $browser_session['signals']['ready_to_code']['requirement_metadata']['runtime_dependencies']['mu_plugins'][0]['slug'] ?? '' ) && 'example-starter' === ( $browser_session['signals']['ready_to_code']['requirement_metadata']['runtime_dependencies']['themes'][0]['slug'] ?? '' ) );
$assert( 'browser Playground session preserves safe artifact files', ! is_wp_error( $browser_session ) && 'static-site/index.html' === ( $browser_session['artifacts']['files'][0]['path'] ?? '' ) );
$assert( 'browser Playground session exposes artifact write paths', ! is_wp_error( $browser_session ) && '/wordpress/wp-content/uploads/wp-codebox/artifacts/static-site/index.html' === ( $browser_session['artifacts']['files'][0]['playground_path'] ?? '' ) );
$assert( 'browser Playground session exposes artifact URL paths', ! is_wp_error( $browser_session ) && '/wp-content/uploads/wp-codebox/artifacts/static-site/index.html' === ( $browser_session['artifacts']['files'][0]['url_path'] ?? '' ) );
$assert( 'browser Playground session exposes preview URL', ! is_wp_error( $browser_session ) && '/wp-content/uploads/wp-codebox/artifacts/static-site/index.html' === ( $browser_session['playground']['preview_url'] ?? '' ) && '/wp-content/uploads/wp-codebox/artifacts/static-site/index.html' === ( $browser_session['artifacts']['preview_url'] ?? '' ) );
$assert( 'browser Playground session normalizes task input lists', ! is_wp_error( $browser_session ) && array( 'filesystem-write' ) === ( $browser_session['task_input']['allowed_tools'] ?? array() ) );
$assert( 'browser Playground session returns canonical task input metadata', ! is_wp_error( $browser_session ) && 'wp-codebox/task-input/v1' === ( $browser_session['task_input']['schema'] ?? '' ) && 1 === ( $browser_session['task_input']['version'] ?? 0 ) );
$assert( 'browser Playground session exposes canonical task string', ! is_wp_error( $browser_session ) && 'Prepare a browser Playground preview.' === ( $browser_session['task'] ?? '' ) );

$browser_site_blueprint_session = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                    => 'Prepare a pulled live-site copy.',
		'provider_plugin_paths'   => array( $root . '/ai-provider-test' ),
		'inherit'                 => array( 'connectors' => array( 'openai' ) ),
		'site_blueprint_artifact' => array(
			'schema'     => 'wp-codebox/site-blueprint-artifact/v1',
			'id'         => 'wpcom-site-123-backup-456',
			'blueprint'  => array(
				'features' => array( 'networking' => true ),
				'steps'    => array(
					array(
						'step' => 'runPHP',
						'code' => '<?php update_option( "blogname", "Pulled Site" );',
					),
				),
			),
			'provenance' => array(
				'provider'       => 'wpcom-sync',
				'remote_site_id' => 123,
			),
		),
	)
);
$assert( 'browser Playground session compiles site blueprint artifact before agent runtime', ! is_wp_error( $browser_site_blueprint_session ) && true === ( $browser_site_blueprint_session['success'] ?? false ) && 'runPHP' === ( $browser_site_blueprint_session['playground']['blueprint']['steps'][1]['step'] ?? '' ) && str_contains( (string) ( $browser_site_blueprint_session['playground']['blueprint']['steps'][1]['code'] ?? '' ), 'Pulled Site' ) );
$assert( 'browser Playground session echoes site blueprint artifact provenance', ! is_wp_error( $browser_site_blueprint_session ) && 'wpcom-site-123-backup-456' === ( $browser_site_blueprint_session['site_blueprint_artifact']['id'] ?? '' ) && 'wpcom-sync' === ( $browser_site_blueprint_session['site_blueprint_artifact']['provenance']['provider'] ?? '' ) );

$browser_invalid_site_blueprint = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                    => 'Prepare an invalid pulled site copy.',
		'site_blueprint_artifact' => array( 'id' => 'missing-blueprint' ),
	)
);
$assert( 'browser Playground session rejects malformed site blueprint artifacts', is_wp_error( $browser_invalid_site_blueprint ) && 'wp_codebox_site_blueprint_artifact_invalid' === $browser_invalid_site_blueprint->get_error_code() );

$browser_parent_only_tool = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                  => 'Prepare a browser preview with a parent-only tool.',
		'allowed_tools'         => array( 'datamachine/workspace-git-push' ),
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
		'inherit'               => array( 'connectors' => array( 'openai' ) ),
	)
);
$assert( 'browser Playground session rejects parent-only Data Machine tools before recipe emission', is_wp_error( $browser_parent_only_tool ) && 'wp_codebox_tool_not_allowed' === $browser_parent_only_tool->get_error_code() );

$GLOBALS['wp_codebox_filters']['wp_codebox_allowed_sandbox_tools'] = array( 'datamachine/workspace-read' );
$browser_not_allowlisted_tool = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                  => 'Prepare a browser preview with an unconfigured tool.',
		'allowed_tools'         => array( 'datamachine/workspace-write' ),
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
		'inherit'               => array( 'connectors' => array( 'openai' ) ),
	)
);
$assert( 'browser Playground session rejects tools outside configured allow-list before recipe emission', is_wp_error( $browser_not_allowlisted_tool ) && 'wp_codebox_tool_not_allowed' === $browser_not_allowlisted_tool->get_error_code() && 'not-allowlisted' === ( $browser_not_allowlisted_tool->get_error_data()['denied_tools'][0]['reason'] ?? '' ) );
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_allowed_sandbox_tools'] );

$browser_insecure_plugin_url = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'            => 'Prepare a browser preview with an insecure plugin URL.',
		'browser_plugins' => array( array( 'url' => 'http://example.test/plugin.zip' ) ),
	)
);
$assert( 'browser Playground session rejects insecure browser plugin URLs', is_wp_error( $browser_insecure_plugin_url ) && 'wp_codebox_browser_plugin_url_insecure' === $browser_insecure_plugin_url->get_error_code() );

$browser_untrusted_plugin_host = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'            => 'Prepare a browser preview with an untrusted plugin host.',
		'browser_plugins' => array( array( 'url' => 'https://evil.example/plugin.zip' ) ),
	)
);
$assert( 'browser Playground session rejects untrusted browser plugin hosts', is_wp_error( $browser_untrusted_plugin_host ) && 'wp_codebox_browser_plugin_host_not_allowed' === $browser_untrusted_plugin_host->get_error_code() );

$browser_untrusted_playground_origin = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'       => 'Prepare a browser preview with an untrusted Playground client.',
		'playground' => array( 'client_module_url' => 'https://evil.example/client.js' ),
	)
);
$assert( 'browser Playground session rejects untrusted Playground origins', is_wp_error( $browser_untrusted_playground_origin ) && 'wp_codebox_browser_origin_not_allowed' === $browser_untrusted_playground_origin->get_error_code() );

$browser_session_missing_prereqs = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal' => 'Prepare a browser preview without coding prerequisites.',
	)
);
$assert( 'browser Playground session with missing prerequisites returns blocked state', ! is_wp_error( $browser_session_missing_prereqs ) && false === ( $browser_session_missing_prereqs['success'] ?? true ) && 'blocked' === ( $browser_session_missing_prereqs['status'] ?? '' ) && 'blocked' === ( $browser_session_missing_prereqs['session']['status'] ?? '' ) );
$assert( 'browser Playground blocked session identifies disposable execution scope', ! is_wp_error( $browser_session_missing_prereqs ) && 'disposable-playground' === ( $browser_session_missing_prereqs['execution_scope'] ?? '' ) && 'disposable-playground' === ( $browser_session_missing_prereqs['session']['execution_scope'] ?? '' ) );
$assert( 'browser Playground blocked session identifies sandbox permission model', ! is_wp_error( $browser_session_missing_prereqs ) && 'sandbox-bypass' === ( $browser_session_missing_prereqs['permission_model'] ?? '' ) && 'sandbox-bypass' === ( $browser_session_missing_prereqs['session']['permission_model'] ?? '' ) );
$assert( 'browser Playground session with missing prerequisites does not emit ready-to-code or recipe', ! is_wp_error( $browser_session_missing_prereqs ) && false === ( $browser_session_missing_prereqs['signals']['ready_to_code']['emitted'] ?? true ) && ! array_key_exists( 'recipe', $browser_session_missing_prereqs ) && in_array( 'provider_plugin', $browser_session_missing_prereqs['signals']['ready_to_code']['missing'] ?? array(), true ) && in_array( 'provider_secret', $browser_session_missing_prereqs['signals']['ready_to_code']['missing'] ?? array(), true ) );

unset( $GLOBALS['wp_codebox_mock_abilities']['agents/chat'] );
$browser_session_missing_agents_api = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                  => 'Prepare a browser preview without Agents API.',
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
		'inherit'               => array( 'connectors' => array( 'openai' ) ),
	)
);
$assert( 'browser Playground session blocks when Agents API prerequisite is missing', ! is_wp_error( $browser_session_missing_agents_api ) && false === ( $browser_session_missing_agents_api['success'] ?? true ) && in_array( 'agents_api', $browser_session_missing_agents_api['signals']['ready_to_code']['missing'] ?? array(), true ) && ! array_key_exists( 'recipe', $browser_session_missing_agents_api ) );
$GLOBALS['wp_codebox_mock_abilities']['agents/chat'] = new WP_Ability();

$component_paths = $GLOBALS['wp_codebox_filters']['wp_codebox_component_paths'];
$GLOBALS['wp_codebox_filters']['wp_codebox_component_paths'] = array_merge( $component_paths, array( 'data_machine' => '' ) );
$browser_session_missing_data_machine = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                  => 'Prepare a browser preview without Data Machine.',
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
		'inherit'               => array( 'connectors' => array( 'openai' ) ),
	)
);
$assert( 'browser Playground session blocks when Data Machine prerequisite is missing', ! is_wp_error( $browser_session_missing_data_machine ) && false === ( $browser_session_missing_data_machine['success'] ?? true ) && in_array( 'data_machine', $browser_session_missing_data_machine['signals']['ready_to_code']['missing'] ?? array(), true ) && ! array_key_exists( 'recipe', $browser_session_missing_data_machine ) );
$GLOBALS['wp_codebox_filters']['wp_codebox_component_paths'] = $component_paths;

$browser_session_missing_secret = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'                  => 'Prepare a browser preview without provider secret.',
		'provider_plugin_paths' => array( $root . '/ai-provider-test' ),
	)
);
$assert( 'browser Playground session blocks when provider secret prerequisite is missing', ! is_wp_error( $browser_session_missing_secret ) && false === ( $browser_session_missing_secret['success'] ?? true ) && in_array( 'provider_secret', $browser_session_missing_secret['signals']['ready_to_code']['missing'] ?? array(), true ) && ! array_key_exists( 'recipe', $browser_session_missing_secret ) );
rmdir( $root . '/plugin-root/data-machine-code' );
rmdir( $root . '/plugin-root/data-machine' );

$custom_browser_session = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'           => 'Prepare a custom browser preview.',
		'playground'     => array(
			'artifact_base_path' => '/wordpress/wp-content/uploads/example-preview',
			'artifact_base_url'  => '/wp-content/uploads/example-preview',
			'preview_url'        => '/wp-content/uploads/example-preview/static-site/index.html',
		),
		'artifact_files' => array(
			array(
				'path'    => 'static-site/index.html',
				'content' => '<main>Custom</main>',
			),
		),
	)
);
$assert( 'browser Playground session honors custom artifact base path', ! is_wp_error( $custom_browser_session ) && '/wordpress/wp-content/uploads/example-preview/static-site/index.html' === ( $custom_browser_session['artifacts']['files'][0]['playground_path'] ?? '' ) );
$assert( 'browser Playground session honors custom preview URL', ! is_wp_error( $custom_browser_session ) && '/wp-content/uploads/example-preview/static-site/index.html' === ( $custom_browser_session['playground']['preview_url'] ?? '' ) );

$invalid_browser_file = call_user_func(
	$browser_session_ability['execute_callback'],
	array(
		'goal'           => 'Prepare an unsafe browser preview.',
		'artifact_files' => array(
			array(
				'path'    => '../secret.txt',
				'content' => 'nope',
			),
		),
	)
);
$assert( 'browser Playground session rejects unsafe artifact paths', is_wp_error( $invalid_browser_file ) && 'wp_codebox_browser_artifact_path_invalid' === $invalid_browser_file->get_error_code() );

$captured_command  = '';
$captured_commands = array();
$captured_recipe   = '';
$captured_recipes  = array();
$captured_secret_env = array();
$captured_timeout  = null;
$command_count     = 0;
$runner           = new WP_Codebox_Agent_Sandbox_Runner(
	array(
		'shell_available' => fn() => true,
		'command_runner'  => function ( string $command, array $secret_env = array(), int $timeout_seconds = 0 ) use ( &$captured_command, &$captured_commands, &$captured_recipe, &$captured_recipes, &$captured_secret_env, &$captured_timeout, &$command_count ): array {
			++$command_count;
			$captured_command    = $command;
			$captured_commands[] = $command;
			$captured_secret_env = $secret_env;
			$captured_timeout    = $timeout_seconds;
			if ( preg_match( "/--recipe '([^']+)'/", $command, $matches ) && is_readable( $matches[1] ) ) {
				$captured_recipe   = (string) file_get_contents( $matches[1] );
				$captured_recipes[] = $captured_recipe;
			}
			$artifact_id = 1 === $command_count ? 'artifact-bundle-sha256-fixture' : 'artifact-bundle-sha256-fixture-' . $command_count;
			return array(
				'exit_code' => 0,
				'output'    => json_encode(
					array(
						'success'   => true,
						'runtime'   => array( 'backend' => 'wordpress-playground' ),
						'artifacts' => array(
							'id'      => $artifact_id,
							'preview' => array(
								'url'      => str_contains( $command, 'https://preview.example.test/session-123/' ) ? 'https://preview.example.test/session-123/' : ( str_contains( $command, 'https://preview.example.test/batch/' ) ? 'https://preview.example.test/batch/' : 'http://127.0.0.1:' . ( 12344 + $command_count ) ),
								'localUrl' => 'http://127.0.0.1:' . ( 12344 + $command_count ),
							),
						),
						'agentResult' => array(
							'schema'       => 'wp-codebox/agent-result/v1',
							'status'       => 'completed',
							'actionable'   => false,
							'summary'      => 'Agent sandbox completed without actionable file changes.',
							'noOpReason'   => 'no_file_changes',
							'changedFiles' => array(
								'count'    => 0,
								'paths'    => array(),
								'artifact' => 'files/changed-files.json',
							),
							'patch'        => array(
								'bytes'    => 0,
								'artifact' => 'files/patch.diff',
							),
							'transcript'   => array(
								'artifact'       => 'files/transcript.json',
								'executionCount' => 1,
							),
						),
					)
				),
			);
		},
	)
);

$result = $runner->run(
	array(
		'task'           => 'Run a chat-requested sandbox task.',
		'sandbox_session_id' => 'parent-job-123',
		'session_id'     => 'agent-chat-session-456',
		'orchestrator'   => array(
			'type'   => 'external-job-system',
			'id'     => 'parent-control-plane',
			'job_id' => 'job-123',
		),
		'artifacts_path' => $root . '/artifacts',
		'secret_env'     => array( 'GITHUB_TOKEN' ),
		'preview_hold_seconds' => 30,
		'preview_port'   => 45678,
		'preview_bind'   => '127.0.0.1',
		'preview_public_url' => 'https://preview.example.test/session-123/',
		'task_timeout_seconds' => 7200,
		'mounts'         => array(
			array(
				'source'   => $root . '/editable-plugin',
				'target'   => '/wordpress/wp-content/plugins/editable-plugin',
				'mode'     => 'readwrite',
				'metadata' => array(
					'kind'                        => 'component',
					'slug'                        => 'editable-plugin',
					'repo'                        => 'example/editable-plugin',
					'default_branch'              => 'main',
					'repo_root_relative_to_mount' => '.',
					'editable'                    => true,
				),
			),
		),
	)
);

$assert( 'runner succeeds with filter-provided component paths', ! is_wp_error( $result ) && true === ( $result['success'] ?? false ) );
$assert( 'runner schema is stable', ! is_wp_error( $result ) && 'wp-codebox/agent-task-run/v1' === ( $result['schema'] ?? '' ) );
$assert( 'runner returns caller-owned sandbox session envelope', ! is_wp_error( $result ) && 'wp-codebox/sandbox-session/v1' === ( $result['session']['schema'] ?? '' ) && 'parent-job-123' === ( $result['session']['id'] ?? '' ) && 'external-orchestrator' === ( $result['session']['persistence'] ?? '' ) );
$assert( 'runner keeps agent session separate from sandbox session', ! is_wp_error( $result ) && 'agent-chat-session-456' === ( $result['session']['agent_session_id'] ?? '' ) && str_contains( $captured_recipe, 'session-id=agent-chat-session-456' ) );
$assert( 'runner returns orchestrator correlation and artifact refs', ! is_wp_error( $result ) && 'job-123' === ( $result['session']['orchestrator']['job_id'] ?? '' ) && 'artifact-bundle-sha256-fixture' === ( $result['session']['artifacts']['bundle_id'] ?? '' ) );
$assert( 'runner returns public preview URL in session artifact metadata', ! is_wp_error( $result ) && 'https://preview.example.test/session-123/' === ( $result['session']['artifacts']['preview_url'] ?? '' ) && 'https://preview.example.test/session-123/' === ( $result['run']['artifacts']['preview']['url'] ?? '' ) );
$assert( 'runner surfaces normalized agent result summary', ! is_wp_error( $result ) && 'wp-codebox/agent-result/v1' === ( $result['agent_result']['schema'] ?? '' ) && false === ( $result['agent_result']['actionable'] ?? true ) && 'no_file_changes' === ( $result['agent_result']['noOpReason'] ?? '' ) && 'files/transcript.json' === ( $result['agent_result']['transcript']['artifact'] ?? '' ) );
$assert( 'runner returns normalized task input for legacy task', ! is_wp_error( $result ) && 'wp-codebox/task-input/v1' === ( $result['task_input']['schema'] ?? '' ) && 'Run a chat-requested sandbox task.' === ( $result['task_input']['goal'] ?? '' ) );
$legacy_task_fixture = $task_input_fixture_by_name['legacy task maps to canonical goal with empty optionals']['normalized'] ?? array();
$assert( 'runner legacy task matches shared normalization fixture', ! is_wp_error( $result ) && $legacy_task_fixture === ( $result['task_input'] ?? array() ) );
$assert( 'runner invokes recipe-run', str_contains( $captured_command, 'recipe-run' ) );
$assert( 'runner uses node for JS CLI', str_contains( $captured_command, 'node' ) && str_contains( $captured_command, 'wp-codebox.js' ) );
$assert( 'runner passes preview hold to CLI', str_contains( $captured_command, '--preview-hold' ) && str_contains( $captured_command, "'30'" ) );
$assert( 'runner passes preview configuration to CLI', str_contains( $captured_command, '--preview-port' ) && str_contains( $captured_command, "'45678'" ) && str_contains( $captured_command, '--preview-bind' ) && str_contains( $captured_command, "'127.0.0.1'" ) && str_contains( $captured_command, '--preview-public-url' ) && str_contains( $captured_command, "'https://preview.example.test/session-123/'" ) );
$assert( 'runner recipe uses agent step', str_contains( $captured_recipe, 'wp-codebox.agent-sandbox-run' ) );
$assert( 'runner recipe passes task', str_contains( $captured_recipe, 'Run a chat-requested sandbox task.' ) );
$assert( 'runner recipe passes default agent', str_contains( $captured_recipe, 'site-coder' ) );
$assert( 'runner recipe passes sandbox mode', str_contains( $captured_recipe, 'sandbox' ) );
$assert( 'runner recipe passes default provider', str_contains( $captured_recipe, 'openai' ) );
$assert( 'runner recipe passes default model', str_contains( $captured_recipe, 'gpt-5.5' ) );
$assert( 'runner recipe passes provider plugin path', str_contains( $captured_recipe, 'ai-provider-test' ) );
$assert( 'runner recipe loads runtime components as mu-plugins', str_contains( $captured_recipe, '"slug":"agents-api","activate":false,"loadAs":"mu-plugin"' ) && str_contains( $captured_recipe, '"slug":"data-machine","activate":false,"loadAs":"mu-plugin"' ) && str_contains( $captured_recipe, '"slug":"data-machine-code","activate":false,"loadAs":"mu-plugin"' ) );
$assert( 'runner recipe passes generic mount metadata', str_contains( $captured_recipe, 'example/editable-plugin' ) && str_contains( $captured_recipe, 'repo_root_relative_to_mount' ) );
$assert( 'runner recipe passes secret env name only', str_contains( $captured_recipe, 'GITHUB_TOKEN' ) && ! str_contains( $captured_recipe, 'GITHUB_TOKEN=' ) );
$assert( 'runner passes timeout to command runner and recipe', 7200 === $captured_timeout && str_contains( $captured_recipe, 'timeout-seconds=7200' ) );
$assert( 'runner does not pass raw code options', ! str_contains( $captured_command, '--code ' ) && ! str_contains( $captured_command, '--code-file' ) );

$GLOBALS['wp_codebox_options']['blogname'] = 'Parent Seed Site';
$GLOBALS['wp_codebox_options']['active_plugins'] = array( 'agents-api/agents-api.php' );
$seed_result = $runner->run(
	array(
		'goal'           => 'Run with a bounded parent-site seed.',
		'artifacts_path' => $root . '/artifacts',
		'site_seeds'    => array(
			array(
				'type'   => 'parent_site',
				'name'   => 'parent-site-smoke',
				'scopes' => array(
					'posts'         => array( 'postTypes' => array( 'page' ), 'maxRecords' => 1 ),
					'terms'         => array( 'taxonomies' => array( 'category' ), 'maxRecords' => 1 ),
					'options'       => array( 'names' => array( 'blogname' ), 'maxRecords' => 1 ),
					'users'         => array( 'roles' => array( 'editor' ), 'anonymize' => true, 'maxRecords' => 1 ),
					'media'         => array( 'maxRecords' => 1 ),
					'activePlugins' => true,
					'activeTheme'   => true,
				),
			),
		),
	)
);
$seed_recipe = json_decode( $captured_recipe, true );
$seed_path   = (string) ( $seed_recipe['inputs']['siteSeeds'][0]['source'] ?? '' );
$assert( 'runner exports bounded parent-site seed as fixture', ! is_wp_error( $seed_result ) && 'fixture' === ( $seed_recipe['inputs']['siteSeeds'][0]['type'] ?? '' ) && 'json' === ( $seed_recipe['inputs']['siteSeeds'][0]['format'] ?? '' ) );
$assert( 'runner cleans temporary parent-site seed fixture after run', ! is_wp_error( $seed_result ) && '' !== $seed_path && ! file_exists( $seed_path ) );
$assert( 'runner preserves parent-site seed scope in recipe', ! is_wp_error( $seed_result ) && 1 === ( $seed_recipe['inputs']['siteSeeds'][0]['scopes']['posts']['maxRecords'] ?? 0 ) && true === ( $seed_recipe['inputs']['siteSeeds'][0]['scopes']['users']['anonymize'] ?? false ) );

unset( $GLOBALS['wp_codebox_filters']['wp_codebox_component_paths'] );
$plugin_native_result = $runner->run(
	array(
		'goal'           => 'Run with the host-installed Agents API plugin only.',
		'artifacts_path' => $root . '/artifacts',
	)
);
$plugin_native_recipe  = json_decode( $captured_recipe, true );
$plugin_native_plugins = array_map(
	static fn( array $plugin ): string => (string) ( $plugin['slug'] ?? '' ),
	$plugin_native_recipe['inputs']['extraPlugins'] ?? array()
);
$assert( 'runner defaults Agents API path from WP_PLUGIN_DIR', ! is_wp_error( $plugin_native_result ) && in_array( 'agents-api', $plugin_native_plugins, true ) );
$assert( 'runner does not require Data Machine component paths', ! is_wp_error( $plugin_native_result ) && ! in_array( 'data-machine', $plugin_native_plugins, true ) && ! in_array( 'data-machine-code', $plugin_native_plugins, true ) );

unset( $GLOBALS['wp_codebox_filters']['wp_codebox_bin'] );
$bundled_runtime_result = $runner->run(
	array(
		'goal'           => 'Run with the packaged WP Codebox CLI runtime.',
		'artifacts_path' => $root . '/artifacts',
	)
);
$assert( 'runner defaults to packaged CLI wrapper when present', ! is_wp_error( $bundled_runtime_result ) && str_contains( $captured_command, WP_CODEBOX_PLUGIN_PATH . 'vendor/wp-codebox-cli/bin/wp-codebox' ) );
$assert( 'runner preflights packaged Node runtime', ! is_wp_error( $bundled_runtime_result ) && ! str_contains( $captured_command, 'node: not found' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_bin'] = $root . '/wp-codebox.js';

$GLOBALS['wp_codebox_filters']['wp_codebox_component_paths'] = array(
	'agents_api'        => $root . '/agents-api',
	'data_machine'      => $root . '/data-machine',
	'data_machine_code' => $root . '/data-machine-code',
	'provider_plugins'  => array( $root . '/ai-provider-test' ),
);

$GLOBALS['wp_codebox_filters']['wp_codebox_default_provider'] = '';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_model']    = '';
$GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] = function ( array $resolution, array $request ): array {
	$resolution['connectors'] = array(
		array(
			'name'       => $request['connectors'][0] ?? 'primary-ai',
			'status'     => 'resolved',
			'provider'   => 'openai',
			'model'      => 'gpt-5.5',
			'secret_env' => array( 'OPENAI_API_KEY' ),
			'secret_env_values' => array( 'OPENAI_API_KEY' => 'sk-test-secret-value' ),
			'credentials' => array(
				'schema'    => 'wp-codebox/connector-credentials/v1',
				'connector' => $request['connectors'][0] ?? 'primary-ai',
				'scope'     => 'connector',
				'status'    => 'available',
				'secrets'   => array(
					array(
						'name'   => 'OPENAI_API_KEY',
						'status' => 'available',
						'scope'  => 'primary-ai',
						'source' => 'parent-env',
					),
				),
			),
			'value'      => 'sk-test-secret-value',
			'token'      => 'sk-test-secret-value',
		),
	);
	$resolution['settings']   = array(
		array(
			'name'   => $request['settings'][0] ?? 'mode_models',
			'status' => 'resolved',
			'scope'  => 'site',
			'value'  => 'sk-test-secret-value',
		),
	);

	return $resolution;
};

$inherit_result = $runner->run(
	array(
		'goal'           => 'Use inherited connector configuration.',
		'artifacts_path' => $root . '/artifacts',
		'inherit'        => array(
			'connectors' => array( 'primary-ai' ),
			'settings'   => array( 'mode_models' ),
		),
	)
);
$inherit_recipe    = json_decode( $captured_recipe, true );
$inherit_step_args = $inherit_recipe['workflow']['steps'][0]['args'] ?? array();
$assert( 'runner resolves inherited connector provider', ! is_wp_error( $inherit_result ) && in_array( 'provider=openai', $inherit_step_args, true ) );
$assert( 'runner resolves inherited connector model', ! is_wp_error( $inherit_result ) && in_array( 'model=gpt-5.5', $inherit_step_args, true ) );
$assert( 'runner transports inherited secret env name only', ! is_wp_error( $inherit_result ) && in_array( 'OPENAI_API_KEY', $inherit_recipe['inputs']['secretEnv'] ?? array(), true ) && ! str_contains( $captured_recipe, 'OPENAI_API_KEY=' ) );
$assert( 'runner passes inherited secret env value to command runner', ! is_wp_error( $inherit_result ) && 'sk-test-secret-value' === ( $captured_secret_env['OPENAI_API_KEY'] ?? '' ) );
$assert( 'runner records connector credential provenance without value', ! is_wp_error( $inherit_result ) && 'wp-codebox/connector-credentials/v1' === ( $inherit_recipe['inputs']['inheritance']['connectors'][0]['credentials']['schema'] ?? '' ) && 'available' === ( $inherit_recipe['inputs']['inheritance']['connectors'][0]['credentials']['secrets'][0]['status'] ?? '' ) );
$assert( 'runner records sanitized inheritance status', ! is_wp_error( $inherit_result ) && 'primary-ai' === ( $inherit_recipe['inputs']['inheritance']['connectors'][0]['name'] ?? '' ) && 'resolved' === ( $inherit_recipe['inputs']['inheritance']['settings'][0]['status'] ?? '' ) );
$assert( 'runner drops inherited secret values from recipe', ! str_contains( $captured_recipe, 'sk-test-secret-value' ) && ! str_contains( $captured_recipe, 'token' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] = function ( array $resolution, array $request ): array {
	$resolution['connectors'] = array(
		array(
			'name'        => $request['connectors'][0] ?? 'primary-ai',
			'status'      => 'resolved',
			'provider'    => 'openai',
			'model'       => 'gpt-5.5',
			'credentials' => array(
				'schema'    => 'wp-codebox/connector-credentials/v1',
				'connector' => $request['connectors'][0] ?? 'primary-ai',
				'scope'     => 'connector',
				'status'    => 'denied',
				'reason'    => 'scope not approved',
				'secrets'   => array(
					array(
						'name'   => 'OPENAI_API_KEY',
						'status' => 'denied',
						'scope'  => 'primary-ai',
						'source' => 'connector',
						'reason' => 'scope not approved',
					),
				),
			),
		),
	);

	return $resolution;
};

$denied_credentials = $runner->run(
	array(
		'goal'           => 'Use denied connector credentials.',
		'artifacts_path' => $root . '/artifacts',
		'inherit'        => array( 'connectors' => array( 'primary-ai' ) ),
	)
);
$assert( 'denied connector credential scope fails closed', is_wp_error( $denied_credentials ) && 'wp_codebox_connector_credentials_unavailable' === $denied_credentials->get_error_code() );
$assert( 'denied connector credential failure is observable and redacted', is_wp_error( $denied_credentials ) && 'wp-codebox/connector-credential-failure/v1' === ( $denied_credentials->get_error_data()['schema'] ?? '' ) && ! str_contains( json_encode( $denied_credentials->get_error_data() ), 'sk-test-secret-value' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] = function ( array $resolution, array $request ): array {
	$resolution['connectors'] = array(
		array(
			'name'        => $request['connectors'][0] ?? 'primary-ai',
			'status'      => 'resolved',
			'provider'    => 'openai',
			'model'       => 'gpt-5.5',
			'credentials' => array(
				'schema'    => 'wp-codebox/connector-credentials/v1',
				'connector' => $request['connectors'][0] ?? 'primary-ai',
				'scope'     => 'connector',
				'status'    => 'missing',
				'secrets'   => array(
					array( 'name' => 'OPENAI_API_KEY', 'status' => 'missing', 'scope' => 'primary-ai', 'source' => 'parent-env' ),
				),
			),
		),
	);

	return $resolution;
};

$missing_credentials = $runner->run(
	array(
		'goal'           => 'Use missing connector credentials.',
		'artifacts_path' => $root . '/artifacts',
		'inherit'        => array( 'connectors' => array( 'primary-ai' ) ),
	)
);
$assert( 'missing connector credential scope fails closed', is_wp_error( $missing_credentials ) && 'wp_codebox_connector_credentials_unavailable' === $missing_credentials->get_error_code() );

$GLOBALS['wp_codebox_filters']['wp_codebox_default_provider'] = 'openai';
$GLOBALS['wp_codebox_filters']['wp_codebox_default_model']    = 'gpt-5.5';
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_resolve_inheritance'] );

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

$invalid_mount = $runner->run(
	array(
		'task'           => 'Run a chat-requested sandbox task.',
		'artifacts_path' => $root . '/artifacts',
		'mounts'         => array(
			array(
				'source' => $root . '/missing-plugin',
				'target' => '/wordpress/wp-content/plugins/missing-plugin',
			),
		),
	)
);
$assert( 'invalid mount input fails closed', is_wp_error( $invalid_mount ) && 'wp_codebox_mount_source_invalid' === $invalid_mount->get_error_code() );

$invalid_preview_bind = $runner->run(
	array(
		'task'           => 'Run a chat-requested sandbox task.',
		'artifacts_path' => $root . '/artifacts',
		'preview_bind'   => '0.0.0.0',
	)
);
$assert( 'preview bind without preview port fails closed', is_wp_error( $invalid_preview_bind ) && 'wp_codebox_preview_bind_requires_port' === $invalid_preview_bind->get_error_code() );

$invalid_preview_url = $runner->run(
	array(
		'task'               => 'Run a chat-requested sandbox task.',
		'artifacts_path'     => $root . '/artifacts',
		'preview_public_url' => 'file:///tmp/preview',
	)
);
$assert( 'invalid preview public URL fails closed', is_wp_error( $invalid_preview_url ) && 'wp_codebox_preview_public_url_invalid' === $invalid_preview_url->get_error_code() );

$structured_result = $runner->run(
	array(
		'goal'               => 'Add a focused product feature.',
		'target'             => array(
			'kind' => 'plugin',
			'path' => 'wp-content/plugins/simple-plugin',
		),
		'allowed_tools'      => array( 'workspace.read', 'workspace.write', 'datamachine/workspace-read', '' ),
		'expected_artifacts' => array( 'patch', 'tests', 'patch' ),
		'policy'             => array( 'applyBack' => 'reviewed' ),
		'context'            => array( 'issue' => 'https://github.com/chubes4/wp-codebox/issues/29' ),
		'artifacts_path'     => $root . '/artifacts',
	)
);

$assert( 'runner accepts structured task input', ! is_wp_error( $structured_result ) && 'Add a focused product feature.' === ( $structured_result['task_input']['goal'] ?? '' ) );
$assert( 'runner preserves structured target', ! is_wp_error( $structured_result ) && 'plugin' === ( $structured_result['task_input']['target']['kind'] ?? '' ) );
$assert( 'runner normalizes task input lists', ! is_wp_error( $structured_result ) && array( 'workspace.read', 'workspace.write', 'datamachine/workspace-read' ) === ( $structured_result['task_input']['allowed_tools'] ?? array() ) && array( 'patch', 'tests' ) === ( $structured_result['task_input']['expected_artifacts'] ?? array() ) );
$assert( 'runner returns canonical structured task input shape', ! is_wp_error( $structured_result ) && array_key_exists( 'context', $structured_result['task_input'] ?? array() ) && 1 === ( $structured_result['task_input']['version'] ?? 0 ) );
$assert( 'runner passes structured task contract to recipe', str_contains( $captured_recipe, 'wp-codebox/task-input/v1' ) && str_contains( $captured_recipe, 'allowed_tools' ) );
$assert( 'runner leaves preview config unset by default', ! str_contains( $captured_command, '--preview-port' ) && ! str_contains( $captured_command, '--preview-bind' ) && ! str_contains( $captured_command, '--preview-public-url' ) );

$host_browser_equivalent_input = array(
	'goal'               => 'Prepare a browser Playground preview.',
	'target'             => array( 'kind' => 'static-site' ),
	'allowed_tools'      => array( 'filesystem-write', 'filesystem-write', '' ),
	'expected_artifacts' => array( 'static-site' ),
);
$host_browser_equivalent_task = WP_Codebox_Agent_Task::normalize_input( $host_browser_equivalent_input );
$assert( 'host and browser preparation share task input normalization', ! is_wp_error( $host_browser_equivalent_task ) && array_intersect_key( $browser_session['task_input'] ?? array(), $host_browser_equivalent_task ) === $host_browser_equivalent_task );

$remediation_artifact_run = function ( string $name, array $files ): array {
	$directory = sys_get_temp_dir() . '/wp-codebox-remediation-artifact-' . $name . '-' . uniqid( '', true );
	mkdir( $directory . '/files', 0777, true );
	file_put_contents(
		$directory . '/files/changed-files.json',
		json_encode( array( 'schema' => 'wp-codebox/changed-files/v1', 'files' => $files ), JSON_PRETTY_PRINT )
	);

	return array(
		'artifacts' => array(
			'id'        => 'artifact-' . $name,
			'directory' => $directory,
		),
	);
};

$remediation_run = function ( array $agent_payload, int $exit_code = 0, array $run_overrides = array() ) use ( $root ): array|WP_Error {
	$strict_runner = new WP_Codebox_Agent_Sandbox_Runner(
		array(
			'shell_available' => fn() => true,
			'command_runner'  => function () use ( $agent_payload, $exit_code, $run_overrides ): array {
				$run = array_merge(
					array(
						'success'    => 0 === $exit_code,
						'schema'     => 'wp-codebox/recipe-run/v1',
						'executions' => array(
							array(
								'command'  => 'wp-codebox.agent-sandbox-run',
								'exitCode' => $exit_code,
								'stdout'   => json_encode( array( 'result' => $agent_payload ) ),
								'stderr'   => '',
							),
						),
					),
					$run_overrides
				);

				return array(
					'exit_code' => $exit_code,
					'output'    => json_encode( $run ),
				);
			},
		)
	);

	return $strict_runner->run(
		array(
			'goal'               => 'Remediate audit finding.',
			'target'             => array( 'kind' => 'audit-remediation' ),
			'expected_artifacts' => array( 'fix_artifact', 'false_positive_artifact' ),
			'artifacts_path'     => $root . '/artifacts',
		)
	);
};

$provider_error_result = $remediation_run(
	array(
		'error'    => array(
			'message' => 'Provider timeout after OpenAI 429 Too Many Requests.',
			'code'    => 'provider_rate_limited',
		),
		'metadata' => array(
			'datamachine' => array(
				'completed'         => false,
				'max_turns_reached' => false,
			),
		),
	),
	1
);
$assert( 'strict remediation outcome classifies provider timeout and 429', ! is_wp_error( $provider_error_result ) && false === ( $provider_error_result['success'] ?? true ) && 'provider_error' === ( $provider_error_result['outcome']['kind'] ?? '' ) && true === ( $provider_error_result['outcome']['retryable'] ?? false ) );
$assert( 'strict remediation outcome preserves provider and Data Machine diagnostics', ! is_wp_error( $provider_error_result ) && str_contains( $provider_error_result['outcome']['provider_error']['message'] ?? '', 'Provider timeout' ) && false === ( $provider_error_result['outcome']['metadata']['datamachine']['completed'] ?? true ) );

$text_false_positive_result = $remediation_run(
	array(
		'answer'   => 'This looks like a false positive; no code changes are needed.',
		'metadata' => array( 'datamachine' => array( 'completed' => true, 'max_turns_reached' => false ) ),
	)
);
$assert( 'strict remediation outcome returns noop artifact for text-only false-positive conclusions without artifact', ! is_wp_error( $text_false_positive_result ) && true === ( $text_false_positive_result['success'] ?? false ) && 'noop_artifact' === ( $text_false_positive_result['outcome']['kind'] ?? '' ) && true === ( $text_false_positive_result['outcome']['false_positive'] ?? false ) );

$normal_no_pr_result = $remediation_run(
	array(
		'answer'   => 'Done.',
		'metadata' => array( 'datamachine' => array( 'completed' => true, 'max_turns_reached' => false ) ),
	)
);
$assert( 'strict remediation outcome returns unable-to-remediate terminal outcome without artifact', ! is_wp_error( $normal_no_pr_result ) && true === ( $normal_no_pr_result['success'] ?? false ) && 'unable_to_remediate' === ( $normal_no_pr_result['outcome']['kind'] ?? '' ) );

$fix_artifact_result = $remediation_run(
	array(
		'metadata' => array( 'datamachine' => array( 'completed' => true, 'max_turns_reached' => false ) ),
	),
	0,
	$remediation_artifact_run( 'fix', array( array( 'path' => '/wordpress/wp-content/plugins/example/example.php', 'relativePath' => 'example.php', 'status' => 'modified' ) ) )
);
$assert( 'strict remediation outcome accepts changed fix artifact', ! is_wp_error( $fix_artifact_result ) && true === ( $fix_artifact_result['success'] ?? false ) && 'fix_artifact' === ( $fix_artifact_result['outcome']['kind'] ?? '' ) && 'example.php' === ( $fix_artifact_result['outcome']['artifact']['changed_files'][0]['relative_path'] ?? '' ) );

$false_positive_artifact_result = $remediation_run(
	array(
		'false_positive' => true,
		'metadata'       => array( 'datamachine' => array( 'completed' => true, 'max_turns_reached' => false ) ),
	),
	0,
	$remediation_artifact_run( 'false-positive', array( array( 'path' => '/wordpress/wp-content/plugins/example/tests/audit.php', 'relativePath' => 'tests/audit.php', 'status' => 'modified' ) ) )
);
$assert( 'strict remediation outcome accepts changed false-positive artifact', ! is_wp_error( $false_positive_artifact_result ) && true === ( $false_positive_artifact_result['success'] ?? false ) && 'false_positive_artifact' === ( $false_positive_artifact_result['outcome']['kind'] ?? '' ) && true === ( $false_positive_artifact_result['outcome']['false_positive'] ?? false ) );

$max_turns_result = $remediation_run(
	array(
		'answer'   => 'Still working.',
		'metadata' => array( 'datamachine' => array( 'completed' => false, 'max_turns_reached' => true ) ),
	)
);
$assert( 'strict remediation outcome preserves max turns exhaustion', ! is_wp_error( $max_turns_result ) && false === ( $max_turns_result['success'] ?? true ) && 'max_turns_exceeded' === ( $max_turns_result['outcome']['kind'] ?? '' ) && true === ( $max_turns_result['outcome']['diagnostics']['max_turns_reached'] ?? false ) );

$parent_only_tool = $runner->run(
	array(
		'goal'           => 'Try a parent-only workspace mutation.',
		'allowed_tools'  => array( 'datamachine/workspace-git-push' ),
		'artifacts_path' => $root . '/artifacts',
	)
);
$assert( 'parent-only Data Machine tool request fails closed', is_wp_error( $parent_only_tool ) && 'wp_codebox_tool_not_allowed' === $parent_only_tool->get_error_code() );
$assert( 'tool denial includes structured redacted details', is_wp_error( $parent_only_tool ) && 'wp-codebox/tool-allowlist-denial/v1' === ( $parent_only_tool->get_error_data()['schema'] ?? '' ) && 'parent-only' === ( $parent_only_tool->get_error_data()['denied_tools'][0]['reason'] ?? '' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_allowed_sandbox_tools'] = array( 'datamachine/workspace-read' );
$not_allowlisted_tool = $runner->run(
	array(
		'goal'           => 'Try an unconfigured sandbox tool.',
		'allowed_tools'  => array( 'datamachine/workspace-write' ),
		'artifacts_path' => $root . '/artifacts',
	)
);
$assert( 'configured Data Machine tool allow-list fails closed', is_wp_error( $not_allowlisted_tool ) && 'wp_codebox_tool_not_allowed' === $not_allowlisted_tool->get_error_code() );
$assert( 'configured allow-list denial reports allowed tools', is_wp_error( $not_allowlisted_tool ) && array( 'datamachine/workspace-read' ) === ( $not_allowlisted_tool->get_error_data()['allowed_tools'] ?? array() ) && 'not-allowlisted' === ( $not_allowlisted_tool->get_error_data()['denied_tools'][0]['reason'] ?? '' ) );
unset( $GLOBALS['wp_codebox_filters']['wp_codebox_allowed_sandbox_tools'] );

$batch_result = $runner->run_batch(
	array(
		'tasks'          => array( 'Fix issue one.', 'Fix issue two.' ),
		'sandbox_session_id' => 'parent-batch-789',
		'artifacts_path' => $root . '/artifacts',
		'preview_port'   => 45679,
		'preview_bind'   => '127.0.0.1',
		'preview_public_url' => 'https://preview.example.test/batch/',
	)
);

$assert( 'batch runner succeeds with filter-provided component paths', ! is_wp_error( $batch_result ) && true === ( $batch_result['success'] ?? false ) );
$assert( 'batch runner schema is stable', ! is_wp_error( $batch_result ) && 'wp-codebox/agent-task-batch/v1' === ( $batch_result['schema'] ?? '' ) );
$assert( 'batch runner returns normalized task inputs', ! is_wp_error( $batch_result ) && 2 === count( $batch_result['task_inputs'] ?? array() ) && 'Fix issue one.' === ( $batch_result['task_inputs'][0]['goal'] ?? '' ) );
$batch_recipes = array_slice( $captured_recipes, -2 );
$batch_commands = array_slice( $captured_commands, -2 );
$assert( 'batch runner invokes recipe-run once per task', 2 === count( $batch_result['runs'] ?? array() ) && 2 === count( $batch_recipes ) && str_contains( $captured_commands[ count( $captured_commands ) - 1 ] ?? '', 'recipe-run' ) );
$assert( 'batch runner emits one agent step per isolated recipe', 1 === substr_count( $batch_recipes[0] ?? '', 'wp-codebox.agent-sandbox-run' ) && 1 === substr_count( $batch_recipes[1] ?? '', 'wp-codebox.agent-sandbox-run' ) );
$assert( 'batch runner returns sequential isolation contract', 'sequential-isolated-sandboxes' === ( $batch_result['execution'] ?? '' ) && ! array_key_exists( 'concurrency', $batch_result ) );
$assert( 'batch runner returns per-task artifact refs', ! is_wp_error( $batch_result ) && '' !== ( $batch_result['runs'][0]['artifact_id'] ?? '' ) && '' !== ( $batch_result['runs'][1]['artifact_id'] ?? '' ) && ( $batch_result['runs'][0]['artifact_id'] ?? '' ) !== ( $batch_result['runs'][1]['artifact_id'] ?? '' ) );
$assert( 'batch runner returns per-task agent result summaries', ! is_wp_error( $batch_result ) && 'wp-codebox/agent-result/v1' === ( $batch_result['runs'][0]['agent_result']['schema'] ?? '' ) && 'files/transcript.json' === ( $batch_result['runs'][1]['agent_result']['transcript']['artifact'] ?? '' ) );
$assert( 'batch runner returns per-task preview URLs', ! is_wp_error( $batch_result ) && 'https://preview.example.test/batch/' === ( $batch_result['runs'][0]['preview_url'] ?? '' ) && 'https://preview.example.test/batch/' === ( $batch_result['runs'][1]['preview_url'] ?? '' ) );
$assert( 'batch runner assigns per-task sandbox session ids', ! is_wp_error( $batch_result ) && 'parent-batch-789:1' === ( $batch_result['runs'][0]['session']['id'] ?? '' ) && 'parent-batch-789:2' === ( $batch_result['runs'][1]['session']['id'] ?? '' ) );
$assert( 'batch runner reports per-task counts', ! is_wp_error( $batch_result ) && 2 === ( $batch_result['total'] ?? 0 ) && 2 === ( $batch_result['completed'] ?? 0 ) && 0 === ( $batch_result['failed'] ?? -1 ) );
$assert( 'batch runner recipe passes default provider', str_contains( $batch_recipes[0] ?? '', 'openai' ) && str_contains( $batch_recipes[1] ?? '', 'openai' ) );
$assert( 'batch runner recipe passes default model', str_contains( $batch_recipes[0] ?? '', 'gpt-5.5' ) && str_contains( $batch_recipes[1] ?? '', 'gpt-5.5' ) );
$assert( 'batch runner recipe passes provider plugin path', str_contains( $batch_recipes[0] ?? '', 'ai-provider-test' ) && str_contains( $batch_recipes[1] ?? '', 'ai-provider-test' ) );
$assert( 'batch runner recipe passes secret env name only', str_contains( $batch_recipes[0] ?? '', 'OPENAI_API_KEY' ) && str_contains( $batch_recipes[1] ?? '', 'OPENAI_API_KEY' ) );
$assert( 'batch runner passes preview configuration to each CLI run', str_contains( $batch_commands[0] ?? '', '--preview-port' ) && str_contains( $batch_commands[0] ?? '', "'45679'" ) && str_contains( $batch_commands[0] ?? '', '--preview-bind' ) && str_contains( $batch_commands[0] ?? '', "'127.0.0.1'" ) && str_contains( $batch_commands[0] ?? '', '--preview-public-url' ) && str_contains( $batch_commands[0] ?? '', "'https://preview.example.test/batch/'" ) && str_contains( $batch_commands[1] ?? '', '--preview-port' ) && str_contains( $batch_commands[1] ?? '', "'45679'" ) && str_contains( $batch_commands[1] ?? '', '--preview-bind' ) && str_contains( $batch_commands[1] ?? '', "'127.0.0.1'" ) && str_contains( $batch_commands[1] ?? '', '--preview-public-url' ) && str_contains( $batch_commands[1] ?? '', "'https://preview.example.test/batch/'" ) );

$failing_batch_count  = 0;
$failing_batch_runner = new WP_Codebox_Agent_Sandbox_Runner(
	array(
		'shell_available' => fn() => true,
		'command_runner'  => function () use ( &$failing_batch_count ): array {
			++$failing_batch_count;
			if ( 2 === $failing_batch_count ) {
				return array(
					'exit_code' => 1,
					'output'    => json_encode( array( 'success' => false, 'error' => 'fixture failure' ) ),
				);
			}

			return array(
				'exit_code' => 0,
				'output'    => json_encode(
					array(
						'success'   => true,
						'artifacts' => array(
							'id'      => 'artifact-bundle-sha256-partial-success',
							'preview' => array( 'url' => 'http://127.0.0.1:22345' ),
						),
					)
				),
			);
		},
	)
);
$partial_batch = $failing_batch_runner->run_batch(
	array(
		'tasks'          => array( 'Succeed once.', 'Fail once.' ),
		'artifacts_path' => $root . '/artifacts',
	)
);
$assert( 'batch runner continues after per-task failure', ! is_wp_error( $partial_batch ) && false === ( $partial_batch['success'] ?? true ) && 1 === ( $partial_batch['completed'] ?? 0 ) && 1 === ( $partial_batch['failed'] ?? 0 ) );
$assert( 'batch runner returns per-task errors', ! is_wp_error( $partial_batch ) && 'failed' === ( $partial_batch['runs'][1]['status'] ?? '' ) && 'wp_codebox_run_failed' === ( $partial_batch['runs'][1]['error']['code'] ?? '' ) );

$pending_action_handlers_filter     = $GLOBALS['wp_codebox_filters']['datamachine_pending_action_handlers'] ?? null;
$GLOBALS['wp_codebox_is_multisite'] = true;
$GLOBALS['wp_codebox_filters']      = array_filter(
	array( 'datamachine_pending_action_handlers' => $pending_action_handlers_filter ),
	static fn( mixed $filter ): bool => null !== $filter
);
$GLOBALS['wp_codebox_site_options'] = array(
	'wp_codebox_component_paths' => array(
		'agents_api'        => $root . '/agents-api',
		'data_machine'      => $root . '/data-machine',
		'data_machine_code' => $root . '/data-machine-code',
		'provider_plugins'  => array( $root . '/ai-provider-test' ),
	),
	'wp_codebox_bin'             => $root . '/wp-codebox.js',
	'wp_codebox_artifacts_root'  => $root . '/artifact-network-root',
);

$network_result = $runner->run( array( 'task' => 'Use network-level WP Codebox configuration.' ) );
$assert( 'multisite runner reads network-level options', ! is_wp_error( $network_result ) && str_starts_with( (string) ( $network_result['artifacts'] ?? '' ), $root . '/artifact-network-root' ) );

$GLOBALS['wp_codebox_is_multisite'] = false;
$GLOBALS['wp_codebox_filters']      = array_filter(
	array(
		'wp_codebox_component_paths'            => array(
			'agents_api'        => $root . '/agents-api',
			'data_machine'      => $root . '/data-machine',
			'data_machine_code' => $root . '/data-machine-code',
		),
		'wp_codebox_bin'                        => $root . '/wp-codebox.js',
		'wp_codebox_default_agent'              => 'site-coder',
		'wp_codebox_default_provider'           => 'openai',
		'wp_codebox_default_model'              => 'gpt-5.5',
		'wp_codebox_default_secret_env'         => array( 'OPENAI_API_KEY' ),
		'datamachine_pending_action_handlers'   => $pending_action_handlers_filter,
	),
	static fn( mixed $filter ): bool => null !== $filter
);

$missing_task = $runner->run( array( 'artifacts_path' => $root . '/artifacts' ) );
$assert( 'missing task fails closed', is_wp_error( $missing_task ) && 'wp_codebox_task_missing' === $missing_task->get_error_code() );

$missing_tasks = $runner->run_batch( array( 'artifacts_path' => $root . '/artifacts' ) );
$assert( 'missing batch tasks fails closed', is_wp_error( $missing_tasks ) && 'wp_codebox_tasks_missing' === $missing_tasks->get_error_code() );

$artifact_root = $root . '/artifact-store';
$bundle_dir    = $artifact_root . '/runtime-test';
mkdir( $bundle_dir . '/files', 0777, true );
$changed_files_json = json_encode(
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
			array(
				'path'         => '/wordpress/wp-content/plugins/example/unapproved.txt',
				'status'       => 'added',
				'mountIndex'   => 0,
				'mountTarget'  => '/wordpress/wp-content/plugins/example',
				'relativePath' => 'unapproved.txt',
				'patchPath'    => 'files/diffs/mount-0.patch',
			),
		),
	),
	JSON_PRETTY_PRINT
) . "\n";
$approved_patch_diff = "diff --git a/generated.txt b/generated.txt\n+cooked\n";
$patch_diff          = $approved_patch_diff . "diff --git a/unapproved.txt b/unapproved.txt\n+unsafe\n";
$content_digest      = hash( 'sha256', "wp-codebox/artifact-content/v1\nfiles/changed-files.json\n" . $changed_files_json . "\nfiles/patch.diff\n" . $patch_diff );
$artifact_id         = 'artifact-bundle-sha256-' . $content_digest;
$metadata = array(
	'artifacts'  => array( 'patch' => 'files/patch.diff' ),
	'provenance' => array(
		'task' => array(
			'requester' => 'chat:user-7',
		),
	),
);
$test_results = array(
	'schema'           => 'wp-codebox/test-results/v1',
	'status'           => 'unknown',
	'summary'          => array(
		'total'   => 0,
		'passed'  => 0,
		'failed'  => 0,
		'skipped' => 0,
		'unknown' => 0,
	),
	'suites'           => array(),
	'rawLogReferences' => array(),
);
$review = array(
	'schema'       => 'wp-codebox/artifact-review/v1',
	'artifactId'   => $artifact_id,
	'summary'      => 'Sandbox produced changes in 1 file.',
	'actions'      => array(
		array(
			'kind'                  => 'approve',
			'label'                 => 'Approve all changes',
			'requiresApprovedFiles' => true,
		),
	),
	'evidence'     => array(
		'artifactContentDigest' => $content_digest,
		'changedFiles'          => 'files/changed-files.json',
		'patch'                 => 'files/patch.diff',
		'patchSha256'           => hash( 'sha256', $patch_diff ),
	),
	'changedFiles' => array(
		array(
			'path'   => '/wordpress/wp-content/plugins/example/generated.txt',
			'status' => 'added',
		),
	),
);
file_put_contents( $bundle_dir . '/metadata.json', json_encode( $metadata, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" );
file_put_contents( $bundle_dir . '/files/changed-files.json', $changed_files_json );
file_put_contents( $bundle_dir . '/files/patch.diff', $patch_diff );
file_put_contents( $bundle_dir . '/files/test-results.json', json_encode( $test_results, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" );
file_put_contents( $bundle_dir . '/files/review.json', json_encode( $review, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" );
$manifest = array(
	'id'            => $artifact_id,
	'contentDigest' => array(
		'algorithm' => 'sha256',
		'inputs'    => array( 'files/changed-files.json', 'files/patch.diff' ),
		'value'     => $content_digest,
	),
	'createdAt'     => '2026-05-19T00:00:00Z',
	'runtime'       => array( 'type' => 'php-smoke-fixture' ),
	'files'         => array(
		array( 'path' => 'manifest.json', 'kind' => 'manifest', 'contentType' => 'application/json' ),
		array( 'path' => 'metadata.json', 'kind' => 'metadata', 'contentType' => 'application/json' ),
		array( 'path' => 'files/changed-files.json', 'kind' => 'changed-files', 'contentType' => 'application/json' ),
		array( 'path' => 'files/patch.diff', 'kind' => 'patch', 'contentType' => 'text/x-diff' ),
		array( 'path' => 'files/test-results.json', 'kind' => 'test-results', 'contentType' => 'application/json' ),
		array( 'path' => 'files/review.json', 'kind' => 'review', 'contentType' => 'application/json' ),
	),
);
foreach ( $manifest['files'] as &$manifest_file ) {
	if ( 'manifest.json' !== $manifest_file['path'] ) {
		$manifest_file['sha256'] = array( 'algorithm' => 'sha256', 'value' => hash_file( 'sha256', $bundle_dir . '/' . $manifest_file['path'] ) );
	}
}
unset( $manifest_file );
$manifest['files'][0]['sha256'] = array( 'algorithm' => 'sha256', 'value' => $manifest_self_hash( $manifest ) );
file_put_contents( $bundle_dir . '/manifest.json', json_encode( $manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" );

$artifacts = new WP_Codebox_Artifacts();
$listed    = $artifacts->list( array( 'artifacts_path' => $artifact_root ) );
$assert( 'artifact listing succeeds', ! is_wp_error( $listed ) && 1 === count( $listed['artifacts'] ?? array() ) );
$assert( 'artifact listing detects test results', ! is_wp_error( $listed ) && true === ( $listed['artifacts'][0]['has_test_results'] ?? false ) );

call_user_func( $GLOBALS['wp_codebox_cli_commands']['codebox artifacts list'], array(), array( 'artifacts-path' => $artifact_root, 'format' => 'json' ) );
$cli_list_output = json_decode( end( $GLOBALS['wp_codebox_cli_lines'] ), true );
$assert( 'wp codebox artifacts list emits JSON service result', is_array( $cli_list_output ) && 'wp-codebox/artifact-list/v1' === ( $cli_list_output['schema'] ?? '' ) && $artifact_id === ( $cli_list_output['artifacts'][0]['id'] ?? '' ) );

$read_artifact = $artifacts->get(
	array(
		'artifacts_path' => $artifact_root,
		'artifact_id'    => $artifact_id,
	)
);
$assert( 'artifact get returns canonical changed files', ! is_wp_error( $read_artifact ) && 'wp-codebox/changed-files/v1' === ( $read_artifact['artifact']['changed_files']['schema'] ?? '' ) );
$assert( 'artifact get returns test results', ! is_wp_error( $read_artifact ) && 'wp-codebox/test-results/v1' === ( $read_artifact['artifact']['test_results']['schema'] ?? '' ) );
$assert( 'artifact get returns review payload', ! is_wp_error( $read_artifact ) && 'wp-codebox/artifact-review/v1' === ( $read_artifact['artifact']['review']['schema'] ?? '' ) );
$assert( 'artifact get verifies content digest', ! is_wp_error( $read_artifact ) && $content_digest === ( $read_artifact['artifact']['content_digest'] ?? '' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_bin'] = dirname( __DIR__ ) . '/packages/cli/dist/index.js';

$malformed_manifest_root = $root . '/artifact-malformed-manifest';
mkdir( $malformed_manifest_root . '/broken', 0777, true );
file_put_contents( $malformed_manifest_root . '/broken/manifest.json', "{\n" );
$verify_output = array();
$verify_exit   = 0;
exec( 'node ' . escapeshellarg( $GLOBALS['wp_codebox_filters']['wp_codebox_bin'] ) . ' artifacts verify --bundle ' . escapeshellarg( $malformed_manifest_root . '/broken' ) . ' --json 2>&1', $verify_output, $verify_exit );
$verify_result = json_decode( implode( "\n", $verify_output ), true );
$assert( 'generic verifier reports malformed manifest fixtures', 1 === $verify_exit && false === ( $verify_result['valid'] ?? true ) && 'malformed-manifest' === ( $verify_result['violations'][0]['code'] ?? '' ) );

$hash_fixture_root = $root . '/artifact-hash-fixture';
$copy_directory( $bundle_dir, $hash_fixture_root . '/runtime-test' );
file_put_contents( $hash_fixture_root . '/runtime-test/metadata.json', "{}\n" );
$hash_failure = $artifacts->apply_approved(
	array(
		'artifacts_path' => $hash_fixture_root,
		'artifact_id'    => $artifact_id,
		'approved_files' => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
	)
);
$assert( 'approved artifact apply rejects hash mismatch fixtures before delegation', is_wp_error( $hash_failure ) && 'wp_codebox_artifact_verification_failed' === $hash_failure->get_error_code() && in_array( 'file-hash-mismatch', $violation_codes( $hash_failure ), true ) );

$reference_fixture_root = $root . '/artifact-reference-fixture';
$copy_directory( $bundle_dir, $reference_fixture_root . '/runtime-test' );
$reference_metadata = $metadata;
$reference_metadata['artifacts']['patch'] = 'files/missing.diff';
file_put_contents( $reference_fixture_root . '/runtime-test/metadata.json', json_encode( $reference_metadata, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES ) . "\n" );
$refresh_manifest_hashes( $reference_fixture_root . '/runtime-test' );
$reference_failure = WP_Codebox_Data_Machine_Pending_Actions::stage_apply_artifact(
	array(
		'artifacts_path' => $reference_fixture_root,
		'artifact_id'    => $artifact_id,
		'approved_files' => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
	)
);
$assert( 'pending artifact apply rejects malformed references before staging', is_wp_error( $reference_failure ) && 'wp_codebox_artifact_verification_failed' === $reference_failure->get_error_code() && in_array( 'malformed-reference', $violation_codes( $reference_failure ), true ) && 'https://github.com/chubes4/wp-codebox/issues/176' === ( $reference_failure->get_error_data()['issue_url'] ?? '' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_apply_approved_artifact'] = function ( mixed $value, array $payload ): array {
	return array(
		'schema'          => 'wp-codebox/apply-result/v1',
		'adapter'         => 'test-adapter',
		'status'          => 'pr-opened',
		'target'          => is_array( $payload['apply_target'] ?? null ) ? $payload['apply_target'] : array( 'repo' => 'chubes4/wp-codebox' ),
		'applied_files'   => array( 'generated.txt' ),
		'commit'          => 'abc1234',
		'pr_url'          => 'https://github.com/chubes4/wp-codebox/pull/999',
		'audit_reference' => 'external-apply-record:test-999',
		'patch'           => $payload['patch'],
		'access_token'    => 'secret-token-value',
	);
};
$applied = $artifacts->apply_approved(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
		'approver'        => 'site-user:1',
		'apply_target'    => array(
			'repo'   => 'chubes4/wp-codebox',
			'branch' => 'codebox/test-adapter',
		),
	)
);
$assert( 'approved artifact apply returns typed adapter result', ! is_wp_error( $applied ) && 'wp-codebox/apply-result/v1' === ( $applied['result']['schema'] ?? '' ) && 'test-adapter' === ( $applied['result']['adapter'] ?? '' ) && 'pr-opened' === ( $applied['result']['status'] ?? '' ) && array( 'generated.txt' ) === ( $applied['result']['applied_files'] ?? array() ) && array( 'repo' => 'chubes4/wp-codebox', 'branch' => 'codebox/test-adapter' ) === ( $applied['result']['target'] ?? array() ) && hash( 'sha256', $approved_patch_diff ) === ( $applied['patch_sha256'] ?? '' ) && $content_digest === ( $applied['content_digest'] ?? '' ) );

$captured_stage_args = array();
$GLOBALS['wp_codebox_filters']['wp_codebox_stage_pending_apply_artifact'] = function ( mixed $value, array $stage_args ) use ( &$captured_stage_args ): array {
	$captured_stage_args = $stage_args;
	return array(
		'staged'    => true,
		'action_id' => 'act_test',
		'payload'   => array(
			'pending_action' => array(
				'kind'        => $stage_args['kind'],
				'apply_input' => $stage_args['apply_input'],
				'preview'     => $stage_args['preview_data'],
			),
		),
	);
};
$staged = WP_Codebox_Data_Machine_Pending_Actions::stage_apply_artifact(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt', '' ),
		'approver'        => 'site-user:1',
		'apply_target'    => array( 'repo' => 'chubes4/wp-codebox' ),
		'context'         => array( 'session_id' => 'chat-123' ),
	)
);
$assert( 'pending artifact apply can be staged', ! is_wp_error( $staged ) && true === ( $staged['staged'] ?? false ) && WP_Codebox_Data_Machine_Pending_Actions::KIND === ( $captured_stage_args['kind'] ?? '' ) );
$assert( 'pending artifact apply stores exact apply input', $artifact_id === ( $captured_stage_args['apply_input']['artifact_id'] ?? '' ) && array( '/wordpress/wp-content/plugins/example/generated.txt' ) === ( $captured_stage_args['apply_input']['approved_files'] ?? array() ) && array( 'repo' => 'chubes4/wp-codebox' ) === ( $captured_stage_args['apply_input']['apply_target'] ?? array() ) );
$assert( 'pending artifact apply preview includes review and changed files', 'wp-codebox/pending-apply-preview/v1' === ( $captured_stage_args['preview_data']['schema'] ?? '' ) && 'wp-codebox/artifact-review/v1' === ( $captured_stage_args['preview_data']['review']['schema'] ?? '' ) && 'wp-codebox/changed-files/v1' === ( $captured_stage_args['preview_data']['changed_files']['schema'] ?? '' ) );
$assert( 'pending artifact apply preview includes successful bundle verification', true === ( $captured_stage_args['preview_data']['verification']['valid'] ?? false ) && 'wp-codebox/artifact-bundle-verification/v1' === ( $captured_stage_args['preview_data']['verification']['schema'] ?? '' ) );

$handlers = apply_filters( 'datamachine_pending_action_handlers', array() );
$assert( 'pending artifact apply handler registers with Data Machine', isset( $handlers[ WP_Codebox_Data_Machine_Pending_Actions::KIND ]['apply'] ) && is_callable( $handlers[ WP_Codebox_Data_Machine_Pending_Actions::KIND ]['apply'] ) );
$pending_handler_result = call_user_func(
	$handlers[ WP_Codebox_Data_Machine_Pending_Actions::KIND ]['apply'],
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
		'approver'        => 'site-user:1',
	)
);
$assert( 'pending artifact apply handler delegates to approved artifact apply', ! is_wp_error( $pending_handler_result ) && true === ( $pending_handler_result['success'] ?? false ) && $artifact_id === ( $pending_handler_result['artifact_id'] ?? '' ) );

$audit_path      = $artifact_root . '/apply-audit.jsonl';
$audit_lines     = is_file( $audit_path ) ? array_values( array_filter( explode( "\n", trim( (string) file_get_contents( $audit_path ) ) ) ) ) : array();
$success_audit   = isset( $audit_lines[0] ) ? json_decode( $audit_lines[0], true ) : array();
$success_encoded = isset( $audit_lines[0] ) ? $audit_lines[0] : '';
$assert( 'approved artifact apply writes success audit record', is_array( $success_audit ) && 'wp-codebox/apply-audit/v1' === ( $success_audit['schema'] ?? '' ) && 'success' === ( $success_audit['status'] ?? '' ) );
$assert( 'success audit records reviewed principals and files', 'chat:user-7' === ( $success_audit['requester'] ?? '' ) && 'site-user:1' === ( $success_audit['approver'] ?? '' ) && array( '/wordpress/wp-content/plugins/example/generated.txt' ) === ( $success_audit['approved_files'] ?? array() ) );
$assert( 'success audit records applied patch digest and adapter metadata', $artifact_id === ( $success_audit['artifact_id'] ?? '' ) && $content_digest === ( $success_audit['content_digest'] ?? '' ) && hash( 'sha256', $approved_patch_diff ) === ( $success_audit['patch_sha256'] ?? '' ) && 'test-adapter' === ( $success_audit['adapter'] ?? '' ) && 'https://github.com/chubes4/wp-codebox/pull/999' === ( $success_audit['result']['pr_url'] ?? '' ) );
$assert( 'success audit excludes raw patch body and secrets', ! str_contains( $success_encoded, 'diff --git' ) && ! str_contains( $success_encoded, 'secret-token-value' ) && ! array_key_exists( 'patch', $success_audit['result'] ?? array() ) && ! array_key_exists( 'access_token', $success_audit['result'] ?? array() ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_apply_approved_artifact'] = function (): array {
	return array(
		'adapter' => 'malformed-adapter',
		'pr_url'  => 'https://github.com/chubes4/wp-codebox/pull/998',
	);
};
$malformed_apply = $artifacts->apply_approved(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
		'approver'        => 'site-user:3',
	)
);
$audit_lines      = is_file( $audit_path ) ? array_values( array_filter( explode( "\n", trim( (string) file_get_contents( $audit_path ) ) ) ) ) : array();
$malformed_audit  = isset( $audit_lines[2] ) ? json_decode( $audit_lines[2], true ) : array();
$assert( 'approved artifact rejects malformed adapter result', is_wp_error( $malformed_apply ) && 'wp_codebox_apply_result_invalid' === $malformed_apply->get_error_code() && is_array( $malformed_audit ) && 'failure' === ( $malformed_audit['status'] ?? '' ) && 'wp_codebox_apply_result_invalid' === ( $malformed_audit['error']['code'] ?? '' ) );

$GLOBALS['wp_codebox_filters']['wp_codebox_apply_approved_artifact'] = function (): WP_Error {
	return new WP_Error( 'wp_codebox_adapter_failed', 'Adapter failed to apply artifact.', array( 'status' => 502, 'adapter' => 'test-adapter', 'patch' => 'diff --git should not persist', 'password' => 'secret-password-value' ) );
};
$failed_apply = $artifacts->apply_approved(
	array(
		'artifacts_path'  => $artifact_root,
		'artifact_id'     => $artifact_id,
		'approved_files'  => array( '/wordpress/wp-content/plugins/example/generated.txt' ),
		'approver'        => 'site-user:2',
	)
);
$audit_lines   = is_file( $audit_path ) ? array_values( array_filter( explode( "\n", trim( (string) file_get_contents( $audit_path ) ) ) ) ) : array();
$failure_audit = isset( $audit_lines[3] ) ? json_decode( $audit_lines[3], true ) : array();
$failure_encoded = isset( $audit_lines[3] ) ? $audit_lines[3] : '';
$assert( 'approved artifact apply writes adapter failure audit record', is_wp_error( $failed_apply ) && is_array( $failure_audit ) && 'failure' === ( $failure_audit['status'] ?? '' ) && 'test-adapter' === ( $failure_audit['adapter'] ?? '' ) && 'wp_codebox_adapter_failed' === ( $failure_audit['error']['code'] ?? '' ) );
$assert( 'failure audit records approver and excludes raw patch body and secrets', 'site-user:2' === ( $failure_audit['approver'] ?? '' ) && ! str_contains( $failure_encoded, 'diff --git' ) && ! str_contains( $failure_encoded, 'secret-password-value' ) && '[redacted]' === ( $failure_audit['error']['data']['patch'] ?? '' ) && '[redacted]' === ( $failure_audit['error']['data']['password'] ?? '' ) );

$unknown_apply = $artifacts->apply_approved(
	array(
		'artifacts_path' => $artifact_root,
		'artifact_id'    => $artifact_id,
		'approved_files' => array( '/wordpress/wp-content/plugins/example/unknown.txt' ),
	)
);
$assert( 'approved artifact rejects unknown files', is_wp_error( $unknown_apply ) && 'wp_codebox_approved_files_invalid' === $unknown_apply->get_error_code() );

$discarded = $artifacts->discard(
	array(
		'artifacts_path' => $artifact_root,
		'artifact_id'    => $artifact_id,
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
