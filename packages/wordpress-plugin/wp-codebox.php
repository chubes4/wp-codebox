<?php
/**
 * Plugin Name: WP Codebox
 * Plugin URI: https://github.com/chubes4/wp-codebox
 * Description: WordPress ability surface for launching isolated WP Codebox agent sandboxes.
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
require_once __DIR__ . '/src/class-wp-codebox-abilities.php';

add_action( 'plugins_loaded', static function (): void {
	new WP_Codebox_Abilities();
}, 20 );
