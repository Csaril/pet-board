import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { SystemClientContext, SystemClientFactory, SystemClientModule } from '../src/modules/client-contract.js';
import { SystemHost } from '../src/modules/client-host.js';
import {
  clearClientModuleCacheForTests,
  clientLoaderKeys,
  isClientModuleCached,
  loadSystemClient,
  SystemClientLoadError,
} from '../src/modules/client-registry.js';
import {
  findLatestSystemMetadata,
  findSystemMetadata,
  systemKey,
  systemMetadata,
  systemMetadataOptions,
} from '../src/modules/manifest.js';
import { executeSheetCommand } from './sheets.js';
import { RoomStore, type Identity } from './store.js';
import {
  clearSystemServerCacheForTests,
  loadSystemServer,
  loadedSystemKeys,
  serverLoaderKeys,
  SystemModuleUnavailableError,
} from './system-registry.js';

const gm: Identity = { participantId: 'gm-1', name: 'Keeper', role: 'gm' };

const runtime = (id: string, version: string) => {
  const metadata = findSystemMetadata(id, version);
  assert.ok(metadata);
  return { id, version, name: metadata.name, capabilities: { ...metadata.capabilities } };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

function stubFactory(label: string, events: string[], mountGate?: Promise<void>): SystemClientFactory {
  return {
    createClientModule(): SystemClientModule {
      events.push(`create:${label}`);
      let active = false;
      return {
        async mount() {
          events.push(`mount-start:${label}`);
          if (mountGate) await mountGate;
          active = true;
          events.push(`mount:${label}`);
        },
        dispose() {
          events.push(`dispose:${label}:${active}`);
        },
      };
    },
  };
}

test('system metadata is trusted, exact and contains no implementation imports', () => {
  const manifestSource = readFileSync('src/modules/manifest.ts', 'utf8');
  const registrySource = readFileSync('src/modules/registry.ts', 'utf8');
  assert.doesNotMatch(manifestSource, /modules\/system\//);
  assert.doesNotMatch(manifestSource, /client\.js|server\.js/);
  assert.doesNotMatch(registrySource, /modules\/system\//);

  assert.deepEqual(systemMetadata.map((entry) => systemKey(entry.id, entry.version)).sort(), [
    'nechronica@1.0.0',
    'nechronica@1.1.0',
    'nechronica@1.2.0',
    'pbta-2d6@1.0.0',
  ]);
  assert.deepEqual(findSystemMetadata('pbta-2d6', '1.0.0'), {
    id: 'pbta-2d6',
    version: '1.0.0',
    name: 'PbtA',
    sheetSchemaVersion: 1,
    capabilities: { battleMap: false },
  });
  assert.deepEqual(findSystemMetadata('nechronica', '1.0.0')?.capabilities, { battleMap: true });
});

test('only the exact id@version pair resolves; no implicit upgrade or downgrade', () => {
  assert.ok(findSystemMetadata('pbta-2d6', '1.0.0'));
  assert.equal(findSystemMetadata('pbta-2d6'), findSystemMetadata('pbta-2d6', '1.0.0'));
  assert.equal(findSystemMetadata('pbta-2d6', '0.9.0'), undefined);
  assert.equal(findSystemMetadata('pbta-2d6', '2.0.0'), undefined);
  assert.equal(findSystemMetadata('nechronica', '1.0.0'), findSystemMetadata('nechronica', '1.0.0'));
  assert.equal(findSystemMetadata('unknown', '1.0.0'), undefined);
  assert.equal(findLatestSystemMetadata('pbta-2d6')?.version, '1.0.0');
  assert.equal(findLatestSystemMetadata('nechronica')?.version, '1.2.0');
  assert.equal(findLatestSystemMetadata('nechronica')?.sheetSchemaVersion, 3);
  assert.equal(findLatestSystemMetadata('unknown'), undefined);
  assert.deepEqual(systemMetadataOptions().map((entry) => entry.id).sort(), ['nechronica', 'pbta-2d6']);
  assert.equal(systemMetadataOptions().find((entry) => entry.id === 'nechronica')?.version, '1.2.0');
});

test('server loader allowlist loads exact versions and caches a code promise', async () => {
  clearSystemServerCacheForTests();
  assert.deepEqual([...serverLoaderKeys].sort(), ['nechronica@1.0.0', 'nechronica@1.1.0', 'nechronica@1.2.0', 'pbta-2d6@1.0.0']);
  assert.deepEqual(loadedSystemKeys(), []);

  const first = loadSystemServer('pbta-2d6', '1.0.0');
  const second = loadSystemServer('pbta-2d6', '1.0.0');
  assert.equal(first, second, 'the same code promise must be reused');
  const module = await first;
  assert.equal(module.id, 'pbta-2d6');
  assert.equal(module.version, '1.0.0');
  assert.equal(module.advancedSheet, true);
  assert.deepEqual(loadedSystemKeys(), ['pbta-2d6@1.0.0']);

  const nechronica = await loadSystemServer('nechronica', '1.0.0');
  assert.equal(nechronica.id, 'nechronica');
  assert.equal(nechronica.advancedSheet, false);
  const nechronicaNext = await loadSystemServer('nechronica', '1.1.0');
  assert.equal(nechronicaNext.version, '1.1.0');
  assert.equal(nechronicaNext.advancedSheet, true);
  assert.equal(nechronicaNext.createRoll, undefined, '1.1.0 must not expose the 1.2.0 roll');
  const nechronicaLatest = await loadSystemServer('nechronica', '1.2.0');
  assert.equal(nechronicaLatest.version, '1.2.0');
  assert.equal(nechronicaLatest.advancedSheet, true);
  assert.equal(nechronicaLatest.handlesRollCommand?.('dice:nechronica'), true);
  assert.equal(nechronicaNext.handlesRollCommand?.('dice:nechronica'), undefined);
  assert.deepEqual(loadedSystemKeys(), ['nechronica@1.0.0', 'nechronica@1.1.0', 'nechronica@1.2.0', 'pbta-2d6@1.0.0']);
  assert.notEqual(module, nechronica);
});

test('server loader rejects unknown ids and mismatched versions with a migration hint', async () => {
  clearSystemServerCacheForTests();
  await assert.rejects(() => loadSystemServer('pbta-2d6', '9.9.9'), (error: unknown) => {
    assert.ok(error instanceof SystemModuleUnavailableError);
    assert.equal(error.code, 'SYSTEM_VERSION_UNSUPPORTED');
    assert.match(error.message, /9\.9\.9/);
    assert.match(error.message, /миграц/i);
    return true;
  });
  await assert.rejects(() => loadSystemServer('unknown', '1.0.0'), /не поддерживается/);
  assert.deepEqual(loadedSystemKeys(), [], 'failed loads must not stay cached');
});

test('client loader allowlist caches the module promise but not a UI instance', async () => {
  clearClientModuleCacheForTests();
  assert.deepEqual([...clientLoaderKeys].sort(), ['nechronica@1.0.0', 'nechronica@1.1.0', 'nechronica@1.2.0', 'pbta-2d6@1.0.0']);
  assert.equal(isClientModuleCached('pbta-2d6', '1.0.0'), false);

  const first = loadSystemClient('pbta-2d6', '1.0.0');
  const second = loadSystemClient('pbta-2d6', '1.0.0');
  assert.equal(first, second);
  assert.equal(isClientModuleCached('pbta-2d6', '1.0.0'), true);

  const factory = await first;
  const left = factory.createClientModule();
  const right = factory.createClientModule();
  assert.notEqual(left, right, 'rooms must never share mutable UI state');
  left.dispose();
  right.dispose();

  const nechronica = await loadSystemClient('nechronica', '1.0.0');
  assert.notEqual(factory, nechronica);
  const nechronicaNext = await loadSystemClient('nechronica', '1.1.0');
  assert.notEqual(nechronica, nechronicaNext);
  const advanced = nechronicaNext.createClientModule();
  assert.equal(advanced.ownsProfile, true);
  advanced.dispose();
  const latest = await loadSystemClient('nechronica', '1.2.0');
  assert.notEqual(nechronicaNext, latest);
  const latestModule = latest.createClientModule();
  assert.equal(latestModule.ownsProfile, true);
  latestModule.dispose();
});

test('client loader reports unsupported versions and never falls back', async () => {
  clearClientModuleCacheForTests();
  await assert.rejects(() => loadSystemClient('pbta-2d6', '0.9.0'), (error: unknown) => {
    assert.ok(error instanceof SystemClientLoadError);
    assert.equal(error.code, 'SYSTEM_VERSION_UNSUPPORTED');
    assert.match(error.message, /pbta-2d6@0\.9\.0/);
    assert.match(error.message, /миграц/i);
    return true;
  });
  assert.equal(isClientModuleCached('pbta-2d6', '0.9.0'), false);
  await assert.rejects(() => loadSystemClient('unknown', '1.0.0'), /не поддерживается/);
});

test('SystemHost mounts once per room and disposes before switching systems', async () => {
  const events: string[] = [];
  const host = new SystemHost({
    load: async (id) => stubFactory(id, events),
    createContext: (system) => ({ system } as unknown as SystemClientContext),
  });

  assert.equal((await host.activate('room-a', runtime('pbta-2d6', '1.0.0'))).status, 'mounted');
  assert.equal(host.activeKey, systemKey('pbta-2d6', '1.0.0'));
  assert.equal(host.activeRoomId, 'room-a');
  assert.equal((await host.activate('room-a', runtime('pbta-2d6', '1.0.0'))).status, 'already-mounted');
  assert.deepEqual(events, ['create:pbta-2d6', 'mount-start:pbta-2d6', 'mount:pbta-2d6']);

  assert.equal((await host.activate('room-a', runtime('nechronica', '1.0.0'))).status, 'mounted');
  assert.deepEqual(events.slice(3), ['dispose:pbta-2d6:true', 'create:nechronica', 'mount-start:nechronica', 'mount:nechronica']);
  assert.equal(host.activeKey, systemKey('nechronica', '1.0.0'));

  host.deactivate();
  assert.equal(host.instance, undefined);
  assert.equal(events.at(-1), 'dispose:nechronica:true');
});

test('SystemHost isolates rooms of the same system and never shares an instance', async () => {
  const events: string[] = [];
  let nextMount = 0;
  const host = new SystemHost({
    load: async () => ({ createClientModule: () => {
      const id = ++nextMount;
      return {
        mount() { events.push(`mount:${id}`); },
        dispose() { events.push(`dispose:${id}`); },
      };
    } }),
    createContext: (system) => ({ system } as unknown as SystemClientContext),
  });

  assert.equal((await host.activate('room-a', runtime('pbta-2d6', '1.0.0'))).status, 'mounted');
  const first = host.instance;
  assert.equal((await host.activate('room-b', runtime('pbta-2d6', '1.0.0'))).status, 'mounted');
  assert.notEqual(host.instance, first);
  assert.equal(host.activeRoomId, 'room-b');
  assert.deepEqual(events, ['mount:1', 'dispose:1', 'mount:2']);
});

test('a slow stale import cannot mount after a fast room/system switch', async () => {
  const slowlyLoaded = deferred<SystemClientFactory>();
  const events: string[] = [];
  const host = new SystemHost({
    load: (id) => id === 'pbta-2d6'
      ? slowlyLoaded.promise
      : Promise.resolve(stubFactory('nechronica', events)),
    createContext: (system) => ({ system } as unknown as SystemClientContext),
  });

  const stale = host.activate('room-a', runtime('pbta-2d6', '1.0.0'));
  const fresh = host.activate('room-b', runtime('nechronica', '1.0.0'));
  assert.equal((await fresh).status, 'mounted');
  assert.equal(host.activeKey, systemKey('nechronica', '1.0.0'));

  slowlyLoaded.resolve(stubFactory('pbta-2d6', events));
  assert.equal((await stale).status, 'stale');
  assert.equal(host.activeKey, systemKey('nechronica', '1.0.0'));
  assert.equal(events.some((event) => event.startsWith('mount:pbta')), false);
});

test('an in-flight module is disposed when its mount resolves after a switch', async () => {
  const mountGate = deferred<void>();
  const events: string[] = [];
  const host = new SystemHost({
    load: async (id) => stubFactory(id, events, id === 'pbta-2d6' ? mountGate.promise : undefined),
    createContext: (system) => ({ system } as unknown as SystemClientContext),
  });

  const stale = host.activate('room-a', runtime('pbta-2d6', '1.0.0'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(events.includes('mount-start:pbta-2d6'));
  const fresh = host.activate('room-a', runtime('nechronica', '1.0.0'));
  assert.equal((await fresh).status, 'mounted');
  mountGate.resolve();
  assert.equal((await stale).status, 'stale');
  assert.deepEqual(events, [
    'create:pbta-2d6', 'mount-start:pbta-2d6',
    'create:nechronica', 'mount-start:nechronica', 'mount:nechronica',
    'mount:pbta-2d6', 'dispose:pbta-2d6:true',
  ]);
});

test('import failures surface as an error and do not mount or poison later mounts', async () => {
  const events: string[] = [];
  const host = new SystemHost({
    load: async () => { throw new Error('chunk unavailable'); },
    createContext: (system) => ({ system } as unknown as SystemClientContext),
    onError: (error) => events.push(`error:${error.message}`),
  });
  const result = await host.activate('room-a', runtime('pbta-2d6', '1.0.0'));
  assert.equal(result.status, 'error');
  assert.equal(host.instance, undefined);
  assert.deepEqual(events, ['error:chunk unavailable']);

  const recovering = new SystemHost({
    load: async () => stubFactory('pbta-2d6', events),
    createContext: (system) => ({ system } as unknown as SystemClientContext),
  });
  assert.equal((await recovering.activate('room-a', runtime('pbta-2d6', '1.0.0'))).status, 'mounted');
});

test('rooms of the same system reuse code but keep independent server sheet state', async () => {
  const leftDir = mkdtempSync(join(tmpdir(), 'tabletop-load-left-'));
  const rightDir = mkdtempSync(join(tmpdir(), 'tabletop-load-right-'));
  const left = new RoomStore(leftDir, 'Left');
  const right = new RoomStore(rightDir, 'Right');
  try {
    left.initializeSystem('pbta-2d6', '1.0.0');
    right.initializeSystem('pbta-2d6', '1.0.0');
    await executeSheetCommand(left, gm, { type: 'sheet:create', characterName: 'Left hero' });
    await executeSheetCommand(right, gm, { type: 'sheet:create', characterName: 'Right hero' });

    assert.deepEqual(left.getSheetsFor(gm).map((sheet) => sheet.characterName), ['Left hero']);
    assert.deepEqual(right.getSheetsFor(gm).map((sheet) => sheet.characterName), ['Right hero']);
    assert.equal(left.capabilities.battleMap, false);
    assert.equal(right.capabilities.battleMap, false);
  } finally {
    left.close();
    right.close();
    rmSync(leftDir, { recursive: true, force: true });
    rmSync(rightDir, { recursive: true, force: true });
  }
});

test('Nechronica capabilities own the battle map and reject PbtA-only sheet mechanics', async () => {
  const nechDir = mkdtempSync(join(tmpdir(), 'tabletop-load-nech-'));
  const pbtaDir = mkdtempSync(join(tmpdir(), 'tabletop-load-pbta-'));
  const nech = new RoomStore(nechDir, 'Nechronica');
  const pbta = new RoomStore(pbtaDir, 'PbtA');
  try {
    nech.initializeSystem('nechronica', '1.0.0');
    pbta.initializeSystem('pbta-2d6', '1.0.0');
    assert.equal(nech.capabilities.battleMap, true);
    assert.equal(pbta.capabilities.battleMap, false);

    await executeSheetCommand(nech, gm, { type: 'sheet:create', characterName: 'Doll' });
    const doll = nech.getSheetsFor(gm)[0]!;
    await assert.rejects(
      () => executeSheetCommand(nech, gm, { type: 'sheet:ability:create', sheetId: doll.id, name: 'Move' }),
      /расширенный лист/,
    );
    await assert.rejects(
      () => executeSheetCommand(nech, gm, { type: 'sheet:fate:update', sheetId: doll.id, value: 1 }),
      /расширенный лист/,
    );
    await executeSheetCommand(nech, gm, { type: 'sheet:update', id: doll.id, changes: { characterName: 'Renamed doll' } });
    assert.equal(nech.getSheet(doll.id)?.characterName, 'Renamed doll');
  } finally {
    nech.close();
    pbta.close();
    rmSync(nechDir, { recursive: true, force: true });
    rmSync(pbtaDir, { recursive: true, force: true });
  }
});
