import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepareMnemon } from './prepare.mjs'

test('unsupported targets fail before downloading', async t => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected download') })
  await assert.rejects(prepareMnemon('/unused', 'linux', 'ia32'), /Unsupported mnemon target/)
})

test('corrupted downloads preserve the previous prepared payload', async t => {
  const output = mkdtempSync(join(tmpdir(), 'mnemon-integrity-'))
  t.after(() => rmSync(output, { recursive: true, force: true }))
  const previous = join(output, 'previous-package')
  writeFileSync(previous, 'previous verified payload')
  t.mock.method(globalThis, 'fetch', async () => new Response('corrupted archive'))
  await assert.rejects(prepareMnemon(output, 'linux', 'x64'), /integrity mismatch/)
  assert.equal(readFileSync(previous, 'utf8'), 'previous verified payload')
})
