import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { shouldHideGmOnlyElement } from '../src/shared/role-ui.js';

const indexSource = readFileSync('src/pages/index.astro', 'utf8');
const clientSource = readFileSync('src/client/app.ts', 'utf8');
const styleSource = readFileSync('src/styles/global.css', 'utf8');

function sliceBetween(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Не найден фрагмент ${start}`);
  return source.slice(from, to);
}

test('topbar: three zones and a shared create menu for GM and players', async (t) => {
  await t.test('1. GM sees both creation actions, player only sticker creation', () => {
    assert.equal(shouldHideGmOnlyElement('gm', { manual: false, hidden: true }), false);
    assert.equal(shouldHideGmOnlyElement('player', { manual: false, hidden: false }), true);
    assert.match(indexSource, /id="note-create" class="menu-item gm-only"/);
    const sticker = /<button id="sticker-create"[^>]*>/.exec(indexSource)?.[0] ?? '';
    assert.ok(sticker, 'Кнопка создания стикера отсутствует.');
    assert.doesNotMatch(sticker, /gm-only/);
  });

  await t.test('2. Create toggle lives in the centre nav and not in the More menu', () => {
    const centre = sliceBetween(indexSource, '<nav id="topbar-groups"', '</nav>');
    const moreMenu = sliceBetween(indexSource, '<div id="topbar-more-menu"', '<button id="leave"');
    assert.match(centre, /id="create-toggle"/);
    assert.match(centre, /id="create-menu"/);
    assert.doesNotMatch(moreMenu, /id="create-toggle"/);
    assert.doesNotMatch(moreMenu, /id="create-menu"/);
    assert.equal(indexSource.match(/id="create-toggle"/g)?.length, 1);
  });

  await t.test('3. More menu keeps the remaining GM actions', () => {
    const moreMenu = sliceBetween(indexSource, '<div id="topbar-more-menu"', '<button id="leave"');
    assert.match(moreMenu, /id="notes-toggle"/);
    assert.match(moreMenu, /id="library-toggle"/);
    assert.match(moreMenu, /id="topbar-more-static"/);
  });

  await t.test('4. Topbar uses three grid columns and keeps create out of overflow', () => {
    assert.match(styleSource, /\.topbar\s*\{[^}]*display:\s*grid/s);
    assert.match(styleSource, /grid-template-columns:\s*minmax\(0,\s*1fr\)\s+auto\s+minmax\(0,\s*1fr\)/);
    assert.match(clientSource, /topbarGroups\.insertBefore\(group, topbarCreate\)/);
    assert.match(clientSource, /topbarMoreStaticItems\.some/);
  });
});
