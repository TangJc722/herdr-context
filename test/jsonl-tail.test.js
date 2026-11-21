import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JsonlTail } from '../src/jsonl-tail.js';

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hc-tail-'));
  return path.join(dir, 'log.jsonl');
}

test('returns only new records, holds back an unfinished line', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{"a":1}\n{"a":2');
  const t = new JsonlTail(f);
  assert.deepEqual(t.readNew(), [{ a: 1 }]);
  assert.deepEqual(t.readNew(), []);
  fs.appendFileSync(f, '}\n{"a":3}\n');
  assert.deepEqual(t.readNew(), [{ a: 2 }, { a: 3 }]);
});

test('a multi-byte character split across reads survives', () => {
  const f = tmpFile();
  const line = Buffer.from('{"t":"上下文"}\n', 'utf8');
  fs.writeFileSync(f, line.subarray(0, 8)); // cuts inside "上"
  const t = new JsonlTail(f);
  assert.deepEqual(t.readNew(), []);
  fs.appendFileSync(f, line.subarray(8));
  assert.deepEqual(t.readNew(), [{ t: '上下文' }]);
  assert.equal(t.malformed, 0);
});

test('starts over when the file is truncated; missing file is empty', () => {
  const f = tmpFile();
  fs.writeFileSync(f, '{"a":1}\n{"a":2}\n');
  const t = new JsonlTail(f);
  t.readNew();
  fs.writeFileSync(f, '{"b":1}\n');
  assert.deepEqual(t.readNew(), [{ b: 1 }]);
  assert.deepEqual(new JsonlTail(f + '.missing').readNew(), []);
});

test('malformed lines are counted and skipped', () => {
  const f = tmpFile();
  fs.writeFileSync(f, 'not json\n\n{"ok":true}\n');
  const t = new JsonlTail(f);
  assert.deepEqual(t.readNew(), [{ ok: true }]);
  assert.equal(t.malformed, 1);
});
