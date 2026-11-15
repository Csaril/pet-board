import { findSystemMetadata, systemKey } from '../src/modules/manifest.js';
import { BoardCommandError } from './board.js';
import type { SystemServerModule } from './system-contract.js';

export class SystemModuleUnavailableError extends BoardCommandError {
  constructor(readonly systemId: string, readonly systemVersion: string, reason: string) {
    super(
      `Системная версия ${systemId}@${systemVersion} не поддерживается этой сборкой: ${reason}. `
      + 'Автоматического перехода на другую версию нет; нужна контролируемая миграция комнаты.',
      { code: 'SYSTEM_VERSION_UNSUPPORTED', statusCode: 409 },
    );
    this.name = 'SystemModuleUnavailableError';
  }
}

interface LoadedModule {
  systemServerModule: SystemServerModule;
}

/** Explicit allowlist: no path is ever built from a room or client value. */
const serverLoaders: Readonly<Record<string, () => Promise<LoadedModule>>> = {
  'pbta-2d6@1.0.0': () => import('./modules/pbta-2d6/server.js'),
  'nechronica@1.0.0': () => import('./modules/nechronica/server.js'),
};

export const serverLoaderKeys: readonly string[] = Object.keys(serverLoaders);

/** Code promises are cached per exact pair; they are shared by all rooms. */
const serverModuleCache = new Map<string, Promise<SystemServerModule>>();

export function loadSystemServer(id: string, version: string): Promise<SystemServerModule> {
  const key = systemKey(id, version);
  const cached = serverModuleCache.get(key);
  if (cached) return cached;

  const metadata = findSystemMetadata(id, version);
  const loader = serverLoaders[key];
  if (!metadata || !loader) {
    return Promise.reject(new SystemModuleUnavailableError(
      id,
      version,
      metadata ? 'загрузчик не зарегистрирован' : 'версия отсутствует в реестре',
    ));
  }

  const promise = loader()
    .then((module) => {
      const implementation = module.systemServerModule;
      if (!implementation || implementation.id !== id || implementation.version !== version) {
        throw new SystemModuleUnavailableError(id, version, 'модуль не соответствует зарегистрированной паре');
      }
      return implementation;
    })
    .catch((error: unknown) => {
      // A transient import failure must remain retryable.
      serverModuleCache.delete(key);
      throw error instanceof BoardCommandError
        ? error
        : new SystemModuleUnavailableError(id, version, error instanceof Error ? error.message : 'не удалось загрузить код');
    });
  serverModuleCache.set(key, promise);
  return promise;
}

/** Keys whose code has actually been requested/loaded in this process. */
export function loadedSystemKeys(): string[] {
  return [...serverModuleCache.keys()].sort();
}

/** Test-only hook. Node still keeps its own ES module cache. */
export function clearSystemServerCacheForTests(): void {
  serverModuleCache.clear();
}
