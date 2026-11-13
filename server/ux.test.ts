import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { DiceRollEntry } from '../src/shared/board.js';
import { abilityEventSummary } from '../src/shared/ability-history.js';
import { BOARD_FONT_OPTIONS, canvasFontFamily, cssFontFamily, DEFAULT_BOARD_FONT, isBoardFontFamily } from '../src/shared/fonts.js';
import { menuIsWithin, overflowGroupCount, placePopover } from '../src/shared/menu.js';
import { executeBoardCommand } from './board.js';
import { executeSheetCommand } from './sheets.js';
import { RoomStore, type Identity } from './store.js';

const gm: Identity = { participantId: 'gm-ux', name: 'Keeper', role: 'gm' };
const owner: Identity = { participantId: 'player-owner', name: 'Ari', role: 'player' };
const stranger: Identity = { participantId: 'player-stranger', name: 'Bea', role: 'player' };

function temporaryStore(): { store: RoomStore; dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-ux-'));
  const store = new RoomStore(dataDir, 'Campaign');
  store.initializeSystem('pbta-2d6', '1.0.0');
  return { store, dataDir, cleanup: () => { store.close(); rmSync(dataDir, { recursive: true, force: true }); } };
}

function createAssignedSheet(store: RoomStore): { sheetId: string; abilityId: string } {
  const sheetId = `sheet-ability-history-${randomUUID()}`;
  store.createSheet({
    id: sheetId, creatorId: owner.participantId, creatorName: owner.name,
    assignedPlayerId: owner.participantId, assignedPlayerName: owner.name,
    systemId: 'pbta-2d6', systemVersion: '1.0.0', schemaVersion: 1,
    characterName: 'Ари', portraitAssetId: null,
    characteristics: { might: 1, insight: -1, glory: 2, will: 0 },
    fate: 3,
  });
  const ability = store.createAbility(sheetId, {
    id: `ability-fireball-${randomUUID()}`, name: 'Огненный шар',
    description: 'Метает огненный шар.\nТратит один заряд.', assetId: null,
    counterEnabled: true, counterName: 'Заряды', counterValue: 2,
    checkboxEnabled: true, checkboxLabel: 'Использовано', checked: true,
    fontFamily: 'caveat',
  });
  return { sheetId, abilityId: ability.id };
}

function diceEntry(patch: Partial<DiceRollEntry> & Pick<DiceRollEntry, 'id' | 'createdAt'>): DiceRollEntry {
  return {
    authorId: gm.participantId, authorName: gm.name, actorId: gm.participantId, actorName: gm.name,
    kind: 'free', systemId: null, systemVersion: null,
    dice: [1, 2], keptDice: [1, 2], discardedDie: null, characteristicName: null,
    characterId: null, characterOwnerId: null, characteristicBonus: null, situationalModifier: 0,
    disadvantage: false, sides: 6, total: 3, category: null, critical: null, rerollOf: null,
    abilityId: null, abilitySheetId: null, abilityCharacterName: null, abilityName: null,
    abilityAssetId: null, abilitySummary: null, abilityDescription: null, abilityFontFamily: null,
    ...patch,
  };
}

test('ability history scenarios 1-12: snapshot, permissions and untouched counters', async (t) => {
  const { store, cleanup } = temporaryStore();
  try {
    const { sheetId, abilityId } = createAssignedSheet(store);

    await t.test('1. Владелец листа применяет способность', () => {
      executeSheetCommand(store, owner, { type: 'sheet:ability:apply', sheetId, id: abilityId });
      const entries = store.getDiceRolls();
      assert.equal(entries.length, 1);
      assert.equal(entries[0]!.kind, 'ability-use');
    });

    await t.test('2. Событие хранит снимок ID события, способности и листа', () => {
      const entry = store.getDiceRolls()[0]!;
      assert.match(entry.id, /^[0-9a-f-]{36}$/);
      assert.equal(entry.abilityId, abilityId);
      assert.equal(entry.abilitySheetId, sheetId);
      assert.equal(entry.characterId, sheetId);
    });

    await t.test('3. Снимок содержит имена, описание, автора, время и шрифт', () => {
      const entry = store.getDiceRolls()[0]!;
      assert.equal(entry.abilityCharacterName, 'Ари');
      assert.equal(entry.abilityName, 'Огненный шар');
      assert.equal(entry.abilitySummary, 'Метает огненный шар.');
      assert.equal(entry.abilityDescription, 'Метает огненный шар.\nТратит один заряд.');
      assert.equal(entry.abilityFontFamily, 'caveat');
      assert.equal(entry.authorName, 'Ari');
      assert.ok(!Number.isNaN(Date.parse(entry.createdAt)));
    });

    await t.test('4. Ведущий может применить способность чужого листа', () => {
      executeSheetCommand(store, gm, { type: 'sheet:ability:apply', sheetId, id: abilityId });
      const entry = store.getDiceRolls()[0]!;
      assert.equal(entry.authorName, 'Keeper');
      assert.equal(entry.actorName, 'Ari');
      assert.equal(entry.actorId, owner.participantId);
    });

    await t.test('5. Чужой игрок не может применить способность', () => {
      assert.throws(
        () => executeSheetCommand(store, stranger, { type: 'sheet:ability:apply', sheetId, id: abilityId }),
        /только назначенный вам лист/i,
      );
    });

    await t.test('6. Неизвестная способность отклоняется', () => {
      assert.throws(
        () => executeSheetCommand(store, owner, { type: 'sheet:ability:apply', sheetId, id: 'missing' }),
        /Способность не найдена/i,
      );
    });

    await t.test('7. Применение не меняет числовой счётчик способности', () => {
      const ability = store.getSheet(sheetId)!.abilities.find((entry) => entry.id === abilityId)!;
      assert.equal(ability.counterValue, 2);
    });

    await t.test('8. Применение не меняет чекбокс способности', () => {
      const ability = store.getSheet(sheetId)!.abilities.find((entry) => entry.id === abilityId)!;
      assert.equal(ability.checked, true);
    });

    await t.test('9. Применение не бросает кубики', () => {
      const entry = store.getDiceRolls()[0]!;
      assert.deepEqual(entry.dice, []);
      assert.deepEqual(entry.keptDice, []);
      assert.equal(entry.sides, null);
      assert.equal(entry.total, 0);
      assert.equal(entry.discardedDie, null);
    });

    await t.test('10. Событие не участвует в цепочке повторных бросков', () => {
      assert.equal(store.getDiceRolls()[0]!.rerollOf, null);
    });

    await t.test('11. Команда не принимает лишние поля', () => {
      assert.throws(
        () => executeSheetCommand(store, owner, { type: 'sheet:ability:apply', sheetId, id: abilityId, counterValue: 0 }),
        /Некорректная команда применения/i,
      );
    });

    await t.test('12. Снимок не зависит от последующего изменения способности', () => {
      const before = store.getDiceRolls()[0]!;
      executeSheetCommand(store, owner, { type: 'sheet:ability:update', sheetId, id: abilityId, changes: { name: 'Новое имя' } });
      const after = store.getDiceRolls()[0]!;
      assert.equal(after.abilityName, before.abilityName);
      assert.equal(after.abilityDescription, before.abilityDescription);
    });
  } finally { cleanup(); }
});

test('history limit and fonts scenarios 13-22', async (t) => {
  const { store, cleanup } = temporaryStore();
  try {
    await t.test('13. Общая история ограничена десятью последними событиями', () => {
      for (let index = 0; index < 12; index += 1) {
        store.saveDiceRoll(diceEntry({ id: `roll-${index}`, createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`, total: index }));
      }
      assert.equal(store.getDiceRolls().length, 10);
    });

    await t.test('14. При одиннадцатом событии удаляется самое старое независимо от типа', () => {
      const { sheetId, abilityId } = createAssignedSheet(store);
      for (let index = 0; index < 10; index += 1) {
        store.saveDiceRoll(diceEntry({ id: `mixed-${index}`, createdAt: `2026-02-01T00:00:${String(index).padStart(2, '0')}.000Z` }));
      }
      executeSheetCommand(store, owner, { type: 'sheet:ability:apply', sheetId, id: abilityId });
      const entries = store.getDiceRolls();
      assert.equal(entries.length, 10);
      assert.equal(entries.some((entry) => entry.id === 'mixed-0'), false);
      assert.equal(entries[0]!.kind, 'ability-use');
    });

    await t.test('15. Лимит сохраняет rerollOf у оставшихся записей', () => {
      const { sheetId, abilityId } = createAssignedSheet(store);
      for (let index = 0; index < 4; index += 1) {
        store.saveDiceRoll(diceEntry({ id: `chain-${index}`, createdAt: `2026-03-01T00:00:0${index}.000Z` }));
      }
      store.saveDiceRoll(diceEntry({ id: 'chain-reroll', createdAt: '2026-03-01T00:00:05.000Z', rerollOf: 'chain-2' }));
      const reroll = store.getDiceRolls().find((entry) => entry.id === 'chain-reroll');
      assert.equal(reroll?.rerollOf, 'chain-2');
      executeSheetCommand(store, owner, { type: 'sheet:ability:apply', sheetId, id: abilityId });
      const kept = store.getDiceRolls().find((entry) => entry.id === 'chain-reroll');
      assert.equal(kept?.rerollOf, 'chain-2');
    });

    await t.test('16. Миграция старой истории сохраняет строки и связи rerollOf', () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-ux-dice-'));
      const legacy = new Database(join(dataDir, 'room.sqlite'));
      legacy.exec(`
        CREATE TABLE room (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO room (id, name) VALUES (1, 'Legacy');
        CREATE TABLE dice_rolls (
          id TEXT PRIMARY KEY, author_id TEXT NOT NULL, author_name TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL,
          created_at TEXT NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('pbta', 'free')), dice_json TEXT NOT NULL,
          kept_dice_json TEXT NOT NULL, discarded_die INTEGER, characteristic_name TEXT, character_id TEXT, character_owner_id TEXT,
          characteristic_bonus INTEGER, situational_modifier INTEGER NOT NULL DEFAULT 0 CHECK (situational_modifier IN (-1, 0, 1)),
          disadvantage INTEGER NOT NULL DEFAULT 0 CHECK (disadvantage IN (0, 1)), sides INTEGER, total INTEGER NOT NULL,
          category TEXT CHECK (category IN ('failure', 'success', 'triumph')),
          critical TEXT CHECK (critical IN ('critical-failure', 'critical-success')), reroll_of TEXT
        );
        INSERT INTO dice_rolls VALUES ('original', 'p', 'Ari', 'p', 'Ari', '2026-01-01T00:00:00.000Z', 'pbta', '[3,4]', '[3,4]', NULL, 'Focus', NULL, NULL, 1, 0, 0, 6, 8, 'success', NULL, NULL);
        INSERT INTO dice_rolls VALUES ('rerolled', 'p', 'Ari', 'p', 'Ari', '2026-01-01T00:00:01.000Z', 'pbta', '[4,5]', '[4,5]', NULL, 'Focus', NULL, NULL, 1, 0, 0, 6, 10, 'success', NULL, 'original');
      `);
      legacy.close();
      const migrated = new RoomStore(dataDir, 'Legacy');
      try {
        const entries = migrated.getDiceRolls();
        assert.deepEqual(entries.map((entry) => entry.id).sort(), ['original', 'rerolled']);
        assert.equal(entries.find((entry) => entry.id === 'rerolled')!.rerollOf, 'original');
        assert.equal(entries[0]!.abilityId, null);
      } finally { migrated.close(); rmSync(dataDir, { recursive: true, force: true }); }
    });

    await t.test('17. После миграции CHECK допускает ability-use', () => {
      const { store: fresh, cleanup: freshCleanup } = temporaryStore();
      try {
        assert.doesNotThrow(() => fresh.saveDiceRoll(diceEntry({
          id: 'ability-row', createdAt: '2026-04-01T00:00:00.000Z', kind: 'ability-use',
          systemId: 'pbta-2d6', systemVersion: '1.0.0',
          abilityId: 'a', abilitySheetId: 's', abilityCharacterName: 'Ari', abilityName: 'Skill',
          abilitySummary: 'Short', abilityDescription: 'Long', abilityFontFamily: 'caveat',
        })));
        assert.equal(fresh.getDiceRolls()[0]!.kind, 'ability-use');
      } finally { freshCleanup(); }
    });

    await t.test('18. Старые заметки, стикеры, листы и способности получают стандартный шрифт', () => {
      const dataDir = mkdtempSync(join(tmpdir(), 'tabletop-ux-legacy-'));
      const legacy = new Database(join(dataDir, 'room.sqlite'));
      legacy.exec(`
        CREATE TABLE room (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
        INSERT INTO room (id, name) VALUES (1, 'Legacy');
        CREATE TABLE notes (id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL, access TEXT NOT NULL,
          selected_participant_ids TEXT NOT NULL, created_by TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        INSERT INTO notes VALUES ('note-old', 'Старая заметка', 'Текст', 'gm-only', '[]', 'gm', '2026-01-01', '2026-01-01');
        CREATE TABLE stickers (id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, layer_id TEXT NOT NULL, text TEXT NOT NULL,
          x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL NOT NULL,
          bg_color TEXT NOT NULL CHECK (bg_color IN ('butter', 'rose', 'sky', 'sage')),
          text_color TEXT NOT NULL CHECK (text_color IN ('black', 'white')), font_size INTEGER NOT NULL, order_index INTEGER NOT NULL);
        INSERT INTO stickers VALUES ('sticker-old', 'p', 'layer-legacy', 'Saved', 1, 2, 240, 140, 'sky', 'black', 24, 0);
        CREATE TABLE character_sheets (id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, creator_name TEXT NOT NULL,
          assigned_player_id TEXT, assigned_player_name TEXT, system_id TEXT NOT NULL, system_version TEXT NOT NULL,
          schema_version INTEGER NOT NULL, character_name TEXT NOT NULL DEFAULT '', portrait_asset_id TEXT,
          characteristics_json TEXT NOT NULL, fate INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
        INSERT INTO character_sheets VALUES ('sheet-old', 'p', 'Ari', 'p', 'Ari', 'pbta-2d6', '1.0.0', 1, 'Ари', NULL,
          '{"agility":1,"charm":0,"combat":0,"intellect":0,"presence":0,"toughness":0}', 0, '2026-01-01', '2026-01-01');
        CREATE TABLE character_abilities (id TEXT PRIMARY KEY, sheet_id TEXT NOT NULL, name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '', asset_id TEXT, counter_enabled INTEGER NOT NULL DEFAULT 0,
          counter_name TEXT NOT NULL DEFAULT '', counter_value INTEGER NOT NULL DEFAULT 0,
          checkbox_enabled INTEGER NOT NULL DEFAULT 0, checkbox_label TEXT NOT NULL DEFAULT '',
          checked INTEGER NOT NULL DEFAULT 0, order_index INTEGER NOT NULL);
        INSERT INTO character_abilities VALUES ('ability-old', 'sheet-old', 'Старая', 'Описание', NULL, 0, '', 0, 0, '', 0, 0);
      `);
      legacy.close();
      const migrated = new RoomStore(dataDir, 'Legacy');
      try {
        assert.equal(migrated.getNote('note-old')!.fontFamily, 'default');
        assert.equal(migrated.getSticker('sticker-old')!.fontFamily, 'default');
        assert.equal(migrated.getSheet('sheet-old')!.fontFamily, 'default');
        assert.equal(migrated.getSheet('sheet-old')!.abilities[0]!.fontFamily, 'default');
      } finally { migrated.close(); rmSync(dataDir, { recursive: true, force: true }); }
    });

    await t.test('19. Шрифт стикера сохраняется и читается', () => {
      executeBoardCommand(store, gm, {
        type: 'sticker:create', layerId: store.getLayers()[0]!.id, text: 'Caveat', x: 0, y: 0,
        fontFamily: 'caveat',
      });
      const sticker = store.getStickers().find((entry) => entry.text === 'Caveat')!;
      assert.equal(sticker.fontFamily, 'caveat');
    });

    await t.test('20. Шрифт заметки сохраняется и читается', () => {
      store.createNote({
        id: 'note-font', title: 'Шрифт', body: 'Текст заметки', access: 'gm-only',
        selectedParticipantIds: [], creatorId: gm.participantId, assetIds: [], fontFamily: 'caveat',
      });
      assert.equal(store.getNote('note-font')!.fontFamily, 'caveat');
    });

    await t.test('21. Шрифт листа и способности сохраняется через команды', () => {
      const { sheetId, abilityId } = createAssignedSheet(store);
      executeSheetCommand(store, owner, { type: 'sheet:update', id: sheetId, changes: { fontFamily: 'caveat' } });
      executeSheetCommand(store, owner, { type: 'sheet:ability:update', sheetId, id: abilityId, changes: { fontFamily: 'default' } });
      assert.equal(store.getSheet(sheetId)!.fontFamily, 'caveat');
      assert.equal(store.getSheet(sheetId)!.abilities.find((entry) => entry.id === abilityId)!.fontFamily, 'default');
    });

    await t.test('22. Неизвестный шрифт отклоняется для стикера, листа и способности', () => {
      const { sheetId, abilityId } = createAssignedSheet(store);
      assert.throws(
        () => executeBoardCommand(store, gm, { type: 'sticker:create', layerId: store.getLayers()[0]!.id, text: 'X', x: 0, y: 0, fontFamily: 'comic' }),
        /Недопустимый шрифт стикера/i,
      );
      assert.throws(
        () => executeSheetCommand(store, owner, { type: 'sheet:update', id: sheetId, changes: { fontFamily: 'comic' } }),
        /Недопустимый шрифт/i,
      );
      assert.throws(
        () => executeSheetCommand(store, owner, { type: 'sheet:ability:update', sheetId, id: abilityId, changes: { fontFamily: 'comic' } }),
        /Недопустимый шрифт/i,
      );
    });
  } finally { cleanup(); }
});

test('shared helpers and UI scenarios 23-29', async (t) => {
  const indexSource = readFileSync('src/pages/index.astro', 'utf8');
  const clientSource = readFileSync('src/client/app.ts', 'utf8');
  const styleSource = readFileSync('src/styles/global.css', 'utf8');

  await t.test('23. Краткое описание берёт первую непустую строку', () => {
    assert.equal(abilityEventSummary('\n  Первая строка\nВторая'), 'Первая строка');
    assert.equal(abilityEventSummary(''), 'Без описания');
  });

  await t.test('24. Длинное краткое описание обрезается с многоточием', () => {
    const summary = abilityEventSummary('а'.repeat(300), 40);
    assert.equal(summary.length, 40);
    assert.ok(summary.endsWith('…'));
  });

  await t.test('25. Меню открывается вверх при нехватке места снизу', () => {
    const placement = placePopover(
      { top: 700, bottom: 734, left: 100, right: 180 },
      { width: 240, height: 300 },
      { width: 1200, height: 800 },
    );
    assert.equal(placement.side, 'top');
    assert.equal(placement.top, 700 - 8 - 300);
  });

  await t.test('26. Меню остаётся внутри границ экрана', () => {
    const placement = placePopover(
      { top: 20, bottom: 54, left: 1150, right: 1190 },
      { width: 260, height: 150 },
      { width: 1200, height: 800 },
    );
    assert.equal(placement.side, 'bottom');
    assert.equal(placement.left, 1200 - 260 - 12);
    assert.ok(placement.left >= 12);
  });

  await t.test('27. overflowGroupCount переносит хвостовые группы целиком', () => {
    assert.equal(overflowGroupCount([100, 100, 100], 320, 10), 0);
    assert.equal(overflowGroupCount([100, 100, 100], 200, 0), 1);
    assert.equal(overflowGroupCount([100, 100, 100], 50, 10), 3);
  });

  await t.test('28. Шрифты подключены локально, а верхняя панель и меню размечены', () => {
    assert.deepEqual(BOARD_FONT_OPTIONS.map((option) => option.value), ['default', 'caveat']);
    assert.equal(DEFAULT_BOARD_FONT, 'default');
    assert.equal(isBoardFontFamily('caveat'), true);
    assert.equal(isBoardFontFamily('lobster'), false);
    assert.match(cssFontFamily('caveat'), /Caveat/);
    assert.match(canvasFontFamily('default'), /system-ui/);
    assert.ok(existsSync('public/fonts/Caveat-VariableFont_wght.ttf'));
    assert.match(readFileSync('public/fonts/OFL.txt', 'utf8'), /SIL OPEN FONT LICENSE/i);
    assert.match(styleSource, /@font-face/);
    assert.match(styleSource, /\/fonts\/Caveat-VariableFont_wght\.ttf/);
    assert.match(styleSource, /\.font-caveat/);
    assert.match(styleSource, /\.dropdown-menu\s*\{[^}]*padding:\s*12px/s);
    assert.match(indexSource, /id="topbar-groups"/);
    assert.match(indexSource, /id="create-menu"/);
    assert.match(indexSource, /id="topbar-more-toggle"/);
    assert.match(indexSource, /id="note-create"/);
    assert.match(indexSource, /id="sticker-create"/);
    assert.match(indexSource, /id="note-font-family"/);
    assert.match(indexSource, /id="sticker-new-font"/);
    assert.match(indexSource, /id="sticker-font-family"/);
    assert.match(clientSource, /setupMenus\(\)/);
    assert.match(clientSource, /scheduleTopbarLayout\(\)/);
    assert.match(clientSource, /placePopover\(/);
    assert.match(clientSource, /sheet:ability:apply/);
    assert.match(clientSource, /document\.fonts\.load\('16px Caveat'\)/);
  });

  await t.test('29. Вложенное меню не закрывает своего предка', () => {
    // Minimal stand-in for Element.contains with an explicit parent/child tree.
    function fakeMenu(children: unknown[] = []): { contains(node: unknown): boolean } {
      const node = { contains: (target: unknown) => target === node || children.includes(target) };
      return node;
    }
    const child = fakeMenu();
    const parent = fakeMenu([child]);
    const sibling = fakeMenu();
    assert.equal(menuIsWithin(parent, child), true, 'родительское меню должно остаться открытым');
    assert.equal(menuIsWithin(child, child), true, 'открываемое меню не должно закрываться');
    assert.equal(menuIsWithin(sibling, child), false, 'соседнее меню должно закрыться');
    assert.equal(menuIsWithin(undefined, child), false);
    // The DOM helper must be wired into the menu controller, not just exported.
    assert.match(clientSource, /function closeMenus\(keep\?: HTMLElement\)/);
    assert.match(clientSource, /menuIsWithin\(menu, keep\)/);
    assert.match(clientSource, /closeMenus\(menu\);/);
  });
});
