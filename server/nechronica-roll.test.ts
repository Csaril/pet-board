import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  calculateNechronicaRoll,
  NECHRONICA_BONUS_LIMIT,
  NECHRONICA_ROLL_SIDES,
  type NechronicaRollResult,
} from '../src/modules/system/nechronica/roll.js';
import { executeSheetCommand } from './sheets.js';
import { RoomStore, type Identity } from './store.js';
import { loadSystemServer } from './system-registry.js';
import { BoardCommandError, SYSTEM_MISMATCH } from './board.js';

const GM: Identity = { participantId: 'gm-1', name: 'Keeper', role: 'gm' };
const PLAYER: Identity = { participantId: 'player-1', name: 'Ari', role: 'player' };

function withStore(label: string, run: (store: RoomStore) => void | Promise<void>): Promise<void> {
  return (async () => {
    const dataDir = mkdtempSync(join(tmpdir(), `tabletop-nechronica-roll-${label}-`));
    const store = new RoomStore(dataDir, 'Campaign');
    try {
      store.initializeSystem('nechronica', '1.2.0');
      store.createSession('gm-session', { name: GM.name, role: 'gm' }, Date.now() + 60_000);
      store.createSession('player-session', { name: PLAYER.name, role: 'player' }, Date.now() + 60_000);
      await run(store);
    } finally {
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  })();
}

const fixed = (value: number) => (min: number, max: number): number => {
  assert.equal(min, 1);
  assert.equal(max, NECHRONICA_ROLL_SIDES + 1);
  return value;
};

function expectRoll(bonus: number, natural: number): NechronicaRollResult {
  return calculateNechronicaRoll(bonus, fixed(natural));
}

async function createRoll(
  store: RoomStore,
  identity: Identity,
  command: Record<string, unknown>,
  randomInt: (min: number, max: number) => number,
  activeSystem = { id: 'nechronica', version: '1.2.0' },
) {
  const module = await loadSystemServer(activeSystem.id, activeSystem.version);
  assert.ok(module.createRoll, 'the target module must expose a roll');
  return module.createRoll({ store, identity, command, activeSystem, randomInt });
}

test('1d10 natural values are always 1..10 and never come from the client', () => {
  const seen = new Set<number>();
  for (let value = 1; value <= 10; value += 1) {
    const result = expectRoll(0, value);
    assert.equal(result.natural, value);
    assert.equal(result.bonus, 0);
    seen.add(result.natural);
  }
  assert.equal(seen.size, 10);
  assert.throws(() => calculateNechronicaRoll(0, () => 0), /вне диапазона d10/);
  assert.throws(() => calculateNechronicaRoll(0, () => 11), /вне диапазона d10/);
  assert.throws(() => calculateNechronicaRoll(0, () => 4.5), /вне диапазона d10/);
});

test('bonus 0, positive and negative bonuses apply to ordinary rolls', () => {
  assert.deepEqual(expectRoll(0, 4), {
    natural: 4, bonus: 0, bonusApplied: true, total: 4, category: 'failure', critical: null,
  });
  assert.deepEqual(expectRoll(2, 4), {
    natural: 4, bonus: 2, bonusApplied: true, total: 6, category: 'success', critical: null,
  });
  assert.deepEqual(expectRoll(-3, 8), {
    natural: 8, bonus: -3, bonusApplied: true, total: 5, category: 'failure', critical: null,
  });
});

test('natural 1 is always a critical failure and ignores any bonus', () => {
  for (const bonus of [-100, -1, 0, 1, 5, 100]) {
    assert.deepEqual(expectRoll(bonus, 1), {
      natural: 1, bonus, bonusApplied: false, total: 1, category: 'failure', critical: 'critical-failure',
    });
  }
});

test('natural 10 is always a critical success and ignores any bonus', () => {
  for (const bonus of [-100, -1, 0, 1, 5, 100]) {
    assert.deepEqual(expectRoll(bonus, 10), {
      natural: 10, bonus, bonusApplied: false, total: 10, category: 'success', critical: 'critical-success',
    });
  }
});

test('ordinary totals are never clamped and only the natural die is critical', () => {
  // ≤5 fails, ≥6 succeeds; a modified 1 or 10 is not critical.
  assert.deepEqual(expectRoll(-10, 2), {
    natural: 2, bonus: -10, bonusApplied: true, total: -8, category: 'failure', critical: null,
  });
  assert.deepEqual(expectRoll(10, 2), {
    natural: 2, bonus: 10, bonusApplied: true, total: 12, category: 'success', critical: null,
  });
  assert.deepEqual(expectRoll(-10, 9), {
    natural: 9, bonus: -10, bonusApplied: true, total: -1, category: 'failure', critical: null,
  });
  assert.deepEqual(expectRoll(10, 9), {
    natural: 9, bonus: 10, bonusApplied: true, total: 19, category: 'success', critical: null,
  });
  const table: Array<[number, number, number, string]> = [
    [1, 5, 1, 'failure'],
    [10, -5, 10, 'success'],
    [3, 2, 5, 'failure'],
    [4, 2, 6, 'success'],
    [8, -3, 5, 'failure'],
    [7, 2, 9, 'success'],
  ];
  for (const [natural, bonus, total, category] of table) {
    const result = expectRoll(bonus, natural);
    assert.equal(result.total, total);
    assert.equal(result.category, category);
  }
});

test('the bonus must be a safe integer and the boundary is enforced', () => {
  assert.equal(expectRoll(NECHRONICA_BONUS_LIMIT, 5).total, 5 + NECHRONICA_BONUS_LIMIT);
  assert.equal(expectRoll(-NECHRONICA_BONUS_LIMIT, 5).total, 5 - NECHRONICA_BONUS_LIMIT);
  for (const bonus of [0.5, Number.NaN, Number.POSITIVE_INFINITY, NECHRONICA_BONUS_LIMIT + 1]) {
    assert.throws(() => calculateNechronicaRoll(bonus, fixed(5)), /Некорректный бонус/);
  }
});

test('the server roll stores the natural die, bonus, total, category, author and time', () =>
  withStore('store', async (store) => {
    const player = store.getSession('player-session')!;
    const entry = await createRoll(store, player, { type: 'dice:nechronica', bonus: 2 }, fixed(4));
    assert.equal(entry.kind, 'nechronica');
    assert.equal(entry.systemId, 'nechronica');
    assert.equal(entry.systemVersion, '1.2.0');
    assert.deepEqual(entry.dice, [4]);
    assert.deepEqual(entry.keptDice, [4]);
    assert.equal(entry.sides, 10);
    assert.equal(entry.characteristicBonus, 2);
    assert.equal(entry.total, 6);
    assert.equal(entry.category, 'success');
    assert.equal(entry.critical, null);
    assert.equal(entry.authorId, player.participantId);
    assert.equal(entry.actorId, player.participantId);
    assert.match(entry.createdAt, /^\d{4}-\d{2}-\d{2}T/);
    store.saveDiceRoll(entry);
    const stored = store.getDiceRolls()[0]!;
    assert.equal(stored.kind, 'nechronica');
    assert.deepEqual(stored.dice, [4]);
    assert.equal(stored.characteristicBonus, 2);
    assert.equal(stored.total, 6);
    assert.equal(stored.category, 'success');
    assert.equal(stored.critical, null);
  }));

test('critical results are stored with the bonus that was ignored', () =>
  withStore('critical', async (store) => {
    const player = store.getSession('player-session')!;
    const failure = await createRoll(store, player, { type: 'dice:nechronica', bonus: 5 }, fixed(1));
    assert.equal(failure.total, 1);
    assert.equal(failure.category, 'failure');
    assert.equal(failure.critical, 'critical-failure');
    assert.equal(failure.characteristicBonus, 5);
    const success = await createRoll(store, player, { type: 'dice:nechronica', bonus: -5 }, fixed(10));
    assert.equal(success.total, 10);
    assert.equal(success.category, 'success');
    assert.equal(success.critical, 'critical-success');
    assert.equal(success.characteristicBonus, -5);
  }));

test('a client cannot submit dice, totals, categories or critical flags', () =>
  withStore('client-fields', async (store) => {
    const player = store.getSession('player-session')!;
    for (const extra of [
      { dice: [10] }, { total: 10 }, { category: 'success' }, { critical: 'critical-success' },
      { keptDice: [10] }, { sides: 10 }, { systemId: 'nechronica' },
    ]) {
      await assert.rejects(
        () => createRoll(store, player, { type: 'dice:nechronica', bonus: 0, ...extra }, fixed(3)),
        (error: unknown) => error instanceof BoardCommandError,
      );
    }
    await assert.rejects(
      () => createRoll(store, player, { type: 'dice:nechronica', bonus: '2' }, fixed(3)),
      /безопасным целым числом/,
    );
    await assert.rejects(
      () => createRoll(store, player, { type: 'dice:nechronica', bonus: 0.5 }, fixed(3)),
      /безопасным целым числом/,
    );
  }));

test('a GM may roll for a connected player, a player may not impersonate another', () =>
  withStore('actors', async (store) => {
    const gm = store.getSession('gm-session')!;
    const player = store.getSession('player-session')!;
    const gmEntry = await createRoll(store, gm, { type: 'dice:nechronica', bonus: 0, actorId: player.participantId }, fixed(6));
    assert.equal(gmEntry.authorId, gm.participantId);
    assert.equal(gmEntry.actorId, player.participantId);
    assert.equal(gmEntry.actorName, player.name);
    await assert.rejects(
      () => createRoll(store, gm, { type: 'dice:nechronica', bonus: 0, actorId: 'missing' }, fixed(6)),
      /Выберите игрока/,
    );
    await assert.rejects(
      () => createRoll(store, player, { type: 'dice:nechronica', bonus: 0, actorId: gm.participantId }, fixed(6)),
      /только за себя/,
    );
    const own = await createRoll(store, player, { type: 'dice:nechronica', bonus: 0, actorId: player.participantId }, fixed(6));
    assert.equal(own.actorId, player.participantId);
  }));

test('PbtA rejects the Nechronica roll and the room system, not the client, decides', async () => {
  const pbta = await loadSystemServer('pbta-2d6', '1.0.0');
  const frozen = await loadSystemServer('nechronica', '1.1.0');
  assert.equal(pbta.handlesRollCommand?.('dice:nechronica'), false);
  assert.equal(frozen.handlesRollCommand?.('dice:nechronica'), undefined);
  assert.equal(frozen.createRoll, undefined, 'the frozen 1.1.0 module cannot create a 1d10 roll');
  await withStore('isolation', async (store) => {
    const player = store.getSession('player-session')!;
    // PbtA itself rejects the unknown command type.
    await assert.rejects(
      () => createRoll(store, player, { type: 'dice:nechronica', bonus: 0 }, fixed(5), { id: 'pbta-2d6', version: '1.0.0' }),
      (error: unknown) => error instanceof BoardCommandError,
    );
    // Even the Nechronica module checks the pinned room pair and cannot be
    // tricked into serving a PbtA or older room.
    const latest = await loadSystemServer('nechronica', '1.2.0');
    assert.ok(latest.createRoll);
    for (const activeSystem of [
      { id: 'pbta-2d6', version: '1.0.0' },
      { id: 'nechronica', version: '1.1.0' },
    ]) {
      assert.throws(
        () => latest.createRoll!({ store, identity: player, command: { type: 'dice:nechronica', bonus: 0 }, activeSystem, randomInt: fixed(5) }),
        (error: unknown) => error instanceof BoardCommandError && error.code === SYSTEM_MISMATCH,
      );
    }
  });
});

test('Nechronica rolls share the ten-entry history with old and PbtA records', () =>
  withStore('history', async (store) => {
    const player = store.getSession('player-session')!;
    for (let index = 0; index < 12; index += 1) {
      const entry = await createRoll(store, player, { type: 'dice:nechronica', bonus: index }, () => 1 + (index % 10));
      store.saveDiceRoll(entry);
    }
    const rolls = store.getDiceRolls();
    assert.equal(rolls.length, 10);
    assert.ok(rolls.every((roll) => roll.kind === 'nechronica'));
    assert.equal(rolls[0]!.characteristicBonus, 11);
    assert.equal(rolls.some((roll) => roll.characteristicBonus === 0), false);
  }));

test('sheet commands remain isolated from the roll command', () =>
  withStore('sheet-command', async (store) => {
    const player = store.getSession('player-session')!;
    const gm = store.getSession('gm-session')!;
    await assert.rejects(
      () => executeSheetCommand(store, player, { type: 'dice:nechronica', bonus: 0 }),
      (error: unknown) => error instanceof BoardCommandError,
    );
    await executeSheetCommand(store, gm, { type: 'sheet:create', characterName: 'Doll' });
    const sheet = store.getSheets()[0]!;
    await assert.rejects(
      () => executeSheetCommand(store, player, { type: 'sheet:update', id: sheet.id, changes: { characterName: 'Hacked' } }),
      (error: unknown) => error instanceof BoardCommandError,
    );
  }));
