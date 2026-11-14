import { nechronicaSystemModule } from './system/nechronica/module.js';
import { pbtaSystemModule } from './system/pbta-2d6/module.js';

export interface SystemCapabilities {
  /** The system owns the second saved board scene used as its battle map. */
  battleMap: boolean;
}

export interface SystemModuleDescriptor {
  id: string;
  version: string;
  name: string;
  /** Version of the persisted character-sheet shape owned by this module. */
  sheetSchemaVersion: number;
  /** Optional features this system owns; the core never enables them globally. */
  capabilities: SystemCapabilities;
}

export interface FeatureModuleDescriptor {
  id: string;
  version: string;
  name: string;
}

export const systemModules = [pbtaSystemModule, nechronicaSystemModule] as const;
export const featureModules: readonly FeatureModuleDescriptor[] = [];

export const systemModuleRegistry = new Map<string, SystemModuleDescriptor>(
  systemModules.map((module) => [module.id, module]),
);

export function findSystemModule(id: string, version?: string): SystemModuleDescriptor | undefined {
  const module = systemModuleRegistry.get(id);
  return module && (version === undefined || module.version === version) ? module : undefined;
}
