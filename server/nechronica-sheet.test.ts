import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findLatestSystemMetadata, systemMetadataOptions } from '../src/modules/manifest.js';
import {
  isBrokenHeart,
  parseNechronicaSheetData,
  type NechronicaSheetData,
} from '../src/modules/system/nechronica/schema.js';
import type { CharacterSheet, DiceRollEntry } from '../src/shared/board.js';
import { createRoom, initializeDefaultRoom } from './room-admin.js';
import { executeSheetCommand } from './sheets.js';
import { RoomStore, type Identity } from './store.js';
import { loadSystemServer } from './system-registry.js';

const gm: Identity = { participantId: 'gm-1', name: 'Keeper', role: 'gm' };
const player: Identity = { participantId: 'player-1', name: 'Ari', role: 'player' };
const otherPlayer: Identity = { participantId: 'player-2', name: 'Bo', role: 'player' };

function withStore(label: string, run: (store: RoomStore) => void | Promise<void>): Promise<void> {
  return (async () => {
    const dataDir = mkdtempSync(join(tmpdir(), `tabletop-nechronica-${label}-`));
    const store = new RoomStore(dataDir, 'Campaign');
    try {
      store.initializeSystem('nechronica', '1.2.0');
      await run(store);
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  })();
}

async function command(store: RoomStore, identity: Identity, value: Record<string, unknown>): Promise<void> {
  await executeSheetCommand(store, identity, value);
}

async function createSheet(store: RoomStore, identity: Identity, characterName = 'Doll'): Promise<CharacterSheet> {
  const before = new Set(store.getSheets().map((sheet) => sheet.id));
  await command(store, identity, { type: 'sheet:create', characterName });
  const created = store.getSheets().find((sheet) => !before.has(sheet.id));
  assert.ok(created, 'sheet:create must persist a sheet');
  return created;
}

function dataOf(store: RoomStore, sheetId: string): NechronicaSheetData {
  const sheet = store.getSheet(sheetId);
  assert.ok(sheet, 'sheet must exist');
  return parseNechronicaSheetData(sheet.systemData);
}

function createAsset(store: RoomStore, id: string): void {
  store.createAsset({
    id, sha256: `hash-${id}`, mimeType: 'image/png', originalName: `${id}.png`,
    size: 4, width: 10, height: 10,
  });
}

function rollEntry(id: string, overrides: Partial<DiceRollEntry> = {}): DiceRollEntry {
  return {
    id, authorId: gm.participantId, authorName: gm.name, actorId: gm.participantId, actorName: gm.name,
    createdAt: new Date(2026, 0, 1, 0, 0, Number(id.replace(/\D/g, '') || 0)).toISOString(),
    kind: 'free', systemId: null, systemVersion: null, dice: [], keptDice: [], discardedDie: null,
    characteristicName: null, characterId: null, characterOwnerId: null, characteristicBonus: null,
    situationalModifier: 0, disadvantage: false, sides: null, total: 0, category: null, critical: null,
    rerollOf: null, abilityId: null, abilitySheetId: null, abilityCharacterName: null, abilityName: null,
    abilityAssetId: null, abilitySummary: null, abilityDescription: null, abilityFontFamily: null,
    reference: null, ...overrides,
  };
}

/* ---------- Registration, versioning and schema ---------- */

test('1. nechronica@1.2.0 is the latest registered version with sheet schema 3', async () => {
  const latest = findLatestSystemMetadata('nechronica');
  assert.equal(latest?.version, '1.2.0');
  assert.equal(latest?.sheetSchemaVersion, 3);
  assert.equal(systemMetadataOptions().find((entry) => entry.id === 'nechronica')?.version, '1.2.0');
  const module = await loadSystemServer('nechronica', '1.2.0');
  assert.equal(module.advancedSheet, true);
  assert.equal(parseNechronicaSheetData(module.sheetDefaults().systemData).schemaVersion, 3);
  const frozen = await loadSystemServer('nechronica', '1.1.0');
  assert.equal(frozen.advancedSheet, true);
  const frozenRaw = frozen.sheetDefaults().systemData as { schemaVersion?: number };
  assert.equal(frozenRaw.schemaVersion, 2, 'the frozen 1.1.0 module keeps schema 2');
  assert.equal(parseNechronicaSheetData(frozenRaw).schemaVersion, 3, 'reading schema 2 through 1.2.0 migrates it');
});

test('2. nechronica@1.0.0 rooms keep opening with the old placeholder sheet', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-nechronica-legacy-'));
  const store = new RoomStore(dataDir, 'Legacy');
  try {
    store.initializeSystem('nechronica', '1.0.0');
    const module = await loadSystemServer('nechronica', '1.0.0');
    assert.equal(module.advancedSheet, false);
    const sheet = await createSheet(store, gm, 'Old doll');
    assert.equal(sheet.systemVersion, '1.0.0');
    assert.equal(sheet.systemData, null);
    assert.deepEqual(sheet.characteristics, {});
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('3. new Nechronica rooms are created on 1.2.0 by default', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-nechronica-create-'));
  try {
    const defaultDir = join(dataDir, 'rooms', 'default');
    const defaultStore = new RoomStore(defaultDir, 'Default');
    defaultStore.initializeSystem('nechronica', '1.1.0');
    defaultStore.close();
    await initializeDefaultRoom({ dataDir, roomName: 'Default', roomCode: 'OLDCODE2', gmPassword: 'old-password-123' });
    const created = await createRoom({ dataDir, name: 'New Nechronica', systemId: 'nechronica', gmPassword: 'password-12345' });
    assert.equal(created.room.systemId, 'nechronica');
    assert.equal(created.room.systemVersion, '1.2.0');
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('4. default system data creates all sections and four empty body zones', () =>
  withStore('defaults', async (store) => {
    const sheet = await createSheet(store, gm);
    const data = dataOf(store, sheet.id);
    assert.equal(data.schemaVersion, 3);
    assert.deepEqual(data.profile, { maxAp: 0, currentAp: 0, deployment: null, approval: 0 });
    assert.deepEqual(data.abilities, []);
    assert.deepEqual(Object.keys(data.bodyParts).sort(), ['arms', 'head', 'legs', 'torso']);
    assert.ok(Object.values(data.bodyParts).every((parts) => parts.length === 0));
    assert.deepEqual(data.fetters, []);
    assert.deepEqual(data.memories, []);
  }));

test('5. parse normalizes malformed persisted payloads without throwing', () => {
  const parsed = parseNechronicaSheetData({
    schemaVersion: 'broken', profile: { maxAp: -4, currentAp: 1.5, deployment: 'moon' },
    abilities: 'nope', bodyParts: { head: [{ name: 7 }] }, fetters: [{}], info: null, memories: [null],
  });
  assert.equal(parsed.schemaVersion, 3);
  assert.deepEqual(parsed.profile, { maxAp: 0, currentAp: 0, deployment: null, approval: 0 });
  assert.deepEqual(parsed.abilities, []);
  assert.equal(parsed.bodyParts.head.length, 1);
  assert.equal(parsed.bodyParts.head[0]!.id, 'legacy-1');
  assert.deepEqual(parsed.fetters[0]!.spentMadness, [false, false, false, false]);
  assert.deepEqual(parsed.memories, []);
});

test('6. additive migration upgrades schemaVersion to 3 and keeps known fields', () => {
  const parsed = parseNechronicaSheetData({
    schemaVersion: 1,
    profile: { maxAp: 7, currentAp: 5, deployment: 'limbo', approval: 2 },
    info: { position: 'Backline' },
  });
  assert.equal(parsed.schemaVersion, 3);
  assert.equal(parsed.profile.maxAp, 7);
  assert.equal(parsed.profile.currentAp, 5);
  assert.equal(parsed.profile.deployment, 'limbo');
  assert.equal(parsed.info.position, 'Backline');
});

test('7. Nechronica never populates PbtA characteristics, fate, counters or abilities', () =>
  withStore('pbta-fields', async (store) => {
    const sheet = await createSheet(store, gm);
    assert.deepEqual(sheet.characteristics, {});
    assert.equal(sheet.fate, 0);
    assert.deepEqual(sheet.counters, []);
    assert.deepEqual(sheet.abilities, []);
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:update', id: sheet.id, changes: { characteristics: { might: 1 } } }),
      /Nechronica не использует/,
    );
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:update', id: sheet.id, changes: { fate: 2 } }),
      /Nechronica не использует/,
    );
  }));

/* ---------- Header: AP, Deployment and Favor ---------- */

test('8. AP, Deployment and Favor start at zero/null', () =>
  withStore('header-defaults', async (store) => {
    const sheet = await createSheet(store, gm);
    const data = dataOf(store, sheet.id);
    assert.equal(data.profile.maxAp, 0);
    assert.equal(data.profile.currentAp, 0);
    assert.equal(data.profile.deployment, null);
    assert.equal(data.profile.approval, 0);
  }));

test('9. GM edits Maximum AP and Current AP manually', () =>
  withStore('ap-gm', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:ap', sheetId: sheet.id, maxAp: 12, currentAp: 9 });
    const data = dataOf(store, sheet.id);
    assert.equal(data.profile.maxAp, 12);
    assert.equal(data.profile.currentAp, 9);
  }));

test('10. AP never recalculates when abilities are used or body parts destroyed', () =>
  withStore('ap-manual', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:ap', sheetId: sheet.id, maxAp: 10, currentAp: 6 });
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities', item: { name: 'Slash' } });
    const abilityId = dataOf(store, sheet.id).abilities[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'head', item: { name: 'Eye' } });
    const partId = dataOf(store, sheet.id).bodyParts.head[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'abilities', id: abilityId, used: true });
    await command(store, gm, { type: 'sheet:nechronica:destroyed', sheetId: sheet.id, zone: 'head', id: partId, destroyed: true });
    const data = dataOf(store, sheet.id);
    assert.equal(data.profile.maxAp, 10);
    assert.equal(data.profile.currentAp, 6);
  }));

test('11. an assigned player can edit AP on their own sheet', () =>
  withStore('ap-owner', async (store) => {
    const sheet = await createSheet(store, player, 'My doll');
    await command(store, player, { type: 'sheet:nechronica:ap', sheetId: sheet.id, maxAp: 8, currentAp: 4 });
    const data = dataOf(store, sheet.id);
    assert.equal(data.profile.maxAp, 8);
    assert.equal(data.profile.currentAp, 4);
  }));

test('12. an unassigned creator loses edit rights until the GM assigns the sheet', () =>
  withStore('ap-unassigned', async (store) => {
    const sheet = await createSheet(store, player, 'Detached doll');
    await command(store, gm, { type: 'sheet:assign', id: sheet.id, playerId: null });
    await assert.rejects(
      () => command(store, player, { type: 'sheet:nechronica:ap', sheetId: sheet.id, maxAp: 3 }),
      /назначенный/,
    );
  }));

test('13. another player cannot edit AP on someone else\'s sheet', () =>
  withStore('ap-foreign', async (store) => {
    const sheet = await createSheet(store, player, 'Ari doll');
    await assert.rejects(
      () => command(store, otherPlayer, { type: 'sheet:nechronica:ap', sheetId: sheet.id, maxAp: 3 }),
      /назначенный/,
    );
  }));

test('14. GM edits Deployment and Favor through the profile command', () =>
  withStore('profile-gm', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:profile', sheetId: sheet.id, deployment: 'eden', approval: 4 });
    const data = dataOf(store, sheet.id);
    assert.equal(data.profile.deployment, 'eden');
    assert.equal(data.profile.approval, 4);
  }));

test('15. Deployment accepts eden, elysium, limbo and null', () =>
  withStore('profile-values', async (store) => {
    const sheet = await createSheet(store, gm);
    for (const deployment of ['eden', 'elysium', 'limbo'] as const) {
      await command(store, gm, { type: 'sheet:nechronica:profile', sheetId: sheet.id, deployment });
      assert.equal(dataOf(store, sheet.id).profile.deployment, deployment);
    }
    await command(store, gm, { type: 'sheet:nechronica:profile', sheetId: sheet.id, deployment: null });
    assert.equal(dataOf(store, sheet.id).profile.deployment, null);
  }));

test('16. profile rejects an unknown Deployment', () =>
  withStore('profile-invalid', async (store) => {
    const sheet = await createSheet(store, gm);
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:profile', sheetId: sheet.id, deployment: 'heaven' }),
      /Deployment/,
    );
  }));

test('17. Favor persists and is independent from AP', () =>
  withStore('favor-independent', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:ap', sheetId: sheet.id, maxAp: 5, currentAp: 3 });
    await command(store, gm, { type: 'sheet:nechronica:profile', sheetId: sheet.id, approval: 7 });
    await command(store, gm, { type: 'sheet:nechronica:ap', sheetId: sheet.id, currentAp: 1 });
    const data = dataOf(store, sheet.id);
    assert.equal(data.profile.approval, 7);
    assert.equal(data.profile.maxAp, 5);
    assert.equal(data.profile.currentAp, 1);
  }));

test('18. AP rejects negative and non-integer values', () =>
  withStore('ap-invalid-number', async (store) => {
    const sheet = await createSheet(store, gm);
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:ap', sheetId: sheet.id, maxAp: -1 }),
      /Maximum AP/,
    );
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:ap', sheetId: sheet.id, currentAp: 1.5 }),
      /Current AP/,
    );
  }));

test('19. AP rejects unknown fields', () =>
  withStore('ap-extra', async (store) => {
    const sheet = await createSheet(store, gm);
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:ap', sheetId: sheet.id, maxAp: 1, extra: true }),
      /Некорректная команда/,
    );
  }));

test('20. profile rejects unknown fields', () =>
  withStore('profile-extra', async (store) => {
    const sheet = await createSheet(store, gm);
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:profile', sheetId: sheet.id, approval: 1, extra: true }),
      /Некорректная команда/,
    );
  }));

test('21. info saves every character field and rejects unknown keys', () =>
  withStore('info', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, {
      type: 'sheet:nechronica:info', sheetId: sheet.id,
      changes: {
        position: 'Front', mainClass: 'Alice', secondaryClass: 'Joker', premonition: 'A storm',
        armaments: 3, mutations: 2, enhancements: 1, notes: 'Keep the doll smiling.',
      },
    });
    const data = dataOf(store, sheet.id);
    assert.deepEqual(data.info, {
      position: 'Front', mainClass: 'Alice', secondaryClass: 'Joker', premonition: 'A storm',
      armaments: 3, mutations: 2, enhancements: 1, notes: 'Keep the doll smiling.',
    });
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:info', sheetId: sheet.id, changes: { unknown: 'x' } }),
      /неизвестное поле/,
    );
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:info', sheetId: sheet.id, changes: { armaments: 1.5 } }),
      /Вооружение/,
    );
  }));

/* ---------- Abilities ---------- */

test('22. ability create stores ID, image and every field with Used=false', () =>
  withStore('ability-create', async (store) => {
    createAsset(store, 'art-ability');
    const sheet = await createSheet(store, gm);
    await command(store, gm, {
      type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities',
      item: {
        imageAssetId: 'art-ability', name: 'Bone blade', source: 'Alice', type: 'Attack',
        timing: 'Major', cost: '2 AP', range: 'Melee', effect: 'Deal 2 damage.',
      },
    });
    const ability = dataOf(store, sheet.id).abilities[0]!;
    assert.ok(ability.id.length > 0);
    assert.equal(ability.imageAssetId, 'art-ability');
    assert.equal(ability.name, 'Bone blade');
    assert.equal(ability.source, 'Alice');
    assert.equal(ability.type, 'Attack');
    assert.equal(ability.timing, 'Major');
    assert.equal(ability.cost, '2 AP');
    assert.equal(ability.range, 'Melee');
    assert.equal(ability.effect, 'Deal 2 damage.');
    assert.equal(ability.used, false);
  }));

test('23. ability create rejects an image asset that does not belong to the room', () =>
  withStore('ability-asset', async (store) => {
    const sheet = await createSheet(store, gm);
    await assert.rejects(
      () => command(store, gm, {
        type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities',
        item: { imageAssetId: 'foreign-art', name: 'Ghost' },
      }),
      /изображение недоступно/,
    );
  }));

test('24. ability update changes editable fields but never Used', () =>
  withStore('ability-update', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities', item: { name: 'Old' } });
    const id = dataOf(store, sheet.id).abilities[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'abilities', id, used: true });
    await command(store, gm, {
      type: 'sheet:nechronica:update', sheetId: sheet.id, collection: 'abilities', id,
      changes: { name: 'New', source: 'Joker', type: 'Buff', timing: 'Reaction', cost: '0', range: 'Self', effect: 'Shine.' },
    });
    const ability = dataOf(store, sheet.id).abilities[0]!;
    assert.equal(ability.name, 'New');
    assert.equal(ability.effect, 'Shine.');
    assert.equal(ability.used, true);
    await assert.rejects(
      () => command(store, gm, {
        type: 'sheet:nechronica:update', sheetId: sheet.id, collection: 'abilities', id, changes: { used: false },
      }),
      /неизвестное поле/,
    );
  }));

test('25. ability Used toggles independently of AP and other abilities', () =>
  withStore('ability-used', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:ap', sheetId: sheet.id, maxAp: 5, currentAp: 5 });
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities', item: { name: 'First' } });
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities', item: { name: 'Second' } });
    const [first, second] = dataOf(store, sheet.id).abilities;
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'abilities', id: first!.id, used: true });
    const data = dataOf(store, sheet.id);
    assert.equal(data.abilities.find((entry) => entry.id === first!.id)?.used, true);
    assert.equal(data.abilities.find((entry) => entry.id === second!.id)?.used, false);
    assert.equal(data.profile.currentAp, 5);
  }));

test('26. ability Used rejects non-boolean values', () =>
  withStore('ability-used-invalid', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities', item: { name: 'First' } });
    const id = dataOf(store, sheet.id).abilities[0]!.id;
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'abilities', id, used: 'yes' }),
      /Used/,
    );
  }));

test('27. ability delete removes only the requested ability', () =>
  withStore('ability-delete', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities', item: { name: 'Keep' } });
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities', item: { name: 'Remove' } });
    const removeId = dataOf(store, sheet.id).abilities.find((entry) => entry.name === 'Remove')!.id;
    await command(store, gm, { type: 'sheet:nechronica:delete', sheetId: sheet.id, collection: 'abilities', id: removeId });
    const abilities = dataOf(store, sheet.id).abilities;
    assert.equal(abilities.length, 1);
    assert.equal(abilities[0]!.name, 'Keep');
  }));

test('28. ability reorder accepts an exact permutation', () =>
  withStore('ability-reorder', async (store) => {
    const sheet = await createSheet(store, gm);
    for (const name of ['A', 'B', 'C']) {
      await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities', item: { name } });
    }
    const ids = dataOf(store, sheet.id).abilities.map((entry) => entry.id);
    await command(store, gm, { type: 'sheet:nechronica:reorder', sheetId: sheet.id, collection: 'abilities', ids: [ids[2], ids[0], ids[1]] });
    assert.deepEqual(dataOf(store, sheet.id).abilities.map((entry) => entry.name), ['C', 'A', 'B']);
  }));

test('29. ability reorder rejects duplicates, omissions and foreign ids', () =>
  withStore('ability-reorder-invalid', async (store) => {
    const sheet = await createSheet(store, gm);
    for (const name of ['A', 'B']) {
      await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities', item: { name } });
    }
    const [a, b] = dataOf(store, sheet.id).abilities;
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:reorder', sheetId: sheet.id, collection: 'abilities', ids: [a!.id, a!.id] }),
      /Порядок способностей/,
    );
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:reorder', sheetId: sheet.id, collection: 'abilities', ids: [a!.id] }),
      /Порядок способностей/,
    );
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:reorder', sheetId: sheet.id, collection: 'abilities', ids: [a!.id, b!.id, 'foreign'] }),
      /Порядок способностей/,
    );
    assert.deepEqual(dataOf(store, sheet.id).abilities.map((entry) => entry.name), ['A', 'B']);
  }));

test('30. reset Used clears abilities only', () =>
  withStore('ability-reset', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities', item: { name: 'Slash' } });
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'head', item: { name: 'Eye' } });
    const abilityId = dataOf(store, sheet.id).abilities[0]!.id;
    const partId = dataOf(store, sheet.id).bodyParts.head[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'abilities', id: abilityId, used: true });
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'body', zone: 'head', id: partId, used: true });
    await command(store, gm, { type: 'sheet:nechronica:reset-used', sheetId: sheet.id, collection: 'abilities' });
    const data = dataOf(store, sheet.id);
    assert.equal(data.abilities[0]!.used, false);
    assert.equal(data.bodyParts.head[0]!.used, true);
  }));

test('31. ability reference card snapshots the full effect and leaves Used/AP untouched', () =>
  withStore('ability-reference', async (store) => {
    const longEffect = 'Я'.repeat(300);
    createAsset(store, 'ability-art');
    createAsset(store, 'ability-art-2');
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:ap', sheetId: sheet.id, maxAp: 6, currentAp: 2 });
    await command(store, gm, {
      type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities',
      item: { name: 'Long', source: 'Alice', timing: 'Major', cost: '1 AP', range: 'Near', effect: longEffect, imageAssetId: 'ability-art' },
    });
    const id = dataOf(store, sheet.id).abilities[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'abilities', id, used: true });
    await command(store, gm, { type: 'sheet:nechronica:reference', sheetId: sheet.id, kind: 'ability', id });
    const roll = store.getDiceRolls()[0]!;
    assert.equal(roll.kind, 'sheet-reference');
    assert.equal(roll.systemId, 'nechronica');
    assert.equal(roll.systemVersion, '1.2.0');
    assert.equal(roll.reference?.type, 'ability');
    assert.equal(roll.reference?.imageAssetId, 'ability-art');
    assert.equal(roll.reference?.name, 'Long');
    assert.equal(roll.reference?.description, longEffect);
    assert.equal(roll.reference?.source, 'Alice');
    assert.equal(roll.reference?.timing, 'Major');
    assert.equal(roll.reference?.cost, '1 AP');
    assert.equal(roll.reference?.range, 'Near');
    assert.deepEqual(roll.dice, []);
    const data = dataOf(store, sheet.id);
    assert.equal(data.abilities[0]!.used, true);
    assert.equal(data.profile.currentAp, 2);
    // The frozen snapshot is independent from later sheet edits, and the old
    // asset stays undeletable while the history card references it.
    await command(store, gm, {
      type: 'sheet:nechronica:update', sheetId: sheet.id, collection: 'abilities', id,
      changes: { imageAssetId: 'ability-art-2' },
    });
    assert.equal(dataOf(store, sheet.id).abilities[0]!.imageAssetId, 'ability-art-2');
    assert.equal(store.getDiceRolls()[0]!.reference?.imageAssetId, 'ability-art');
    assert.equal(store.getAssetUsage('ability-art').some((entry) => entry.kind === 'dice-reference' && entry.count === 1), true);
    assert.equal(store.deleteAssetIfUnused('ability-art'), false);
    assert.equal(store.deleteAssetIfUnused('ability-art-2'), false);
  }));

test('32. ability reference snapshot survives later edits', () =>
  withStore('ability-reference-snapshot', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities', item: { name: 'Before', effect: 'Old effect' } });
    const id = dataOf(store, sheet.id).abilities[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:reference', sheetId: sheet.id, kind: 'ability', id });
    await command(store, gm, {
      type: 'sheet:nechronica:update', sheetId: sheet.id, collection: 'abilities', id, changes: { name: 'After', effect: 'New effect' },
    });
    const roll = store.getDiceRolls()[0]!;
    assert.equal(roll.reference?.name, 'Before');
    assert.equal(roll.reference?.description, 'Old effect');
    assert.equal(dataOf(store, sheet.id).abilities[0]!.name, 'After');
  }));

/* ---------- Body ---------- */

test('33. body has four fixed zones and creates parts only in the requested zone', () =>
  withStore('body-zones', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'head', item: { name: 'Eye' } });
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'legs', item: { name: 'Foot' } });
    const data = dataOf(store, sheet.id);
    assert.deepEqual(Object.keys(data.bodyParts).sort(), ['arms', 'head', 'legs', 'torso']);
    assert.deepEqual(data.bodyParts.head.map((part) => part.name), ['Eye']);
    assert.deepEqual(data.bodyParts.legs.map((part) => part.name), ['Foot']);
    assert.deepEqual(data.bodyParts.arms, []);
    assert.deepEqual(data.bodyParts.torso, []);
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'tail', item: { name: 'Tail' } }),
      /зона тела/i,
    );
  }));

test('34. body part create initializes Used=false and Destroyed=false', () =>
  withStore('body-create', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, {
      type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'torso',
      item: { name: 'Core', timing: 'Passive', cost: '0', range: 'Self', effect: 'Keep beating.' },
    });
    const part = dataOf(store, sheet.id).bodyParts.torso[0]!;
    assert.ok(part.id.length > 0);
    assert.equal(part.name, 'Core');
    assert.equal(part.timing, 'Passive');
    assert.equal(part.cost, '0');
    assert.equal(part.range, 'Self');
    assert.equal(part.effect, 'Keep beating.');
    assert.equal(part.used, false);
    assert.equal(part.destroyed, false);
  }));

test('35. body part update changes fields but never Used or Destroyed', () =>
  withStore('body-update', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'arms', item: { name: 'Arm' } });
    const id = dataOf(store, sheet.id).bodyParts.arms[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'body', zone: 'arms', id, used: true });
    await command(store, gm, { type: 'sheet:nechronica:destroyed', sheetId: sheet.id, zone: 'arms', id, destroyed: true });
    await command(store, gm, {
      type: 'sheet:nechronica:update', sheetId: sheet.id, collection: 'body', zone: 'arms', id,
      changes: { name: 'Claw', timing: 'Minor', cost: '1', range: 'Near', effect: 'Rend.' },
    });
    const part = dataOf(store, sheet.id).bodyParts.arms[0]!;
    assert.equal(part.name, 'Claw');
    assert.equal(part.effect, 'Rend.');
    assert.equal(part.used, true);
    assert.equal(part.destroyed, true);
    await assert.rejects(
      () => command(store, gm, {
        type: 'sheet:nechronica:update', sheetId: sheet.id, collection: 'body', zone: 'arms', id, changes: { destroyed: false },
      }),
      /неизвестное поле/,
    );
  }));

test('36. Used and Destroyed are independent per body part', () =>
  withStore('body-flags', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'legs', item: { name: 'Leg' } });
    const id = dataOf(store, sheet.id).bodyParts.legs[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'body', zone: 'legs', id, used: true });
    assert.deepEqual(
      { used: dataOf(store, sheet.id).bodyParts.legs[0]!.used, destroyed: dataOf(store, sheet.id).bodyParts.legs[0]!.destroyed },
      { used: true, destroyed: false },
    );
    await command(store, gm, { type: 'sheet:nechronica:destroyed', sheetId: sheet.id, zone: 'legs', id, destroyed: true });
    assert.deepEqual(
      { used: dataOf(store, sheet.id).bodyParts.legs[0]!.used, destroyed: dataOf(store, sheet.id).bodyParts.legs[0]!.destroyed },
      { used: true, destroyed: true },
    );
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'body', zone: 'legs', id, used: false });
    assert.deepEqual(
      { used: dataOf(store, sheet.id).bodyParts.legs[0]!.used, destroyed: dataOf(store, sheet.id).bodyParts.legs[0]!.destroyed },
      { used: false, destroyed: true },
    );
  }));

test('37. body reorder works inside one zone and rejects cross-zone ids', () =>
  withStore('body-reorder', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'head', item: { name: 'Eye' } });
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'head', item: { name: 'Ear' } });
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'arms', item: { name: 'Hand' } });
    const head = dataOf(store, sheet.id).bodyParts.head;
    const handId = dataOf(store, sheet.id).bodyParts.arms[0]!.id;
    await command(store, gm, {
      type: 'sheet:nechronica:reorder', sheetId: sheet.id, collection: 'body', zone: 'head', ids: [head[1]!.id, head[0]!.id],
    });
    assert.deepEqual(dataOf(store, sheet.id).bodyParts.head.map((part) => part.name), ['Ear', 'Eye']);
    await assert.rejects(
      () => command(store, gm, {
        type: 'sheet:nechronica:reorder', sheetId: sheet.id, collection: 'body', zone: 'head', ids: [head[0]!.id, handId],
      }),
      /Порядок частей тела/,
    );
  }));

test('38. reset Used for one zone leaves other zones intact', () =>
  withStore('body-reset-zone', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'head', item: { name: 'Eye' } });
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'arms', item: { name: 'Hand' } });
    const headId = dataOf(store, sheet.id).bodyParts.head[0]!.id;
    const armId = dataOf(store, sheet.id).bodyParts.arms[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'body', zone: 'head', id: headId, used: true });
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'body', zone: 'arms', id: armId, used: true });
    await command(store, gm, { type: 'sheet:nechronica:reset-used', sheetId: sheet.id, collection: 'body', zone: 'head' });
    const data = dataOf(store, sheet.id);
    assert.equal(data.bodyParts.head[0]!.used, false);
    assert.equal(data.bodyParts.arms[0]!.used, true);
  }));

test('39. reset all body Used keeps every Destroyed flag and other tabs', () =>
  withStore('body-reset-all', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'head', item: { name: 'Eye' } });
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'torso', item: { name: 'Core' } });
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities', item: { name: 'Slash' } });
    const headId = dataOf(store, sheet.id).bodyParts.head[0]!.id;
    const torsoId = dataOf(store, sheet.id).bodyParts.torso[0]!.id;
    const abilityId = dataOf(store, sheet.id).abilities[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'body', zone: 'head', id: headId, used: true });
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'body', zone: 'torso', id: torsoId, used: true });
    await command(store, gm, { type: 'sheet:nechronica:destroyed', sheetId: sheet.id, zone: 'head', id: headId, destroyed: true });
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'abilities', id: abilityId, used: true });
    await command(store, gm, { type: 'sheet:nechronica:reset-used', sheetId: sheet.id, collection: 'body' });
    const data = dataOf(store, sheet.id);
    assert.equal(data.bodyParts.head[0]!.used, false);
    assert.equal(data.bodyParts.torso[0]!.used, false);
    assert.equal(data.bodyParts.head[0]!.destroyed, true);
    assert.equal(data.bodyParts.torso[0]!.destroyed, false);
    assert.equal(data.abilities[0]!.used, true);
  }));

test('40. body reference card leaves Used and Destroyed unchanged', () =>
  withStore('body-reference', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, {
      type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'body', zone: 'arms',
      item: { name: 'Claw', timing: 'Minor', cost: '1', range: 'Near', effect: 'Rend armor.' },
    });
    const id = dataOf(store, sheet.id).bodyParts.arms[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:used', sheetId: sheet.id, collection: 'body', zone: 'arms', id, used: true });
    await command(store, gm, { type: 'sheet:nechronica:destroyed', sheetId: sheet.id, zone: 'arms', id, destroyed: true });
    await command(store, gm, { type: 'sheet:nechronica:reference', sheetId: sheet.id, kind: 'body', zone: 'arms', id });
    const roll = store.getDiceRolls()[0]!;
    assert.equal(roll.reference?.type, 'body');
    assert.equal(roll.reference?.name, 'Claw');
    assert.equal(roll.reference?.description, 'Rend armor.');
    const part = dataOf(store, sheet.id).bodyParts.arms[0]!;
    assert.equal(part.used, true);
    assert.equal(part.destroyed, true);
  }));

/* ---------- Fetters and madness ---------- */

test('41. fetter create starts with four unchecked madness boxes', () =>
  withStore('fetter-create', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, {
      type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'fetters',
      item: { target: 'Sister', fetter: 'Family', madness: 'Clinging', description: 'She remembers.' },
    });
    const fetter = dataOf(store, sheet.id).fetters[0]!;
    assert.ok(fetter.id.length > 0);
    assert.equal(fetter.target, 'Sister');
    assert.equal(fetter.fetter, 'Family');
    assert.equal(fetter.madness, 'Clinging');
    assert.equal(fetter.description, 'She remembers.');
    assert.deepEqual(fetter.spentMadness, [false, false, false, false]);
    assert.equal(isBrokenHeart(fetter), false);
  }));

test('42. each madness box toggles independently', () =>
  withStore('fetter-boxes', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'fetters', item: { target: 'Sister' } });
    const id = dataOf(store, sheet.id).fetters[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:madness', sheetId: sheet.id, id, index: 0, checked: true });
    await command(store, gm, { type: 'sheet:nechronica:madness', sheetId: sheet.id, id, index: 2, checked: true });
    assert.deepEqual(dataOf(store, sheet.id).fetters[0]!.spentMadness, [true, false, true, false]);
  }));

test('43. Broken Heart is derived when all four boxes are checked', () =>
  withStore('fetter-broken', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'fetters', item: { target: 'Sister' } });
    const id = dataOf(store, sheet.id).fetters[0]!.id;
    for (const index of [0, 1, 2, 3]) {
      await command(store, gm, { type: 'sheet:nechronica:madness', sheetId: sheet.id, id, index, checked: true });
    }
    const fetter = dataOf(store, sheet.id).fetters[0]!;
    assert.deepEqual(fetter.spentMadness, [true, true, true, true]);
    assert.equal(isBrokenHeart(fetter), true);
  }));

test('44. unchecking one box cancels Broken Heart', () =>
  withStore('fetter-cancel', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'fetters', item: { target: 'Sister' } });
    const id = dataOf(store, sheet.id).fetters[0]!.id;
    for (const index of [0, 1, 2, 3]) {
      await command(store, gm, { type: 'sheet:nechronica:madness', sheetId: sheet.id, id, index, checked: true });
    }
    await command(store, gm, { type: 'sheet:nechronica:madness', sheetId: sheet.id, id, index: 1, checked: false });
    assert.equal(isBrokenHeart(dataOf(store, sheet.id).fetters[0]!), false);
  }));

test('45. fetter update keeps spent madness boxes', () =>
  withStore('fetter-update', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'fetters', item: { target: 'Sister' } });
    const id = dataOf(store, sheet.id).fetters[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:madness', sheetId: sheet.id, id, index: 0, checked: true });
    await command(store, gm, { type: 'sheet:nechronica:madness', sheetId: sheet.id, id, index: 3, checked: true });
    await command(store, gm, {
      type: 'sheet:nechronica:update', sheetId: sheet.id, collection: 'fetters', id,
      changes: { target: 'Brother', fetter: 'Promise', madness: 'Fear', description: 'He left.' },
    });
    const fetter = dataOf(store, sheet.id).fetters[0]!;
    assert.equal(fetter.target, 'Brother');
    assert.equal(fetter.fetter, 'Promise');
    assert.equal(fetter.madness, 'Fear');
    assert.equal(fetter.description, 'He left.');
    assert.deepEqual(fetter.spentMadness, [true, false, false, true]);
  }));

test('46. fetter reference card snapshots madnessSpent and leaves boxes unchanged', () =>
  withStore('fetter-reference', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, {
      type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'fetters',
      item: { target: 'Sister', fetter: 'Family', madness: 'Clinging', description: 'She remembers.' },
    });
    const id = dataOf(store, sheet.id).fetters[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:madness', sheetId: sheet.id, id, index: 0, checked: true });
    await command(store, gm, { type: 'sheet:nechronica:madness', sheetId: sheet.id, id, index: 2, checked: true });
    await command(store, gm, { type: 'sheet:nechronica:reference', sheetId: sheet.id, kind: 'fetter', id });
    const roll = store.getDiceRolls()[0]!;
    assert.equal(roll.reference?.type, 'fetter');
    assert.equal(roll.reference?.name, 'Sister');
    assert.equal(roll.reference?.fetter, 'Family');
    assert.equal(roll.reference?.madness, 'Clinging');
    assert.equal(roll.reference?.madnessSpent, 2);
    assert.equal(roll.reference?.description, 'She remembers.');
    assert.deepEqual(dataOf(store, sheet.id).fetters[0]!.spentMadness, [true, false, true, false]);
  }));

test('47. madness command rejects an out-of-range index and non-boolean value', () =>
  withStore('fetter-invalid', async (store) => {
    const sheet = await createSheet(store, gm);
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'fetters', item: { target: 'Sister' } });
    const id = dataOf(store, sheet.id).fetters[0]!.id;
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:madness', sheetId: sheet.id, id, index: 4, checked: true }),
      /ячейка безумия/,
    );
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:madness', sheetId: sheet.id, id, index: 0, checked: 'yes' }),
      /ячейка безумия/,
    );
  }));

/* ---------- Memories ---------- */

test('48. memory create stores name, number, content and an optional image', () =>
  withStore('memory-create', async (store) => {
    const sheet = await createSheet(store, gm);
    createAsset(store, 'memory-asset');
    await command(store, gm, {
      type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'memories',
      item: { name: 'The garden', number: 3, content: 'A warm afternoon before the end.', imageAssetId: 'memory-asset' },
    });
    const memory = dataOf(store, sheet.id).memories[0]!;
    assert.ok(memory.id.length > 0);
    assert.equal(memory.imageAssetId, 'memory-asset');
    assert.equal(memory.name, 'The garden');
    assert.equal(memory.number, 3);
    assert.equal(memory.content, 'A warm afternoon before the end.');
    await command(store, gm, {
      type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'memories',
      item: { name: 'No picture', number: 4 },
    });
    assert.equal(dataOf(store, sheet.id).memories[1]!.imageAssetId, null);
    await assert.rejects(
      () => command(store, gm, {
        type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'memories',
        item: { name: 'Foreign', imageAssetId: 'missing-asset' },
      }),
      /Изображение воспоминания/,
    );
  }));

test('49. memory update persists fields and validates the number', () =>
  withStore('memory-update', async (store) => {
    const sheet = await createSheet(store, gm);
    createAsset(store, 'memory-image');
    await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'memories', item: { name: 'Old', number: 1 } });
    const id = dataOf(store, sheet.id).memories[0]!.id;
    await command(store, gm, {
      type: 'sheet:nechronica:update', sheetId: sheet.id, collection: 'memories', id,
      changes: { name: 'New', number: 9, content: 'Rewritten.', imageAssetId: 'memory-image' },
    });
    const memory = dataOf(store, sheet.id).memories[0]!;
    assert.equal(memory.name, 'New');
    assert.equal(memory.number, 9);
    assert.equal(memory.content, 'Rewritten.');
    assert.equal(memory.imageAssetId, 'memory-image');
    await command(store, gm, {
      type: 'sheet:nechronica:update', sheetId: sheet.id, collection: 'memories', id,
      changes: { imageAssetId: null },
    });
    assert.equal(dataOf(store, sheet.id).memories[0]!.imageAssetId, null);
    await assert.rejects(
      () => command(store, gm, {
        type: 'sheet:nechronica:update', sheetId: sheet.id, collection: 'memories', id,
        changes: { imageAssetId: 'not-in-room' },
      }),
      /Изображение воспоминания/,
    );
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:update', sheetId: sheet.id, collection: 'memories', id, changes: { number: 1.5 } }),
      /Номер воспоминания/,
    );
    await assert.rejects(
      () => command(store, gm, { type: 'sheet:nechronica:update', sheetId: sheet.id, collection: 'memories', id, changes: { number: -1 } }),
      /Номер воспоминания/,
    );
  }));

test('50. memory delete and reorder change only the memory list', () =>
  withStore('memory-order', async (store) => {
    const sheet = await createSheet(store, gm);
    for (const [name, number] of [['A', 1], ['B', 2], ['C', 3]] as const) {
      await command(store, gm, { type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'memories', item: { name, number } });
    }
    const ids = dataOf(store, sheet.id).memories.map((memory) => memory.id);
    await command(store, gm, {
      type: 'sheet:nechronica:reorder', sheetId: sheet.id, collection: 'memories', ids: [ids[2], ids[1], ids[0]],
    });
    assert.deepEqual(dataOf(store, sheet.id).memories.map((memory) => memory.name), ['C', 'B', 'A']);
    await command(store, gm, { type: 'sheet:nechronica:delete', sheetId: sheet.id, collection: 'memories', id: ids[1] });
    assert.deepEqual(dataOf(store, sheet.id).memories.map((memory) => memory.name), ['C', 'A']);
  }));

/* ---------- Permissions, isolation and assets ---------- */

test('51. GM edits any sheet while players are limited to assigned sheets', () =>
  withStore('permissions', async (store) => {
    const draft = await createSheet(store, gm, 'Draft');
    const owned = await createSheet(store, player, 'Owned');
    await command(store, gm, { type: 'sheet:nechronica:ap', sheetId: draft.id, maxAp: 4 });
    await command(store, gm, { type: 'sheet:nechronica:ap', sheetId: owned.id, maxAp: 6 });
    await command(store, player, { type: 'sheet:nechronica:ap', sheetId: owned.id, currentAp: 2 });
    assert.equal(dataOf(store, draft.id).profile.maxAp, 4);
    assert.equal(dataOf(store, owned.id).profile.maxAp, 6);
    assert.equal(dataOf(store, owned.id).profile.currentAp, 2);
    await assert.rejects(
      () => command(store, player, { type: 'sheet:nechronica:ap', sheetId: draft.id, maxAp: 1 }),
      /назначенный/,
    );
    await assert.rejects(
      () => command(store, otherPlayer, { type: 'sheet:nechronica:ap', sheetId: owned.id, maxAp: 1 }),
      /назначенный/,
    );
  }));

test('52. Nechronica commands are rejected on PbtA and old Nechronica sheets', async () => {
  const pbtaDir = mkdtempSync(join(tmpdir(), 'tabletop-nechronica-pbta-'));
  const legacyDir = mkdtempSync(join(tmpdir(), 'tabletop-nechronica-old-'));
  const pbtaStore = new RoomStore(pbtaDir, 'PbtA');
  const legacyStore = new RoomStore(legacyDir, 'Legacy');
  try {
    pbtaStore.initializeSystem('pbta-2d6', '1.0.0');
    const pbtaSheet = await createSheet(pbtaStore, gm, 'Hero');
    await assert.rejects(
      () => command(pbtaStore, gm, { type: 'sheet:nechronica:ap', sheetId: pbtaSheet.id, maxAp: 1 }),
      /Неизвестная команда листа персонажа/,
    );

    legacyStore.initializeSystem('nechronica', '1.0.0');
    const legacySheet = await createSheet(legacyStore, gm, 'Old doll');
    await assert.rejects(
      () => command(legacyStore, gm, { type: 'sheet:nechronica:ap', sheetId: legacySheet.id, maxAp: 1 }),
      /расширенный лист/,
    );
  } finally {
    pbtaStore.close();
    legacyStore.close();
    rmSync(pbtaDir, { recursive: true, force: true });
    rmSync(legacyDir, { recursive: true, force: true });
  }
});

test('53. shared history keeps ten events and preserves rerollOf', () =>
  withStore('history', async (store) => {
    for (let index = 1; index <= 9; index += 1) {
      store.saveDiceRoll(rollEntry(`ref-${index}`, { kind: 'sheet-reference', reference: {
        type: 'ability', imageAssetId: null, name: `Card ${index}`, source: null, timing: null, cost: null, range: null,
        target: null, fetter: null, madness: null, madnessSpent: null, description: '',
      } }));
    }
    store.saveDiceRoll(rollEntry('roll-10', { kind: 'free', rerollOf: 'root-roll' }));
    for (let index = 11; index <= 12; index += 1) {
      store.saveDiceRoll(rollEntry(`ref-${index}`, { kind: 'sheet-reference', reference: {
        type: 'ability', imageAssetId: null, name: `Card ${index}`, source: null, timing: null, cost: null, range: null,
        target: null, fetter: null, madness: null, madnessSpent: null, description: '',
      } }));
    }
    const rolls = store.getDiceRolls();
    assert.equal(rolls.length, 10);
    assert.equal(rolls[0]!.id, 'ref-12');
    assert.equal(rolls.some((roll) => roll.id === 'ref-1'), false);
    const kept = rolls.find((roll) => roll.id === 'roll-10');
    assert.ok(kept);
    assert.equal(kept!.rerollOf, 'root-roll');
  }));

test('54. systemData assets are protected and the 1.1.0 client exposes five tabs', () =>
  withStore('assets', async (store) => {
    createAsset(store, 'art-sheet');
    const sheet = await createSheet(store, gm, 'Asset doll');
    await command(store, gm, {
      type: 'sheet:nechronica:create', sheetId: sheet.id, collection: 'abilities',
      item: { imageAssetId: 'art-sheet', name: 'Blade' },
    });
    store.assignSheet(sheet.id, player.participantId, player.name);
    const usage = store.getAssetUsage('art-sheet');
    assert.equal(usage.some((entry) => entry.kind === 'sheet-system' && entry.count === 1), true);
    assert.equal(store.deleteAssetIfUnused('art-sheet'), false);
    assert.equal(store.canReadAsset('art-sheet', player), true);
    const abilityId = dataOf(store, sheet.id).abilities[0]!.id;
    await command(store, gm, { type: 'sheet:nechronica:delete', sheetId: sheet.id, collection: 'abilities', id: abilityId });
    assert.equal(store.deleteAssetIfUnused('art-sheet'), true);

    const clientSource = readFileSync('src/modules/system/nechronica/client-1.1.0.ts', 'utf8');
    for (const tab of ['Способности', 'Тело', 'Узы и безумие', 'Инфо', 'Память']) {
      assert.match(clientSource, new RegExp(tab));
    }
    assert.match(clientSource, /ownsProfile: true/);
    assert.match(clientSource, /openPersonalNotes\(\)/);
    assert.match(clientSource, /sheet:nechronica:reference/);
    const appSource = readFileSync('src/client/app.ts', 'utf8');
    assert.match(appSource, /renderSheetReferenceEntry/);
  }));

test('55. the 1.2.0 sheet and history expose the reviewed layout and roll UI', () => {
  const client = readFileSync('src/modules/system/nechronica/client-1.2.0.ts', 'utf8');
  const css = readFileSync('src/styles/global.css', 'utf8');
  const app = readFileSync('src/client/app.ts', 'utf8');

  // Centered tabs and a single portrait/name header.
  assert.match(css, /\.nechronica-tabs \{[^}]*justify-content: center/);
  assert.match(client, /nechronica-profile-editor/);
  assert.doesNotMatch(client, /'nechronica-name'/, 'the name is not rendered twice');

  // Used/Destroyed come from the server model, Destroyed wins.
  assert.match(client, /ability\.used \? 'is-used'/);
  assert.match(client, /part\.used \? 'is-used'/);
  assert.match(client, /part\.destroyed \? 'is-destroyed'/);
  assert.match(css, /\.nechronica-table tr\.is-used:not\(\.is-destroyed\)/);
  assert.match(css, /\.nechronica-table tr\.is-destroyed \{/);
  assert.match(css, /\.nechronica-table tr\.is-destroyed td \{[^}]*text-decoration: line-through/);

  // Horizontal memory: image, name, number, description, actions.
  assert.match(css, /\.nechronica-memory \{[^}]*grid-template-columns: 34px minmax\(90px, 160px\) minmax\(28px, max-content\) minmax\(0, 1fr\) auto/);
  assert.match(client, /item\.append\(image, name, number, text, rowActions/);
  assert.match(client, /nechronica-memory-thumb/);

  // One shared long-text component with internal scrolling.
  assert.match(css, /\.nechronica-longtext \{[^}]*max-height: 4\.2em/);
  assert.match(css, /\.nechronica-longtext \{[^}]*overflow-y: auto/);
  assert.match(css, /\.nechronica-longtext \{[^}]*overscroll-behavior: contain/);
  assert.match(css, /\.nechronica-longtext \{[^}]*overflow-wrap: anywhere/);
  assert.match(client, /nechronica-effect-text nechronica-longtext/);
  assert.match(app, /dice-entry-reference-description/);

  // The roll card and its image snapshot.
  assert.match(app, /function renderNechronicaEntry/);
  assert.match(app, /reference\?\.imageAssetId/);
  assert.match(app, /dice-reference-image/);
  assert.match(client, /dice:nechronica/);
  assert.match(client, /1d10/);
  assert.match(css, /\.dice-entry-nechronica\.is-critical-failure/);
  assert.match(css, /\.dice-entry-nechronica\.is-critical-success/);
});
