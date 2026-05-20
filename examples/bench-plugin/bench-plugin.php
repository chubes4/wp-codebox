<?php
/**
 * Plugin Name: Bench Plugin
 * Description: Fixture plugin for WP Codebox bench command smoke tests.
 * Version: 0.1.0
 */

defined( 'ABSPATH' ) || exit;

function wp_codebox_bench_plugin_value(): int {
	return 7;
}
