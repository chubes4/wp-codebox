<?php
/**
 * Canonical WP Codebox task input contract.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Task_Input_Contract {

	public const SCHEMA  = 'wp-codebox/task-input/v1';
	public const VERSION = 1;

	/** @return array<string,mixed> */
	public static function schema(): array {
		return array(
			'$id'        => self::SCHEMA,
			'type'       => 'object',
			'required'   => array( 'schema', 'version', 'goal', 'target', 'allowed_tools', 'expected_artifacts', 'policy', 'context' ),
			'properties' => array(
				'schema'             => array(
					'const'       => self::SCHEMA,
					'description' => 'Task input contract schema id.',
				),
				'version'            => array(
					'const'       => self::VERSION,
					'description' => 'Task input contract version.',
				),
				'goal'               => array(
					'type'        => 'string',
					'description' => 'User-facing outcome the sandboxed coding agent should accomplish.',
				),
				'target'             => array(
					'type'        => 'object',
					'description' => 'Bounded target for the task, such as a repo, site, plugin, or theme.',
					'properties'  => array(
						'kind' => array( 'type' => 'string' ),
						'ref'  => array( 'type' => 'string' ),
						'path' => array( 'type' => 'string' ),
						'url'  => array( 'type' => 'string' ),
					),
				),
				'allowed_tools'      => array(
					'type'        => 'array',
					'description' => 'Tool names the product caller expects the sandboxed agent to stay within.',
					'items'       => array( 'type' => 'string' ),
				),
				'expected_artifacts' => array(
					'type'        => 'array',
					'description' => 'Artifact kinds the caller wants back, such as patch, review, tests, preview, or package.',
					'items'       => array( 'type' => 'string' ),
				),
				'policy'             => array(
					'type'        => 'object',
					'description' => 'Caller policy hints for approvals, apply-back, sandboxing, and risk controls.',
				),
				'context'            => array(
					'type'        => 'object',
					'description' => 'Additional non-secret caller context for the sandboxed task.',
				),
			),
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public static function normalize( array $input ): array|WP_Error {
		$goal = trim( (string) ( $input['goal'] ?? $input['task'] ?? '' ) );
		if ( '' === $goal ) {
			return new WP_Error( 'wp_codebox_task_missing', 'goal or task is required.', array( 'status' => 400 ) );
		}

		return array(
			'schema'             => self::SCHEMA,
			'version'            => self::VERSION,
			'goal'               => $goal,
			'target'             => is_array( $input['target'] ?? null ) ? $input['target'] : array(),
			'allowed_tools'      => self::string_list( $input['allowed_tools'] ?? array() ),
			'expected_artifacts' => self::string_list( $input['expected_artifacts'] ?? array() ),
			'policy'             => is_array( $input['policy'] ?? null ) ? $input['policy'] : array(),
			'context'            => is_array( $input['context'] ?? null ) ? $input['context'] : array(),
		);
	}

	/** @return string[] */
	private static function string_list( mixed $value ): array {
		if ( ! is_array( $value ) ) {
			return array();
		}

		$items = array();
		foreach ( $value as $item ) {
			$item = trim( (string) $item );
			if ( '' !== $item && ! in_array( $item, $items, true ) ) {
				$items[] = $item;
			}
		}

		return $items;
	}
}
