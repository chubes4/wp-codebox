<?php
/**
 * Plugin Name: WP Codebox
 * Plugin URI: https://github.com/chubes4/wp-codebox
 * Description: Secure coding environments inside WordPress. WordPress ability surface for launching disposable WP Codebox Playground sandboxes that can't touch your host site.
 * Version: 0.1.0
 * Requires at least: 6.9
 * Requires PHP: 8.2
 * Author: Chris Huber
 * License: GPL-2.0-or-later
 * Text Domain: wp-codebox
 */

if ( ! defined( 'WPINC' ) ) {
	die;
}

define( 'WP_CODEBOX_PLUGIN_VERSION', '0.1.0' );
define( 'WP_CODEBOX_PLUGIN_PATH', plugin_dir_path( __FILE__ ) );

require_once __DIR__ . '/src/class-wp-codebox-agent-sandbox-runner.php';
require_once __DIR__ . '/src/class-wp-codebox-artifacts.php';
require_once __DIR__ . '/src/class-wp-codebox-data-machine-pending-actions.php';
require_once __DIR__ . '/src/class-wp-codebox-abilities.php';

add_action( 'plugins_loaded', static function (): void {
	new WP_Codebox_Data_Machine_Pending_Actions();
	new WP_Codebox_Abilities();
}, 20 );
