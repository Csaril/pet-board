import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config.js';

const env = (roomCode: string, gmPassword: string) => ({ ROOM_CODE: roomCode, GM_PASSWORD: gmPassword });

test('configuration accepts compact room codes and simple 10-character GM passphrases', () => {
  const config = loadConfig(env('k7m2r9tx', 'quiet-forest'));
  assert.equal(config.roomCode, 'K7M2R9TX');
  assert.equal(config.gmPassword, 'quiet-forest');
  assert.equal(config.maxUploadBytes, 25 * 1024 * 1024);
});

test('configuration rejects ambiguous compact room codes and short GM passwords', () => {
  assert.throws(() => loadConfig(env('K0M2R9TX', 'quiet-forest')), /ROOM_CODE/);
  assert.throws(() => loadConfig(env('K7M2R9TX', 'too-short')), /GM_PASSWORD/);
});

test('legacy room codes remain usable without rewriting the existing .env', () => {
  const config = loadConfig(env('legacy-room1', 'quiet-forest'));
  assert.equal(config.roomCode, 'legacy-room1');
});
