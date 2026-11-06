import test from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { browserValue } from './browser-values.mjs';

test('CDP string values round-trip script delimiters, quotes, backslashes and Unicode separators', () => {
  const input = '</script><script>globalThis.executed = true</script>"\'\\\n\r\u2028\u2029记忆';
  const literal = browserValue(input);
  assert.equal(/[<>\u2028\u2029]/u.test(literal), false);
  const scope = {};
  assert.equal(runInNewContext(`(${literal})`, scope), input);
  assert.equal(scope.executed, undefined);
});
