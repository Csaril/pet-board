import { findSystemMetadata, systemKey } from './manifest.js';
import type { SystemClientFactory, SystemClientLoader } from './client-contract.js';

export class SystemClientLoadError extends Error {
  readonly code = 'SYSTEM_VERSION_UNSUPPORTED';

  constructor(readonly systemId: string, readonly systemVersion: string, reason: string) {
    super(`Системная версия ${systemId}@${systemVersion} не поддерживается этой сборкой: ${reason}. Нужна контролируемая миграция комнаты.`);
    this.name = 'SystemClientLoadError';
  }
}

/**
 * Explicit allowlist. Vite/Astro turns every `import()` below into a separate
 * production chunk. Never build a path from `systemId` or room data.
 */
const clientLoaders: Readonly<Record<string, () => Promise<{ createClientModule: SystemClientFactory['createClientModule'] }>>> = {
  'pbta-2d6@1.0.0': () => import('./system/pbta-2d6/client.js'),
  'nechronica@1.0.0': () => import('./system/nechronica/client.js'),
};

export const clientLoaderKeys: readonly string[] = Object.keys(clientLoaders);

/** Caches the module promise, not a UI instance. Each room calls the factory. */
const clientModuleCache = new Map<string, Promise<SystemClientFactory>>();

export function loadSystemClient(id: string, version: string): Promise<SystemClientFactory> {
  const key = systemKey(id, version);
  const cached = clientModuleCache.get(key);
  if (cached) return cached;

  const metadata = findSystemMetadata(id, version);
  const loader = clientLoaders[key];
  if (!metadata || !loader) {
    return Promise.reject(new SystemClientLoadError(id, version, metadata ? 'загрузчик не зарегистрирован' : 'версия отсутствует в реестре'));
  }

  const promise = loader()
    .then((module) => {
      if (typeof module.createClientModule !== 'function') {
        throw new SystemClientLoadError(id, version, 'модуль не экспортирует createClientModule');
      }
      return module as SystemClientFactory;
    })
    .catch((error: unknown) => {
      // A failed/temporary network import must be retryable.
      clientModuleCache.delete(key);
      throw error instanceof SystemClientLoadError
        ? error
        : new SystemClientLoadError(id, version, error instanceof Error ? error.message : 'не удалось загрузить код');
    });
  clientModuleCache.set(key, promise);
  return promise;
}

/** Test-only hook: drops cached promises without touching the browser module cache. */
export function clearClientModuleCacheForTests(): void {
  clientModuleCache.clear();
}

export function isClientModuleCached(id: string, version: string): boolean {
  return clientModuleCache.has(systemKey(id, version));
}

export type { SystemClientLoader };
