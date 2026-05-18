<?php
/**
 * Plugin Name: Sandbox Runtime
 * Plugin URI: https://github.com/chubes4/sandbox-runtime
 * Description: WordPress ability surface for launching isolated Sandbox Runtime agent sandboxes.
 * Version: 0.1.0
 * Requires at least: 6.9
 * Requires PHP: 8.2
 * Author: Chris Huber
 * License: GPL-2.0-or-later
 * Text Domain: sandbox-runtime
 */

if ( ! defined( 'WPINC' ) ) {
	die;
}

define( 'SANDBOX_RUNTIME_PLUGIN_VERSION', '0.1.0' );
define( 'SANDBOX_RUNTIME_PLUGIN_PATH', plugin_dir_path( __FILE__ ) );

require_once __DIR__ . '/src/class-sandbox-runtime-agent-sandbox-runner.php';
require_once __DIR__ . '/src/class-sandbox-runtime-abilities.php';

add_action( 'plugins_loaded', static function (): void {
	new Sandbox_Runtime_Abilities();
}, 20 );
