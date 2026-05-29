<?php
/**
 * WP-CLI adapter for WP Codebox public API operations.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_CLI_Command {

	/** Register focused `wp codebox ...` commands. */
	public static function register(): void {
		$command = new self();

		\WP_CLI::add_command( 'codebox artifacts list', array( $command, 'artifacts_list' ) );
		\WP_CLI::add_command( 'codebox artifacts get', array( $command, 'artifacts_get' ) );
		\WP_CLI::add_command( 'codebox artifacts stage-apply', array( $command, 'artifacts_stage_apply' ) );
		\WP_CLI::add_command( 'codebox artifacts apply', array( $command, 'artifacts_apply' ) );
		\WP_CLI::add_command( 'codebox browser-session create', array( $command, 'browser_session_create' ) );
		\WP_CLI::add_command( 'codebox run-agent-task', array( $command, 'run_agent_task' ) );
	}

	/**
	 * List artifact bundles.
	 *
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associated arguments.
	 */
	public function artifacts_list( array $args, array $assoc_args ): void {
		unset( $args );
		$this->emit( WP_Codebox_Abilities::list_artifacts( $this->input_from_args( $assoc_args ) ), $assoc_args );
	}

	/**
	 * Read one artifact bundle.
	 *
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associated arguments.
	 */
	public function artifacts_get( array $args, array $assoc_args ): void {
		$this->emit( WP_Codebox_Abilities::get_artifact( $this->artifact_input( $args, $assoc_args ) ), $assoc_args );
	}

	/**
	 * Stage a reviewed artifact apply through Data Machine pending actions.
	 *
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associated arguments.
	 */
	public function artifacts_stage_apply( array $args, array $assoc_args ): void {
		$this->emit( WP_Codebox_Abilities::stage_artifact_apply( $this->apply_input( $args, $assoc_args ) ), $assoc_args );
	}

	/**
	 * Apply a reviewed artifact through the configured apply-back adapter.
	 *
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associated arguments.
	 */
	public function artifacts_apply( array $args, array $assoc_args ): void {
		$this->emit( WP_Codebox_Abilities::apply_approved_artifact( $this->apply_input( $args, $assoc_args ) ), $assoc_args );
	}

	/**
	 * Create a browser-executed Playground session payload.
	 *
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associated arguments.
	 */
	public function browser_session_create( array $args, array $assoc_args ): void {
		unset( $args );
		$this->emit( WP_Codebox_Abilities::create_browser_playground_session( $this->input_from_args( $assoc_args ) ), $assoc_args );
	}

	/**
	 * Run a bounded task inside an isolated WP Codebox agent sandbox.
	 *
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associated arguments.
	 */
	public function run_agent_task( array $args, array $assoc_args ): void {
		unset( $args );
		$this->emit( WP_Codebox_Abilities::run_agent_task( $this->input_from_args( $assoc_args ) ), $assoc_args );
	}

	/**
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associated arguments.
	 * @return array<string,mixed>
	 */
	private function artifact_input( array $args, array $assoc_args ): array {
		$input                = $this->input_from_args( $assoc_args );
		$input['artifact_id'] = (string) ( $args[0] ?? $input['artifact_id'] ?? '' );

		return $input;
	}

	/**
	 * @param array<int,string>   $args       Positional arguments.
	 * @param array<string,mixed> $assoc_args Associated arguments.
	 * @return array<string,mixed>
	 */
	private function apply_input( array $args, array $assoc_args ): array {
		$input = $this->artifact_input( $args, $assoc_args );
		if ( isset( $assoc_args['approved-files'] ) ) {
			$input['approved_files'] = $this->string_list( $assoc_args['approved-files'] );
		}

		return $input;
	}

	/**
	 * @param array<string,mixed> $assoc_args Associated arguments.
	 * @return array<string,mixed>
	 */
	private function input_from_args( array $assoc_args ): array {
		$input = array();

		if ( isset( $assoc_args['input-file'] ) ) {
			$input = array_merge( $input, $this->json_file( (string) $assoc_args['input-file'] ) );
		}

		if ( isset( $assoc_args['input-json'] ) ) {
			$input = array_merge( $input, $this->json_object( (string) $assoc_args['input-json'], 'input-json' ) );
		}

		foreach ( $assoc_args as $key => $value ) {
			if ( in_array( $key, array( 'format', 'input-file', 'input-json' ), true ) ) {
				continue;
			}

			$field           = str_replace( '-', '_', (string) $key );
			$input[ $field ] = $this->normalize_value( $field, $value );
		}

		return $input;
	}

	private function normalize_value( string $field, mixed $value ): mixed {
		if ( in_array( $field, array( 'target', 'policy', 'context', 'inherit', 'orchestrator', 'playground', 'browser_runner', 'blueprint', 'apply_target' ), true ) ) {
			return $this->json_object( (string) $value, $field );
		}

		if ( in_array( $field, array( 'allowed_tools', 'expected_artifacts', 'provider_plugin_paths', 'secret_env', 'browser_plugins', 'artifact_files', 'approved_files' ), true ) ) {
			return $this->json_or_list( (string) $value, $field );
		}

		if ( in_array( $field, array( 'max_turns', 'preview_hold_seconds', 'preview_port', 'agent_id', 'user_id' ), true ) ) {
			return (int) $value;
		}

		return $value;
	}

	/** @return array<string,mixed> */
	private function json_file( string $path ): array {
		$contents = is_readable( $path ) ? file_get_contents( $path ) : false;
		if ( false === $contents ) {
			\WP_CLI::error( 'Input file is not readable: ' . $path );
		}

		return $this->json_object( (string) $contents, 'input-file' );
	}

	/** @return array<string,mixed> */
	private function json_object( string $json, string $field ): array {
		$decoded = json_decode( $json, true );
		if ( ! is_array( $decoded ) || array_is_list( $decoded ) ) {
			\WP_CLI::error( $field . ' must be a JSON object.' );
		}

		return $decoded;
	}

	/** @return array<int,mixed> */
	private function json_or_list( string $value, string $field ): array {
		$trimmed = trim( $value );
		if ( str_starts_with( $trimmed, '[' ) ) {
			$decoded = json_decode( $trimmed, true );
			if ( ! is_array( $decoded ) || ! array_is_list( $decoded ) ) {
				\WP_CLI::error( $field . ' must be a JSON array.' );
			}

			return $decoded;
		}

		return $this->string_list( $value );
	}

	/** @return string[] */
	private function string_list( mixed $value ): array {
		$items = is_array( $value ) ? $value : explode( ',', (string) $value );

		return array_values(
			array_filter(
				array_map( static fn( mixed $item ): string => trim( (string) $item ), $items ),
				static fn( string $item ): bool => '' !== $item
			)
		);
	}

	/** @param array<string,mixed>|WP_Error $result Service result. */
	private function emit( array|WP_Error $result, array $assoc_args ): void {
		if ( is_wp_error( $result ) ) {
			\WP_CLI::error( $result->get_error_message() );
		}

		$format = (string) ( $assoc_args['format'] ?? 'json' );
		if ( 'json' !== $format ) {
			\WP_CLI::warning( 'WP Codebox WP-CLI wrappers currently emit JSON; ignoring --format=' . $format . '.' );
		}

		\WP_CLI::line( $this->json_encode( $result ) );
	}

	/** @param array<string,mixed> $data Data to encode. */
	private function json_encode( array $data ): string {
		if ( function_exists( 'wp_json_encode' ) ) {
			$encoded = wp_json_encode( $data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
		} else {
			$encoded = json_encode( $data, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
		}

		return false === $encoded ? '{}' : (string) $encoded;
	}
}
