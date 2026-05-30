<?php
/**
 * Browser Actions Demo cookbook seed.
 *
 * Activates the mounted vendor-neutral demo plugin and auto-logs in as admin so
 * the interaction probe can navigate straight to the demo's Tools page and
 * drive its real React widget.
 *
 * Output: JSON with the demo page URL the wordpress.browser-actions step
 * navigates to.
 */

require_once ABSPATH . 'wp-admin/includes/plugin.php';

$demo_plugin = null;
foreach ( get_plugins( '/browser-actions-demo' ) as $plugin_file => $plugin_data ) {
	if ( ! empty( $plugin_data['Name'] ) ) {
		$demo_plugin = 'browser-actions-demo/' . $plugin_file;
		break;
	}
}

if ( $demo_plugin && ! is_plugin_active( $demo_plugin ) ) {
	$result = activate_plugin( $demo_plugin );
	if ( is_wp_error( $result ) ) {
		throw new RuntimeException( $result->get_error_message() );
	}
}

// Auto-login admin so the admin demo page is authorized.
wp_set_auth_cookie( 1, true );

echo wp_json_encode( array(
	'demo_plugin'        => $demo_plugin,
	'demo_active'        => $demo_plugin ? is_plugin_active( $demo_plugin ) : false,
	'demo_url'           => admin_url( 'tools.php?page=wp-codebox-browser-actions-demo' ),
	'demo_url_relative'  => '/wp-admin/tools.php?page=wp-codebox-browser-actions-demo',
	'admin_url'          => admin_url(),
	'home_url'           => home_url( '/' ),
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
echo "\n";
