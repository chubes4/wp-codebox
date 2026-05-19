<?php
/**
 * Import a mounted Data Machine agent bundle inside a WP Codebox sandbox.
 */

$bundle_path = getenv( 'WP_CODEBOX_DATAMACHINE_BUNDLE' ) ?: '/wordpress/wp-content/wp-codebox-inputs/datamachine-bundle';

require_once ABSPATH . 'wp-admin/includes/plugin.php';

add_filter( 'datamachine_should_load_full_runtime', '__return_true' );

foreach ( array( 'agents-api/agents-api.php', 'data-machine/data-machine.php' ) as $plugin ) {
	$plugin_file = WP_PLUGIN_DIR . '/' . $plugin;
	if ( ! file_exists( $plugin_file ) ) {
		throw new RuntimeException( sprintf( 'Required plugin is not mounted: %s', $plugin ) );
	}

	if ( ! is_plugin_active( $plugin ) ) {
		$result = activate_plugin( $plugin );
		if ( is_wp_error( $result ) ) {
			throw new RuntimeException( $result->get_error_message() );
		}
	}
}

if ( function_exists( 'datamachine_run_datamachine_plugin' ) ) {
	datamachine_run_datamachine_plugin();
}

wp_set_current_user( 1 );

if ( ! function_exists( 'wp_get_ability' ) ) {
	throw new RuntimeException( 'The WordPress Abilities API is not available in this runtime.' );
}

$ability = wp_get_ability( 'datamachine/import-agent' );
if ( ! $ability ) {
	throw new RuntimeException( 'The datamachine/import-agent ability is not registered.' );
}

$result = $ability->execute(
	array(
		'source'      => $bundle_path,
		'on_conflict' => 'upgrade',
		'owner_id'    => 1,
	)
);

if ( is_wp_error( $result ) ) {
	throw new RuntimeException( $result->get_error_message() );
}

echo wp_json_encode(
	array(
		'command'     => 'import-datamachine-agent-bundle',
		'bundle_path' => $bundle_path,
		'result'      => $result,
	),
	JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES
);
