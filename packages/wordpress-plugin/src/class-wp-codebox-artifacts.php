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
			return new WP_Error( 'wp_codebox_apply_adapter_missing', 'No apply-back adapter handled this approved artifact.', array( 'status' => 501 ) );
		}

		if ( is_wp_error( $result ) ) {
			return $result;
		}

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
			$base = function_exists( 'wp_upload_dir' ) ? wp_upload_dir() : array( 'basedir' => sys_get_temp_dir() );
			$root = is_array( $base ) && ! empty( $base['basedir'] ) ? (string) $base['basedir'] : sys_get_temp_dir();
			$root = rtrim( $root, DIRECTORY_SEPARATOR ) . DIRECTORY_SEPARATOR . 'wp-codebox';
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
