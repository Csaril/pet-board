/**
 * Compact, trusted system metadata.
 *
 * This file is part of the core bundle: it must never import a client or server
 * system implementation. It only describes which systems this build supports,
 * so the core can validate a room, expose capabilities and choose an exact
 * lazy loader without executing any system code.
 */
export interface SystemCapabilities {
  /** The system owns the second saved board scene used as its battle map. */
  battleMap: boolean;
}

export interface SystemMetadata {
  id: string;
  version: string;
  name: string;
  /** Version of the persisted character-sheet shape owned by this system. */
  sheetSchemaVersion: number;
  /** Optional features this system owns; the core never enables them globally. */
  capabilities: SystemCapabilities;
}

export interface FeatureModuleDescriptor {
  id: string;
  version: string;
  name: string;
}

/** `id@version` is the only key used by loaders and caches. */
export function systemKey(id: string, version: string): string {
  return `${id}@${version}`;
}

/**
 * Exact versions are listed explicitly. Adding a second version is a deliberate
 * registry change and existing rooms keep their pinned pair.
 */
export const systemMetadata: readonly SystemMetadata[] = [
  {
    id: 'pbta-2d6',
    version: '1.0.0',
    name: 'PbtA',
    sheetSchemaVersion: 1,
    capabilities: { battleMap: false },
  },
  {
    id: 'nechronica',
    version: '1.0.0',
    name: 'Nechronica',
    sheetSchemaVersion: 1,
    capabilities: { battleMap: true },
  },
] as const;

export const systemMetadataByKey: ReadonlyMap<string, SystemMetadata> = new Map(
  systemMetadata.map((metadata) => [systemKey(metadata.id, metadata.version), metadata]),
);

/**
 * Looks up a system. With a version the pair must match exactly; without a
 * version the newest registered version is returned for pickers and admin
 * commands only. Loaders always pass an explicit version.
 */
export function findSystemMetadata(id: string, version?: string): SystemMetadata | undefined {
  if (version !== undefined) return systemMetadataByKey.get(systemKey(id, version));
  return systemMetadata.find((metadata) => metadata.id === id);
}

export function findLatestSystemMetadata(id: string): SystemMetadata | undefined {
  return systemMetadata.find((metadata) => metadata.id === id);
}

/** Distinct system IDs in registry order, used by the one-time room picker. */
export function systemMetadataOptions(): SystemMetadata[] {
  const seen = new Set<string>();
  return systemMetadata.filter((metadata) => {
    if (seen.has(metadata.id)) return false;
    seen.add(metadata.id);
    return true;
  });
}
