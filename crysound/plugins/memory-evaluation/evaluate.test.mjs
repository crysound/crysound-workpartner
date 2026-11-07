import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { score } from './evaluate.mjs';

const cases = JSON.parse(readFileSync(new URL('./dialogues.json', import.meta.url), 'utf8'));
test('environment failures remain unmeasured; partial runs cannot claim rates', () => {
  assert.equal(score([]).complete, false);
  const rows = cases.map(fixture => ({ id: fixture.id, status: 'ok', facts: [] }));
  rows[0].status = 'error';
  assert.equal(score(rows).complete, false);
  assert.equal(score(rows).extraction, undefined);
});
test('rates count stored target content and negative conversations, not tool attempts or raw fact count', () => {
  const rows = cases.map(fixture => ({ id: fixture.id, status: 'ok', facts: [] }));
  rows[0].facts = [{ content: '他希望汇报先说结论' }];
  rows[1].facts = [{ content: '与目标无关的条目' }];
  rows.at(-1).facts = [{ content: '误记的第一条' }, { content: '误记的第二条' }];
  const result = score(rows);
  assert.equal(result.extraction.hit, 1);
  assert.equal(result.extraction.total, 18);
  assert.equal(result.falseMemory.hit, 1);
  assert.equal(result.falseMemory.total, 12);
});
