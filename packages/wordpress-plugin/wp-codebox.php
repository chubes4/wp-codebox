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
define( 'WP_CODEBOX_PLUGIN_URL', plugin_dir_url( __FILE__ ) );

require_once __DIR__ . '/src/class-wp-codebox-task-input-contract.php';
require_once __DIR__ . '/src/class-wp-codebox-agent-task.php';
require_once __DIR__ . '/src/class-wp-codebox-agent-sandbox-runner.php';
require_once __DIR__ . '/src/class-wp-codebox-artifacts.php';
require_once __DIR__ . '/src/class-wp-codebox-data-machine-pending-actions.php';
require_once __DIR__ . '/src/class-wp-codebox-preview-options.php';
require_once __DIR__ . '/src/class-wp-codebox-abilities.php';

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	require_once __DIR__ . '/src/class-wp-codebox-cli-command.php';
}

new WP_Codebox_Abilities();

if ( defined( 'WP_CLI' ) && WP_CLI ) {
	WP_Codebox_CLI_Command::register();
}

add_action( 'plugins_loaded', static function (): void {
	new WP_Codebox_Data_Machine_Pending_Actions();
}, 20 );

add_action(
	'wp_enqueue_scripts',
	static function (): void {
		$script = WP_CODEBOX_PLUGIN_PATH . 'assets/browser-runtime.js';
		if ( ! file_exists( $script ) ) {
			return;
		}

		wp_register_script(
			'wp-codebox-browser-runtime',
			WP_CODEBOX_PLUGIN_URL . 'assets/browser-runtime.js',
			array(),
			(string) filemtime( $script ),
			array( 'in_footer' => true )
		);
	}
);
