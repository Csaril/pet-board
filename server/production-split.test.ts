import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const distReady = existsSync('dist/_astro') && existsSync('dist-server/server');

test('production build splits client and server system code', { skip: distReady ? false : 'run npm run build first' }, () => {
  const jsFiles = readdirSync('dist/_astro').filter((file) => file.endsWith('.js'));
  assert.ok(jsFiles.length >= 3, `expected shell plus two system chunks, got ${jsFiles.join(', ')}`);
  const sources = new Map(jsFiles.map((file) => [file, readFileSync(join('dist/_astro', file), 'utf8')]));

  const pbtaChunk = [...sources].find(([, source]) => source.includes('Проверка PbtA'));
  const nechronicaChunk = [...sources].find(([, source]) => source.includes('Броски Nechronica'));
  assert.ok(pbtaChunk, 'the PbtA client implementation must live in its own chunk');
  assert.ok(nechronicaChunk, 'the Nechronica client implementation must live in its own chunk');
  assert.notEqual(pbtaChunk[0], nechronicaChunk[0], 'PbtA and Nechronica must not share a chunk');

  // The entry shell must not statically carry either system implementation.
  const entry = readFileSync('dist/index.html', 'utf8');
  const entryScripts = [...entry.matchAll(/src="([^"]+\.js)"/g)].map((match) => match[1]!);
  assert.ok(entryScripts.length > 0);
  for (const script of entryScripts) {
    const file = script.split('/').at(-1)!;
    const source = sources.get(file);
    if (!source) continue;
    assert.doesNotMatch(source, /Проверка PbtA/);
    assert.doesNotMatch(source, /Броски Nechronica/);
  }

  assert.ok(existsSync('dist-server/server/modules/pbta-2d6/server.js'));
  assert.ok(existsSync('dist-server/server/modules/nechronica/server.js'));
  assert.equal(existsSync('dist-server/src/modules/system/pbta-2d6/client.js'), false, 'server build must not emit client chunks');

  const registry = readFileSync('dist-server/server/system-registry.js', 'utf8');
  assert.match(registry, /import\(/);
  assert.match(registry, /pbta-2d6@1\.0\.0/);
  assert.match(registry, /nechronica@1\.0\.0/);

  const entryServer = readFileSync('dist-server/server/index.js', 'utf8');
  assert.doesNotMatch(entryServer, /calculatePbtARoll/);
  assert.doesNotMatch(entryServer, /Проверка PbtA/);
  const sheetsServer = readFileSync('dist-server/server/sheets.js', 'utf8');
  assert.doesNotMatch(sheetsServer, /calculatePbtARoll/);
});
