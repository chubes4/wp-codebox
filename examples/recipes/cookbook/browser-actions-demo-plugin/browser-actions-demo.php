<?php
/**
 * Plugin Name: WP Codebox Browser Actions Demo
 * Description: Vendor-neutral fixture for the wordpress.browser-actions cookbook
 *              example. Registers an admin page that renders a small, real
 *              React (@wordpress/element) interactive widget so the interaction
 *              probe has genuine behavior to drive and assert — not just static
 *              markup.
 * Version: 0.0.1
 */

if ( ! defined( 'WPINC' ) ) {
	die;
}

/**
 * Register a Tools submenu page that hosts the interactive demo widget.
 */
add_action( 'admin_menu', static function (): void {
	add_management_page(
		'Browser Actions Demo',
		'Browser Actions Demo',
		'edit_posts',
		'wp-codebox-browser-actions-demo',
		static function (): void {
			// The React app mounts into this root. The probe asserts against the
			// elements the app renders, proving the component actually works.
			echo '<div class="wrap"><h1>Browser Actions Demo</h1>';
			echo '<div id="wpcb-browser-actions-demo-root"></div>';
			echo '</div>';
		}
	);
} );

/**
 * Enqueue the inline React widget on our demo page only.
 *
 * Uses @wordpress/element (the React WordPress already ships) so this fixture
 * needs no build step: the recipe can mount the plugin directory as-is.
 */
add_action( 'admin_enqueue_scripts', static function ( string $hook ): void {
	if ( 'tools_page_wp-codebox-browser-actions-demo' !== $hook ) {
		return;
	}

	wp_enqueue_script( 'wp-element' );

	$script = <<<'JS'
( function ( el, render, useState ) {
	var e = el.createElement;

	function Demo() {
		var countState = useState( 0 );
		var count = countState[0];
		var setCount = countState[1];

		var sliderState = useState( 50 );
		var slider = sliderState[0];
		var setSlider = sliderState[1];

		return e(
			'div',
			{ className: 'wpcb-demo', style: { maxWidth: 480 } },
			e( 'p', null, 'A real React component. The interaction probe drives it.' ),
			e(
				'div',
				{ className: 'wpcb-counter' },
				e(
					'button',
					{
						type: 'button',
						className: 'button button-primary wpcb-increment',
						onClick: function () { setCount( count + 1 ); }
					},
					'Increment'
				),
				e(
					'span',
					{ className: 'wpcb-count', 'data-count': String( count ), style: { marginLeft: 12 } },
					'Count: ' + count
				)
			),
			e(
				'div',
				{ className: 'wpcb-slider-row', style: { marginTop: 16 } },
				e( 'label', { htmlFor: 'wpcb-slider' }, 'Value' ),
				e( 'input', {
					id: 'wpcb-slider',
					className: 'wpcb-slider',
					type: 'range',
					min: 0,
					max: 100,
					value: slider,
					onChange: function ( ev ) { setSlider( Number( ev.target.value ) ); }
				} ),
				e(
					'output',
					{ className: 'wpcb-slider-value', 'data-value': String( slider ) },
					String( slider )
				)
			),
			count >= 3
				? e( 'p', { className: 'wpcb-threshold' }, 'Threshold reached: clicked at least 3 times.' )
				: null
		);
	}

	render( e( Demo ), document.getElementById( 'wpcb-browser-actions-demo-root' ) );
} )( window.wp.element, window.wp.element.render, window.wp.element.useState );
JS;

	wp_add_inline_script( 'wp-element', $script );
} );
