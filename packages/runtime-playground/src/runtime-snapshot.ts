import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import { RUNTIME_EPISODE_SNAPSHOT_SCHEMA, runtimeEpisodeDigest, type MountSpec, type RuntimeCreateSpec, type RuntimeInfo, type Snapshot } from "@chubes4/wp-codebox-core"
import { playgroundRuntimeCommandIds } from "./command-router.js"

export interface RuntimeSnapshotArtifact {
  schema: "wp-codebox/wordpress-runtime-snapshot/v1"
  version: 1
  id: string
  createdAt: string
  compatibility: {
    backend: "wordpress-playground"
    wordpressVersion: string
    phpVersion: string
  }
  metadata: {
    runtime: RuntimeInfo
    mounts: MountSpec[]
    mountedInputs: Array<Record<string, unknown>>
    activeTheme: string
    activePlugins: string[]
    wpContentPath: string
  }
  database: {
    tables: Array<{
      name: string
      createSql: string
      rows: Array<Record<string, unknown>>
      rowCount: number
    }>
  }
  files: Array<{
    scope: "wp-content"
    path: string
    bytes: number
    sha256: string
    base64: string
  }>
  hashes: {
    database: { algorithm: "sha256"; value: string }
    files: { algorithm: "sha256"; value: string }
  }
}

export class PlaygroundSnapshotRestoreError extends Error {
  readonly code = "wp-codebox-playground-snapshot-restore-failed"

  constructor(message: string) {
    super(message)
    this.name = "PlaygroundSnapshotRestoreError"
  }
}

export function contentDigest(value: unknown): { algorithm: "sha256"; value: string } {
  return { algorithm: "sha256", value: createHash("sha256").update(stableJson(value)).digest("hex") }
}

export function snapshotDigest(snapshot: Snapshot): { algorithm: "sha256"; value: string } {
  return runtimeEpisodeDigest({
    schema: RUNTIME_EPISODE_SNAPSHOT_SCHEMA,
    id: snapshot.id,
    createdAt: snapshot.createdAt,
    semantics: snapshot.semantics,
    metadata: snapshot.metadata,
    artifactRefs: snapshot.artifactRefs ?? [],
  })
}

export function runtimeSpecFromSnapshot(snapshot: Snapshot): RuntimeCreateSpec {
  const runtime = snapshot.metadata.runtime
  if (!isRuntimeInfo(runtime)) {
    throw new PlaygroundSnapshotRestoreError("Snapshot metadata does not include a compatible runtime description.")
  }

  return {
    backend: "wordpress-playground",
    environment: runtime.environment,
    policy: { network: "deny", filesystem: "readwrite-mounts", commands: [...playgroundRuntimeCommandIds()], secrets: "none", approvals: "never" },
  }
}

export function mountsFromSnapshot(snapshot: Snapshot): MountSpec[] {
  return Array.isArray(snapshot.metadata.mounts) ? snapshot.metadata.mounts.filter(isMountSpec) : []
}

export async function runtimeSnapshotPayload(snapshot: Snapshot): Promise<RuntimeSnapshotArtifact> {
  if (snapshot.schema && snapshot.schema !== RUNTIME_EPISODE_SNAPSHOT_SCHEMA) {
    throw new PlaygroundSnapshotRestoreError(`Unsupported snapshot schema: ${snapshot.schema}`)
  }

  if (snapshot.semantics !== "runtime-state-artifact") {
    throw new PlaygroundSnapshotRestoreError(`Snapshot is not a runtime-state artifact: ${snapshot.semantics ?? "metadata-only"}`)
  }

  const embedded = snapshot.metadata.payload
  if (isRuntimeSnapshotArtifact(embedded)) {
    return embedded
  }

  const artifact = snapshot.metadata.artifact
  if (isRecord(artifact) && typeof artifact.absolutePath === "string") {
    const payload = JSON.parse(await readFile(artifact.absolutePath, "utf8"))
    if (isRuntimeSnapshotArtifact(payload)) {
      return payload
    }
  }

  throw new PlaygroundSnapshotRestoreError("Snapshot does not include a readable runtime snapshot artifact payload.")
}

export function runtimeSnapshotExportPhp(): string {
  return String.raw`
global $wpdb;

function wp_codebox_snapshot_hash_file_contents( string $contents ): string {
    return hash( 'sha256', $contents );
}

function wp_codebox_snapshot_relative_path( string $base, string $path ): string {
    $base = rtrim( str_replace( '\\', '/', realpath( $base ) ?: $base ), '/' ) . '/';
    $path = str_replace( '\\', '/', $path );
    return ltrim( substr( $path, strlen( $base ) ), '/' );
}

function wp_codebox_snapshot_files( string $root ): array {
    if ( ! is_dir( $root ) ) {
        return array();
    }

    $files = array();
    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator( $root, FilesystemIterator::SKIP_DOTS ),
        RecursiveIteratorIterator::LEAVES_ONLY
    );

    foreach ( $iterator as $file ) {
        if ( ! $file->isFile() ) {
            continue;
        }

        $path = $file->getPathname();
        $contents = file_get_contents( $path );
        if ( false === $contents ) {
            continue;
        }

        $files[] = array(
            'scope' => 'wp-content',
            'path' => wp_codebox_snapshot_relative_path( $root, $path ),
            'bytes' => strlen( $contents ),
            'sha256' => wp_codebox_snapshot_hash_file_contents( $contents ),
            'base64' => base64_encode( $contents ),
        );
    }

    usort( $files, fn( $left, $right ) => strcmp( $left['path'], $right['path'] ) );
    return $files;
}

$tables = array();
foreach ( $wpdb->get_col( 'SHOW TABLES' ) as $table_name ) {
    $quoted_table = chr( 96 ) . str_replace( chr( 96 ), chr( 96 ) . chr( 96 ), $table_name ) . chr( 96 );
    $create_row = $wpdb->get_row( 'SHOW CREATE TABLE ' . $quoted_table, ARRAY_N );
    $rows = $wpdb->get_results( 'SELECT * FROM ' . $quoted_table, ARRAY_A );
    $tables[] = array(
        'name' => $table_name,
        'createSql' => $create_row[1] ?? '',
        'rows' => $rows ?: array(),
        'rowCount' => count( $rows ?: array() ),
    );
}

usort( $tables, fn( $left, $right ) => strcmp( $left['name'], $right['name'] ) );

echo wp_json_encode( array(
    'compatibility' => array(
        'backend' => 'wordpress-playground',
        'wordpressVersion' => get_bloginfo( 'version' ),
        'phpVersion' => PHP_VERSION,
    ),
    'metadata' => array(
        'runtime' => null,
        'mounts' => array(),
        'mountedInputs' => array(),
        'activeTheme' => wp_get_theme()->get_stylesheet(),
        'activePlugins' => array_values( (array) get_option( 'active_plugins', array() ) ),
        'wpContentPath' => WP_CONTENT_DIR,
    ),
    'database' => array( 'tables' => $tables ),
    'files' => wp_codebox_snapshot_files( WP_CONTENT_DIR ),
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );`
}

export function runtimeSnapshotRestorePhp(payload: RuntimeSnapshotArtifact): string {
  return `${String.raw`
$payload = json_decode(<<<'WP_CODEBOX_SNAPSHOT_JSON'
`}${JSON.stringify(payload)}${String.raw`
WP_CODEBOX_SNAPSHOT_JSON
, true );

if ( ! is_array( $payload ) || ( $payload['schema'] ?? '' ) !== 'wp-codebox/wordpress-runtime-snapshot/v1' ) {
    throw new RuntimeException( 'Invalid WordPress runtime snapshot payload.' );
}

global $wpdb;

function wp_codebox_snapshot_delete_tree( string $path ): void {
    if ( ! file_exists( $path ) ) {
        return;
    }

    if ( is_file( $path ) || is_link( $path ) ) {
        unlink( $path );
        return;
    }

    $iterator = new RecursiveIteratorIterator(
        new RecursiveDirectoryIterator( $path, FilesystemIterator::SKIP_DOTS ),
        RecursiveIteratorIterator::CHILD_FIRST
    );

    foreach ( $iterator as $item ) {
        $item->isDir() ? rmdir( $item->getPathname() ) : unlink( $item->getPathname() );
    }
}

foreach ( $wpdb->get_col( 'SHOW TABLES' ) as $table_name ) {
    $quoted_table = chr( 96 ) . str_replace( chr( 96 ), chr( 96 ) . chr( 96 ), $table_name ) . chr( 96 );
    $wpdb->query( 'DROP TABLE IF EXISTS ' . $quoted_table );
}

foreach ( $payload['database']['tables'] as $table ) {
    if ( ! empty( $table['createSql'] ) ) {
        $wpdb->query( $table['createSql'] );
    }
    foreach ( $table['rows'] as $row ) {
        $wpdb->insert( $table['name'], $row );
    }
}

wp_codebox_snapshot_delete_tree( WP_CONTENT_DIR );
wp_mkdir_p( WP_CONTENT_DIR );

foreach ( $payload['files'] as $file ) {
    if ( ( $file['scope'] ?? '' ) !== 'wp-content' ) {
        continue;
    }
    $relative = ltrim( str_replace( '\\', '/', $file['path'] ), '/' );
    if ( str_contains( $relative, '..' ) ) {
        throw new RuntimeException( 'Snapshot file path is not safe: ' . $relative );
    }
    $target = WP_CONTENT_DIR . '/' . $relative;
    wp_mkdir_p( dirname( $target ) );
    file_put_contents( $target, base64_decode( $file['base64'], true ) );
}

echo wp_json_encode( array(
    'restored' => true,
    'tables' => count( $payload['database']['tables'] ),
    'files' => count( $payload['files'] ),
), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES );
`}`
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`
  }

  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
    .join(",")}}`
}

function isRuntimeInfo(value: unknown): value is RuntimeInfo {
  return isRecord(value)
    && value.backend === "wordpress-playground"
    && isRecord(value.environment)
}

function isMountSpec(value: unknown): value is MountSpec {
  return isRecord(value)
    && typeof value.source === "string"
    && typeof value.target === "string"
    && (value.mode === "readonly" || value.mode === "readwrite")
}

function isRuntimeSnapshotArtifact(value: unknown): value is RuntimeSnapshotArtifact {
  return isRecord(value)
    && value.schema === "wp-codebox/wordpress-runtime-snapshot/v1"
    && value.version === 1
    && isRecord(value.compatibility)
    && value.compatibility.backend === "wordpress-playground"
    && isRecord(value.database)
    && Array.isArray(value.database.tables)
    && Array.isArray(value.files)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
