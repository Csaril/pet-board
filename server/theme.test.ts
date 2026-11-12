import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const indexSource = readFileSync('src/pages/index.astro', 'utf8');
const clientSource = readFileSync('src/client/app.ts', 'utf8');
const styleSource = readFileSync('src/styles/global.css', 'utf8');

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Не найден фрагмент ${start}`);
  return source.slice(from, to);
}

test('theme: local light/dark interface theme', async (t) => {
  await t.test('1. Dark theme defines the shared semantic palette', () => {
    const dark = sliceBetween(styleSource, ':root[data-theme="dark"] {', '}');
    for (const variable of [
      '--background', '--surface', '--surface-secondary', '--border',
      '--text-primary', '--text-secondary', '--accent', '--input-background',
    ]) {
      assert.match(dark, new RegExp(`${variable}:\\s*#[0-9a-f]{6}`, 'i'), `В тёмной теме нет ${variable}`);
    }
    assert.match(dark, /--background:\s*#252c29/i);
    assert.match(dark, /--surface:\s*#303a34/i);
    assert.match(dark, /--accent:\s*#596c5d/i);
    assert.match(dark, /color-scheme:\s*dark/);
  });

  await t.test('2. Theme toggle lives in the More menu with both choices', () => {
    const moreMenu = sliceBetween(indexSource, '<div id="topbar-more-menu"', '<button id="leave"');
    assert.match(moreMenu, /id="theme-light"[^>]*aria-pressed="true"/);
    assert.match(moreMenu, /id="theme-dark"[^>]*aria-pressed="false"/);
    assert.match(indexSource, /id="topbar-theme-control"/);
    const head = sliceBetween(indexSource, '<head>', '</head>');
    assert.doesNotMatch(head, /id="theme-(light|dark)"/, 'Переключатель темы не должен находиться вне интерфейса участника');
  });

  await t.test('3. Theme is stored per participant and applied before the workspace is shown', () => {
    const loginBody = sliceBetween(clientSource, 'function login(', 'function connect()');
    assert.ok(loginBody.indexOf('setupTheme(nextIdentity.participantId)') >= 0);
    assert.ok(loginBody.indexOf('setupTheme(nextIdentity.participantId)') < loginBody.indexOf('workspace.hidden = false'));
    assert.match(clientSource, /function uiStorageKey\(participantId: string, panel: 'dice-tools' \| 'dice-history' \| 'layers' \| 'theme'\)/);
    assert.match(clientSource, /`tabletop:ui:v1:\$\{participantId\}:\$\{panel\}`/);
    assert.match(clientSource, /localStorage\.getItem\(uiStorageKey\(participantId, 'theme'\)\) === 'dark'/);
    assert.match(clientSource, /function setThemePreference\(theme: ThemePreference\)/);
    assert.match(clientSource, /setupParticipantUi[\s\S]*?setupTheme\(participantId\)/);
    assert.doesNotMatch(clientSource, /socket[^\n]*theme|theme[^\n]*socket/i, 'Тема не должна синхронизироваться через WebSocket');
  });

  await t.test('4. Ability apply button is constrained by its flex card', () => {
    const rule = /\.sheet-ability-header \.sheet-ability-apply\s*\{([^}]*)\}/.exec(styleSource)?.[1] ?? '';
    assert.match(rule, /width:\s*fit-content/);
    assert.match(rule, /max-width:\s*100%/);
    assert.match(rule, /min-width:\s*0/);
    assert.match(styleSource, /\.sheet-ability \.sheet-ability-apply\s*\{[^}]*max-width:\s*100%/s);
  });

  await t.test('5. Board background stays independent from the interface theme', () => {
    assert.match(styleSource, /\.canvas-wrap\[data-board-background="black"\]\s*\{\s*background:\s*#171a19/);
    assert.match(styleSource, /\.canvas-wrap\[data-board-background="gray"\]\s*\{\s*background:\s*#e9ece8/);
    assert.match(clientSource, /canvasWrap\.dataset\.boardBackground = selected/);
    assert.doesNotMatch(clientSource, /setThemePreference[\s\S]{0,200}applyBoardBackground/);
  });
});
