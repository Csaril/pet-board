import { pbtaSystemModule } from './system/pbta-2d6/module.js';

export interface SystemModuleDescriptor {
  id: string;
  version: string;
  name: string;
}

export interface FeatureModuleDescriptor {
  id: string;
  version: string;
  name: string;
}

export const systemModules = [pbtaSystemModule] as const;
export const featureModules: readonly FeatureModuleDescriptor[] = [];

export const systemModuleRegistry = new Map<string, SystemModuleDescriptor>(
  systemModules.map((module) => [module.id, module]),
);
