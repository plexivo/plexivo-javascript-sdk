import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkSyntax } from '../scripts/check-syntax.mjs';

test('syntax check includes nested files and rejects invalid input', t => {
  const dir = mkdtempSync(join(tmpdir(), 'plexivo-syntax-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'nested'));
  writeFileSync(join(dir, 'valid.js'), 'const value = 1;');
  writeFileSync(join(dir, 'nested', 'valid.mjs'), 'export const value = 1;');
  assert.equal(checkSyntax([dir]), 2);
  writeFileSync(join(dir, 'nested', 'invalid.mjs'), 'export const = ;');
  assert.throws(() => checkSyntax([dir]));
});

test('syntax check does not pass when no files were checked', t => {
  const dir = mkdtempSync(join(tmpdir(), 'plexivo-syntax-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.throws(() => checkSyntax([dir]), /No JavaScript/);
});
