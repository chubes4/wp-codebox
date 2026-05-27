<?php
/**
 * Parent-site WP Codebox artifact store and apply contract.
 *
 * @package WPCodebox
 */

defined( 'ABSPATH' ) || exit;

final class WP_Codebox_Artifacts {

	private const LIST_SCHEMA  = 'wp-codebox/artifact-list/v1';
	private const GET_SCHEMA   = 'wp-codebox/artifact/v1';
	private const APPLY_SCHEMA = 'wp-codebox/artifact-apply/v1';
	private const APPLY_AUDIT_SCHEMA = 'wp-codebox/apply-audit/v1';
	private const CONTENT_DIGEST_PREFIX = "wp-codebox/artifact-content/v1\nfiles/changed-files.json\n";
	private const CONTENT_DIGEST_SEPARATOR = "\nfiles/patch.diff\n";

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function list( array $input = array() ): array|WP_Error {
		$root = $this->artifact_root( $input );
		if ( is_wp_error( $root ) ) {
			return $root;
		}

		$bundles = array();
		foreach ( $this->find_manifest_paths( $root ) as $manifest_path ) {
			$bundle = $this->read_bundle_at_manifest( $manifest_path, false );
			if ( ! is_wp_error( $bundle ) ) {
				$bundles[] = $bundle;
			}
		}

		usort(
			$bundles,
			static fn( array $a, array $b ): int => strcmp( (string) ( $b['created_at'] ?? '' ), (string) ( $a['created_at'] ?? '' ) )
		);

		return array(
			'success'   => true,
			'schema'    => self::LIST_SCHEMA,
			'root'      => $root,
			'artifacts' => $bundles,
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function get( array $input ): array|WP_Error {
		$bundle = $this->resolve_bundle( $input );
		if ( is_wp_error( $bundle ) ) {
			return $bundle;
		}

		return array(
			'success'  => true,
			'schema'   => self::GET_SCHEMA,
			'artifact' => $bundle,
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function discard( array $input ): array|WP_Error {
		$bundle = $this->resolve_bundle( $input );
		if ( is_wp_error( $bundle ) ) {
			return $bundle;
		}

		$directory = (string) $bundle['directory'];
		$root      = $this->artifact_root( $input );
		if ( is_wp_error( $root ) ) {
			return $root;
		}

		if ( ! $this->path_is_inside( $directory, $root ) ) {
			return new WP_Error( 'wp_codebox_artifact_outside_root', 'Artifact directory is outside the configured artifact root.', array( 'status' => 400 ) );
		}

		$this->remove_directory( $directory );

		return array(
			'success'     => true,
			'schema'      => self::GET_SCHEMA,
			'artifact_id' => (string) $bundle['id'],
			'discarded'   => true,
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	public function apply_approved( array $input ): array|WP_Error {
		$bundle = $this->resolve_bundle( $input );
		if ( is_wp_error( $bundle ) ) {
			return $bundle;
		}

		$root = $this->artifact_root( $input );
		if ( is_wp_error( $root ) ) {
			return $root;
		}

		$approved_files = $this->approved_files( $input );
		if ( empty( $approved_files ) ) {
			return new WP_Error( 'wp_codebox_approved_files_missing', 'approved_files must include at least one sandbox path.', array( 'status' => 400 ) );
		}

		$changed_files = $bundle['changed_files']['files'] ?? array();
		if ( ! is_array( $changed_files ) ) {
			return new WP_Error( 'wp_codebox_changed_files_invalid', 'Artifact changed-files payload is invalid.', array( 'status' => 400 ) );
		}

		$changed_paths = array_values(
			array_filter(
				array_map(
					static fn( $file ): string => is_array( $file ) ? (string) ( $file['path'] ?? '' ) : '',
					$changed_files
				)
			)
		);

		$unknown_files = array_values( array_diff( $approved_files, $changed_paths ) );
		if ( ! empty( $unknown_files ) ) {
			return new WP_Error(
				'wp_codebox_approved_files_invalid',
				'approved_files contains paths that are not present in changed-files.json.',
				array(
					'status' => 400,
					'files'  => $unknown_files,
				)
			);
		}

		$patch_path = (string) ( $bundle['paths']['patch'] ?? '' );
		$patch      = '' !== $patch_path && is_file( $patch_path ) ? file_get_contents( $patch_path ) : false;
		if ( false === $patch || '' === trim( $patch ) ) {
			return new WP_Error( 'wp_codebox_patch_missing', 'Artifact patch.diff is missing or empty.', array( 'status' => 400 ) );
		}

		$patch = $this->filter_patch_to_approved_files( $patch, $changed_files, $approved_files );
		if ( is_wp_error( $patch ) ) {
			return $patch;
		}

		$content_digest = $this->artifact_content_digest( $bundle );
		if ( is_wp_error( $content_digest ) ) {
			return $content_digest;
		}

		$payload = array(
			'artifact_id'             => (string) $bundle['id'],
			'artifact'                => $bundle,
			'approved_files'          => $approved_files,
			'approver'                => $input['approver'] ?? null,
			'patch'                   => $patch,
			'patch_sha256'            => hash( 'sha256', $patch ),
			'artifact_content_digest' => $content_digest,
		);

		$result = apply_filters( 'wp_codebox_apply_approved_artifact', null, $payload );
		if ( null === $result ) {
			$this->record_apply_audit( $root, $bundle, $approved_files, $payload, null, new WP_Error( 'wp_codebox_apply_adapter_missing', 'No apply-back adapter handled this approved artifact.', array( 'status' => 501 ) ) );
			return new WP_Error( 'wp_codebox_apply_adapter_missing', 'No apply-back adapter handled this approved artifact.', array( 'status' => 501 ) );
		}

		if ( is_wp_error( $result ) ) {
			$this->record_apply_audit( $root, $bundle, $approved_files, $payload, null, $result );
			return $result;
		}

		$this->record_apply_audit( $root, $bundle, $approved_files, $payload, $result, null );

		return array(
			'success'        => true,
			'schema'         => self::APPLY_SCHEMA,
			'artifact_id'    => (string) $bundle['id'],
			'approved_files' => $approved_files,
			'patch_sha256'   => $payload['patch_sha256'],
			'content_digest' => $content_digest,
			'result'         => $result,
		);
	}

	/** @param array<string,mixed> $input Ability input. @return array<string,mixed>|WP_Error */
	private function resolve_bundle( array $input ): array|WP_Error {
		$artifact_id = trim( (string) ( $input['artifact_id'] ?? '' ) );
		if ( '' === $artifact_id ) {
			return new WP_Error( 'wp_codebox_artifact_id_missing', 'artifact_id is required.', array( 'status' => 400 ) );
		}

		$root = $this->artifact_root( $input );
		if ( is_wp_error( $root ) ) {
			return $root;
		}

		foreach ( $this->find_manifest_paths( $root ) as $manifest_path ) {
			$bundle = $this->read_bundle_at_manifest( $manifest_path, true );
			if ( ! is_wp_error( $bundle ) && $artifact_id === (string) $bundle['id'] ) {
				return $bundle;
			}
		}

		return new WP_Error( 'wp_codebox_artifact_not_found', 'Artifact bundle was not found under the configured artifact root.', array( 'status' => 404 ) );
	}

	/** @param array<string,mixed> $input Ability input. @return string|WP_Error */
	private function artifact_root( array $input ): string|WP_Error {
		$root = trim( (string) ( $input['artifacts_path'] ?? '' ) );
		if ( '' === $root ) {
			$root = trim( (string) $this->config_option( 'wp_codebox_artifacts_root', '' ) );
			if ( '' === $root ) {
				$base = function_exists( 'wp_upload_dir' ) ? wp_upload_dir() : array( 'basedir' => sys_get_temp_dir() );
				$root = is_array( $base ) && ! empty( $base['basedir'] ) ? (string) $base['basedir'] : sys_get_temp_dir();
				$root = rtrim( $root, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . 'wp-codebox';
			}
		}

		if ( function_exists( 'apply_filters' ) ) {
			$root = (string) apply_filters( 'wp_codebox_artifacts_root', $root, $input );
		}

		$real = realpath( $root );
		if ( false === $real || ! is_dir( $real ) ) {
			return new WP_Error( 'wp_codebox_artifacts_root_missing', 'Artifact root is missing or not a directory.', array( 'status' => 400 ) );
		}

		return rtrim( $real, DIRECTORY_SEPARATOR );
	}

	private function config_option( string $name, mixed $default ): mixed {
		if ( function_exists( 'is_multisite' ) && is_multisite() && function_exists( 'get_site_option' ) ) {
			return get_site_option( $name, $default );
		}

		if ( function_exists( 'get_option' ) ) {
			return get_option( $name, $default );
		}

		return $default;
	}

	/** @return string[] */
	private function find_manifest_paths( string $root ): array {
		$paths = glob( $root . DIRECTORY_SEPARATOR . 'manifest.json' ) ?: array();
		foreach ( glob( $root . DIRECTORY_SEPARATOR . '*' . DIRECTORY_SEPARATOR . 'manifest.json' ) ?: array() as $path ) {
			$paths[] = $path;
		}
		foreach ( glob( $root . DIRECTORY_SEPARATOR . '*' . DIRECTORY_SEPARATOR . '*' . DIRECTORY_SEPARATOR . 'manifest.json' ) ?: array() as $path ) {
			$paths[] = $path;
		}

		return array_values(
			array_filter(
				array_unique( $paths ),
				fn( string $path ): bool => $this->path_is_inside( $path, $root )
			)
		);
	}

	/** @return array<string,mixed>|WP_Error */
	private function read_bundle_at_manifest( string $manifest_path, bool $include_contents ): array|WP_Error {
		$directory = dirname( $manifest_path );
		$manifest  = $this->read_json_file( $manifest_path );
		if ( is_wp_error( $manifest ) ) {
			return $manifest;
		}

		$id = trim( (string) ( $manifest['id'] ?? '' ) );
		if ( '' === $id ) {
			return new WP_Error( 'wp_codebox_manifest_invalid', 'Artifact manifest is missing an id.', array( 'status' => 400 ) );
		}

		$paths = array(
			'manifest'      => $manifest_path,
			'metadata'      => $this->resolve_artifact_file( $directory, 'metadata.json' ),
			'changed_files' => $this->resolve_artifact_file( $directory, 'files/changed-files.json' ),
			'patch'         => $this->resolve_artifact_file( $directory, 'files/patch.diff' ),
			'test_results'  => $this->resolve_artifact_file( $directory, 'files/test-results.json' ),
			'review'        => $this->resolve_artifact_file( $directory, 'files/review.json' ),
		);

		$bundle = array(
			'id'                => $id,
			'content_digest'    => is_array( $manifest['contentDigest'] ?? null ) ? (string) ( $manifest['contentDigest']['value'] ?? '' ) : '',
			'created_at'        => (string) ( $manifest['createdAt'] ?? '' ),
			'directory'         => $directory,
			'paths'             => $paths,
			'has_patch'         => is_file( $paths['patch'] ),
			'has_changed_files' => is_file( $paths['changed_files'] ),
			'has_test_results'  => is_file( $paths['test_results'] ),
			'has_review'        => is_file( $paths['review'] ),
		);

		if ( ! $include_contents ) {
			return $bundle;
		}

		$metadata      = is_file( $paths['metadata'] ) ? $this->read_json_file( $paths['metadata'] ) : array();
		$changed_files = is_file( $paths['changed_files'] ) ? $this->read_json_file( $paths['changed_files'] ) : array();
		$test_results  = is_file( $paths['test_results'] ) ? $this->read_json_file( $paths['test_results'] ) : array();
		$review        = is_file( $paths['review'] ) ? $this->read_json_file( $paths['review'] ) : array();
		if ( is_wp_error( $metadata ) ) {
			return $metadata;
		}
		if ( is_wp_error( $changed_files ) ) {
			return $changed_files;
		}
		if ( is_wp_error( $test_results ) ) {
			return $test_results;
		}
		if ( is_wp_error( $review ) ) {
			return $review;
		}

		$content_digest = $this->artifact_content_digest( $bundle );
		if ( is_wp_error( $content_digest ) ) {
			return $content_digest;
		}

		$declared_digest = (string) ( $bundle['content_digest'] ?? '' );
		if ( '' === $declared_digest ) {
			return new WP_Error( 'wp_codebox_artifact_digest_missing', 'Artifact manifest is missing contentDigest.value.', array( 'status' => 400 ) );
		}

		if ( ! hash_equals( $declared_digest, $content_digest ) ) {
			return new WP_Error( 'wp_codebox_artifact_digest_mismatch', 'Artifact content digest does not match changed-files.json and patch.diff.', array( 'status' => 400 ) );
		}

		$expected_id = 'artifact-bundle-sha256-' . $content_digest;
		if ( $expected_id !== $id ) {
			return new WP_Error( 'wp_codebox_artifact_id_mismatch', 'Artifact id does not match the content digest.', array( 'status' => 400 ) );
		}

		$bundle['manifest']      = $manifest;
		$bundle['metadata']      = $metadata;
		$bundle['changed_files'] = $changed_files;
		$bundle['test_results']  = $test_results;
		$bundle['review']        = $review;

		return $bundle;
	}

	/** @return array<string,mixed>|WP_Error */
	private function read_json_file( string $path ): array|WP_Error {
		$contents = is_file( $path ) ? file_get_contents( $path ) : false;
		if ( false === $contents ) {
			return new WP_Error( 'wp_codebox_artifact_file_missing', 'Artifact file is missing.', array( 'status' => 400, 'path' => $path ) );
		}

		$decoded = json_decode( $contents, true );
		if ( ! is_array( $decoded ) ) {
			return new WP_Error( 'wp_codebox_artifact_json_invalid', 'Artifact JSON could not be decoded.', array( 'status' => 400, 'path' => $path ) );
		}

		return $decoded;
	}

	/** @param array<string,mixed> $bundle Artifact bundle. */
	private function artifact_content_digest( array $bundle ): string|WP_Error {
		$changed_files_path = (string) ( $bundle['paths']['changed_files'] ?? '' );
		$patch_path         = (string) ( $bundle['paths']['patch'] ?? '' );
		$changed_files      = '' !== $changed_files_path && is_file( $changed_files_path ) ? file_get_contents( $changed_files_path ) : false;
		$patch              = '' !== $patch_path && is_file( $patch_path ) ? file_get_contents( $patch_path ) : false;

		if ( false === $changed_files ) {
			return new WP_Error( 'wp_codebox_changed_files_missing', 'Artifact changed-files.json is missing.', array( 'status' => 400 ) );
		}

		if ( false === $patch ) {
			return new WP_Error( 'wp_codebox_patch_missing', 'Artifact patch.diff is missing.', array( 'status' => 400 ) );
		}

		return hash( 'sha256', self::CONTENT_DIGEST_PREFIX . $changed_files . self::CONTENT_DIGEST_SEPARATOR . $patch );
	}

	private function resolve_artifact_file( string $directory, string $relative_path ): string {
		$path = $directory . DIRECTORY_SEPARATOR . str_replace( '/', DIRECTORY_SEPARATOR, $relative_path );
		$real = realpath( $path );

		return false !== $real ? $real : $path;
	}

	/** @param array<string,mixed> $input Ability input. @return string[] */
	private function approved_files( array $input ): array {
		$files = is_array( $input['approved_files'] ?? null ) ? $input['approved_files'] : array();

		return array_values(
			array_unique(
				array_filter(
					array_map( static fn( $path ): string => trim( (string) $path ), $files ),
					static fn( string $path ): bool => '' !== $path
				)
			)
		);
	}

	/**
	 * @param array<int,mixed> $changed_files Artifact changed file entries.
	 * @param string[]         $approved_files Approved sandbox paths.
	 */
	private function filter_patch_to_approved_files( string $patch, array $changed_files, array $approved_files ): string|WP_Error {
		$approved_lookup             = array_fill_keys( $approved_files, true );
		$approved_patch_path_sets    = array();
		$approved_patch_paths_lookup = array();

		foreach ( $changed_files as $file ) {
			if ( ! is_array( $file ) ) {
				continue;
			}

			$path = trim( (string) ( $file['path'] ?? '' ) );
			if ( '' === $path || ! isset( $approved_lookup[ $path ] ) ) {
				continue;
			}

			foreach ( array( $path, (string) ( $file['relativePath'] ?? '' ) ) as $patch_path ) {
				$normalized = $this->normalize_patch_path( $patch_path );
				if ( '' !== $normalized ) {
					$approved_patch_path_sets[ $path ][ $normalized ] = true;
					$approved_patch_paths_lookup[ $normalized ] = true;
				}
			}
		}

		if ( empty( $approved_patch_paths_lookup ) ) {
			return new WP_Error( 'wp_codebox_approved_patch_paths_missing', 'Approved files could not be mapped to patch paths.', array( 'status' => 400 ) );
		}

		$blocks = $this->split_git_patch_blocks( $patch );
		if ( empty( $blocks ) ) {
			return new WP_Error( 'wp_codebox_patch_unfilterable', 'Artifact patch.diff could not be split into file patches.', array( 'status' => 400 ) );
		}

		$matched_approved_files = array();
		$filtered_blocks = array();
		foreach ( $blocks as $block ) {
			$block_paths = $this->git_patch_block_paths( $block );
			$matches     = array_intersect_key( $block_paths, $approved_patch_paths_lookup );
			if ( empty( $matches ) ) {
				continue;
			}

			foreach ( $approved_patch_path_sets as $approved_file => $candidate_paths ) {
				if ( ! empty( array_intersect_key( $matches, $candidate_paths ) ) ) {
					$matched_approved_files[ $approved_file ] = true;
				}
			}

			$filtered_blocks[] = $block;
		}

		$missing_files = array_values( array_diff( $approved_files, array_keys( $matched_approved_files ) ) );
		if ( ! empty( $missing_files ) ) {
			return new WP_Error(
				'wp_codebox_approved_patch_missing',
				'Artifact patch.diff does not contain every approved file, so the partial approval cannot be applied safely.',
				array(
					'status' => 400,
					'files'  => $missing_files,
				)
			);
		}

		$filtered_patch = implode( '', $filtered_blocks );
		if ( '' === trim( $filtered_patch ) ) {
			return new WP_Error( 'wp_codebox_approved_patch_empty', 'Approved files produced an empty patch.', array( 'status' => 400 ) );
		}

		return $filtered_patch;
	}

	/** @return string[] */
	private function split_git_patch_blocks( string $patch ): array {
		$lines = preg_split( "/(?<=\n)(?=diff --git )/", $patch );
		if ( false === $lines ) {
			return array();
		}

		return array_values(
			array_filter(
				$lines,
				static fn( string $block ): bool => str_starts_with( $block, 'diff --git ' )
			)
		);
	}

	/** @return array<string,bool> */
	private function git_patch_block_paths( string $block ): array {
		$paths = array();
		if ( preg_match( '/^diff --git\s+a\/(.+?)\s+b\/(.+)$/m', $block, $matches ) ) {
			foreach ( array( $matches[1], $matches[2] ) as $path ) {
				$normalized = $this->normalize_patch_path( $path );
				if ( '' !== $normalized ) {
					$paths[ $normalized ] = true;
				}
			}
		}

		foreach ( array( '---', '+++' ) as $prefix ) {
			if ( preg_match( '/^' . preg_quote( $prefix, '/' ) . '\s+(.+)$/m', $block, $matches ) ) {
				$normalized = $this->normalize_patch_path( $matches[1] );
				if ( '' !== $normalized ) {
					$paths[ $normalized ] = true;
				}
			}
		}

		return $paths;
	}

	private function normalize_patch_path( string $path ): string {
		$path = trim( $path );
		if ( '' === $path || '/dev/null' === $path ) {
			return '';
		}

		$path = preg_replace( '/\s+.*$/', '', $path ) ?? $path;
		$path = str_replace( '\\', '/', $path );
		$path = preg_replace( '#^(?:a|b)/#', '', $path ) ?? $path;
		$path = ltrim( $path, '/' );

		return $path;
	}

	/**
	 * @param array<string,mixed> $bundle Artifact bundle.
	 * @param string[]            $approved_files Approved sandbox paths.
	 * @param array<string,mixed> $payload Apply adapter payload.
	 * @param mixed               $result Apply adapter result.
	 */
	private function record_apply_audit( string $root, array $bundle, array $approved_files, array $payload, mixed $result, ?WP_Error $error ): void {
		$record = array(
			'schema'         => self::APPLY_AUDIT_SCHEMA,
			'timestamp'      => gmdate( 'c' ),
			'artifact_id'    => (string) $bundle['id'],
			'content_digest' => (string) ( $payload['artifact_content_digest'] ?? $bundle['content_digest'] ?? '' ),
			'patch_sha256'   => (string) ( $payload['patch_sha256'] ?? '' ),
			'requester'      => $this->requester_principal( $bundle ),
			'approver'       => $this->approver_principal( $payload['approver'] ?? null ),
			'approved_files' => $approved_files,
			'adapter'        => is_array( $result ) ? ( $result['adapter'] ?? null ) : $this->adapter_from_error( $error ),
			'status'         => null === $error ? 'success' : 'failure',
		);

		if ( is_array( $result ) ) {
			$record['result'] = $this->redact_audit_metadata( $result );
		}

		if ( null !== $error ) {
			$record['error'] = array(
				'code'    => $error->get_error_code(),
				'message' => $error->get_error_message(),
				'data'    => $this->redact_audit_metadata( $error->get_error_data() ),
			);
		}

		$record = $this->strip_null_values( $record );
		$line   = function_exists( 'wp_json_encode' ) ? wp_json_encode( $record, JSON_UNESCAPED_SLASHES ) : json_encode( $record, JSON_UNESCAPED_SLASHES );
		if ( false === $line ) {
			return;
		}

		file_put_contents( $this->apply_audit_path( $root ), $line . "\n", FILE_APPEND | LOCK_EX );
	}

	private function apply_audit_path( string $root ): string {
		$path = $root . DIRECTORY_SEPARATOR . 'apply-audit.jsonl';

		if ( function_exists( 'apply_filters' ) ) {
			$path = (string) apply_filters( 'wp_codebox_apply_audit_path', $path, $root );
		}

		return $path;
	}

	/** @param array<string,mixed> $bundle Artifact bundle. */
	private function requester_principal( array $bundle ): mixed {
		foreach ( array( 'metadata', 'review' ) as $section ) {
			$provenance = is_array( $bundle[ $section ]['provenance'] ?? null ) ? $bundle[ $section ]['provenance'] : array();
			$task       = is_array( $provenance['task'] ?? null ) ? $provenance['task'] : array();

			foreach ( array( 'requester', 'requested_by', 'principal', 'user' ) as $key ) {
				if ( ! empty( $task[ $key ] ) ) {
					return $task[ $key ];
				}
			}
		}

		return null;
	}

	private function approver_principal( mixed $input_approver ): mixed {
		if ( null !== $input_approver && '' !== $input_approver ) {
			return $input_approver;
		}

		if ( function_exists( 'wp_get_current_user' ) ) {
			$user = wp_get_current_user();
			if ( is_object( $user ) && ! empty( $user->ID ) ) {
				return array(
					'id'    => (int) $user->ID,
					'login' => (string) ( $user->user_login ?? '' ),
				);
			}
		}

		return null;
	}

	private function adapter_from_error( ?WP_Error $error ): mixed {
		if ( null === $error ) {
			return null;
		}

		$data = $error->get_error_data();
		return is_array( $data ) ? ( $data['adapter'] ?? null ) : null;
	}

	private function redact_audit_metadata( mixed $value ): mixed {
		if ( ! is_array( $value ) ) {
			return $value;
		}

		$redacted = array();
		foreach ( $value as $key => $item ) {
			$normalized_key = strtolower( (string) $key );
			if ( $this->is_sensitive_audit_key( $normalized_key ) ) {
				$redacted[ $key ] = '[redacted]';
				continue;
			}

			$redacted[ $key ] = $this->redact_audit_metadata( $item );
		}

		return $redacted;
	}

	private function is_sensitive_audit_key( string $key ): bool {
		if ( in_array( $key, array( 'patch', 'patch_body', 'patch_diff', 'diff', 'body', 'content', 'contents' ), true ) ) {
			return true;
		}

		foreach ( array( 'secret', 'token', 'password', 'credential', 'authorization', 'private_key', 'api_key' ) as $needle ) {
			if ( str_contains( $key, $needle ) ) {
				return true;
			}
		}

		return false;
	}

	/** @param array<string,mixed> $record Audit record. @return array<string,mixed> */
	private function strip_null_values( array $record ): array {
		return array_filter( $record, static fn( mixed $value ): bool => null !== $value );
	}

	private function path_is_inside( string $path, string $root ): bool {
		$real_path = realpath( $path );
		$real_root = realpath( $root );
		if ( false === $real_path || false === $real_root ) {
			return false;
		}

		return str_starts_with( $real_path . DIRECTORY_SEPARATOR, rtrim( $real_root, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR );
	}

	private function remove_directory( string $directory ): void {
		foreach ( scandir( $directory ) ?: array() as $entry ) {
			if ( '.' === $entry || '..' === $entry ) {
				continue;
			}

			$path = $directory . DIRECTORY_SEPARATOR . $entry;
			if ( is_dir( $path ) && ! is_link( $path ) ) {
				$this->remove_directory( $path );
				continue;
			}

			unlink( $path );
		}

		rmdir( $directory );
	}
}
