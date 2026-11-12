import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { shouldHideGmOnlyElement } from '../src/shared/role-ui.js';

const clientSource = readFileSync('src/client/app.ts', 'utf8');
const indexSource = readFileSync('src/pages/index.astro', 'utf8');

test('GM controls follow the role, while manually toggled panels keep local visibility', () => {
  // Regular GM controls: visible for the GM, hidden for players.
  assert.equal(shouldHideGmOnlyElement('gm', { manual: false, hidden: false }), false);
  assert.equal(shouldHideGmOnlyElement('gm', { manual: false, hidden: true }), false);
  assert.equal(shouldHideGmOnlyElement('player', { manual: false, hidden: false }), true);
  assert.equal(shouldHideGmOnlyElement('player', { manual: false, hidden: true }), true);

  // Manual panels are fully controlled by the GM's local actions.
  assert.equal(shouldHideGmOnlyElement('gm', { manual: true, hidden: true }), true);
  assert.equal(shouldHideGmOnlyElement('gm', { manual: true, hidden: false }), false);
  // Players never see GM-only panels, even when the panel was open for the GM.
  assert.equal(shouldHideGmOnlyElement('player', { manual: true, hidden: false }), true);
});

test('notes panel is declared as a manually controlled GM panel', () => {
  assert.match(indexSource, /id="notes-panel"[^>]*data-manual-visibility="true"/);
});

test('role visibility is applied through the shared helper in login and room state handling', () => {
  assert.match(clientSource, /function applyGmOnlyVisibility\(role: AppIdentity\['role'\]\): void \{/);
  assert.match(clientSource, /manual: element\.dataset\.manualVisibility === 'true'/);
  assert.equal((clientSource.match(/document\.querySelectorAll<HTMLElement>\('\.gm-only'\)/g) || []).length, 1);
  assert.match(clientSource, /loginShell\.hidden = true;\s+workspace\.hidden = false;\s+applyGmOnlyVisibility\(nextIdentity\.role\);/);
  assert.match(clientSource, /identityLabel\.textContent = [^\n]+\n\s+applyGmOnlyVisibility\(identity\.role\);/);
});

test('room state updates do not open notes, reset the open note, or refresh the notes list', () => {
  const start = clientSource.indexOf('function updateBoard(');
  assert.ok(start >= 0, 'updateBoard must exist');
  const end = clientSource.indexOf('\nfunction updateDiceBadge(', start);
  assert.ok(end > start, 'updateBoard must be followed by updateDiceBadge');
  const updateBoardBody = clientSource.slice(start, end);
  assert.doesNotMatch(updateBoardBody, /refreshNotesList/);
  assert.doesNotMatch(updateBoardBody, /openNote\(/);
});

test('notes list is refreshed only after local note and marker actions', () => {
  const refreshCalls = clientSource.match(/void refreshNotesList\(\)/g) || [];
  // Toggle, delete, and the guarded helper are the only refresh sources.
  assert.equal(refreshCalls.length, 3);
  assert.match(clientSource, /function refreshNotesListIfVisible\(\): void \{\s+if \(identity\?\.role === 'gm' && !notesPanel\.hidden\) void refreshNotesList\(\);/);
});
