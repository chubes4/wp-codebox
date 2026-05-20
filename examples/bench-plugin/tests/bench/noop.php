<?php

return static function (): array {
	return array(
		'metrics'  => array(
			'fixture_value' => wp_codebox_bench_plugin_value(),
		),
		'metadata' => array(
			'fixture' => 'bench-plugin',
		),
	);
};
