/**
 * Backwards-compatible view of the metadata manifest.
 *
 * The old registry imported every implementation. This module deliberately
 * contains no implementation imports: the core may use it for validation,
 * names and capabilities, while loaders (client-registry / server registry)
 * fetch the actual code by the exact `id@version` pair.
 */
import {
  findLatestSystemMetadata,
  findSystemMetadata,
  systemKey,
  systemMetadata,
  systemMetadataByKey,
  type SystemCapabilities,
  type SystemMetadata,
} from './manifest.js';

export type { SystemCapabilities, SystemMetadata };

/** Historical name kept for existing callers and tests. */
export type SystemModuleDescriptor = SystemMetadata;

export interface FeatureModuleDescriptor {
  id: string;
  version: string;
  name: string;
}

export const systemModules: readonly SystemMetadata[] = systemMetadata;
export const featureModules: readonly FeatureModuleDescriptor[] = [];

/** Keyed by ID only, for legacy callers that want the newest version. */
export const systemModuleRegistry: ReadonlyMap<string, SystemMetadata> = new Map(
  systemMetadata.map((metadata) => [metadata.id, metadata]),
);

export function findSystemModule(id: string, version?: string): SystemMetadata | undefined {
  return findSystemMetadata(id, version);
}

export { findLatestSystemMetadata, findSystemMetadata, systemKey, systemMetadata, systemMetadataByKey };
