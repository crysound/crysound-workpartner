import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildStatusCard } from '../lib/card.js'
import { foldBoundEvent, initialRunState } from '../lib/run-state.js'
import { resolveConfig } from '../lib/config.js'

function event(type, data, time, seq) {
  return { type, data, time, seq }
}

function md(card) {
  return card.body.elements[0].content
}

/** Drive one settled bash call through the run state. */
function settleTool(state, args = '{"command":"npm test"}') {
  foldBoundEvent(state, event('turn/start', { turn: 1 }, 1000, 1))
  foldBoundEvent(state, event('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: args }, 1100, 2))
  foldBoundEvent(state, event('tool/result', { turn: 1, step: 1, callId: 'c1', isError: false }, 1500, 3))
}

test('config: toolDetail defaults to off; env and config values resolve; junk throws', () => {
  assert.equal(resolveConfig({}).toolDetail, 'off')
  assert.equal(resolveConfig({ toolDetail: 'brief' }).toolDetail, 'brief')
  assert.equal(resolveConfig({}, { DSH_FEISHU_TOOL_DETAIL: 'full' }).toolDetail, 'full')
  assert.equal(resolveConfig({ toolDetail: 'brief' }, { DSH_FEISHU_TOOL_DETAIL: 'full' }).toolDetail, 'brief', 'config wins over env (first-wins like the other keys)')
  assert.throws(() => resolveConfig({ toolDetail: 'verbose' }), /toolDetail must be one of/)
  assert.equal(resolveConfig({}, { DSH_FEISHU_TOOL_DETAIL: 'verbose' }).toolDetail, 'off', 'junk env falls back to the default')
})

test('run-state: off keeps the rows byte-for-byte (no detail anywhere)', () => {
  const state = initialRunState('off')
  settleTool(state)
  assert.equal(state.toolHistory[0].detail, undefined)
  assert.equal(state.currentTool, undefined)
})

test('run-state: brief folds the arguments JSON to one clipped line', () => {
  const state = initialRunState('brief')
  const multiline = '{\n  "command": "npm run build && npm test",\n  "timeout": 120000\n}'
  settleTool(state, multiline)
  const row = state.toolHistory[0]
  assert.equal(row.detail, '{ "command": "npm run build && npm test", "timeout": 120000 }', 'whitespace-folded, unclipped under 80 chars')
})

test('run-state: full keeps the multi-line shape, clipped at the budget', () => {
  const state = initialRunState('full')
  const args = JSON.stringify({ command: 'x'.repeat(900) })
  settleTool(state, args)
  const row = state.toolHistory[0]
  assert.ok(row.detail.length <= 600 + 20, 'clipped near the full budget (marker included)')
  assert.ok(row.detail.startsWith('{"command":"xxx'), 'raw shape preserved from the head')
})

test('run-state: an empty arguments string yields no digest, not an empty line', () => {
  const state = initialRunState('brief')
  settleTool(state, '')
  assert.equal(state.toolHistory[0].detail, undefined)
})

test('card: brief detail renders as an indented ⮡ line under the tool bullet; off renders none', () => {
  const off = initialRunState('off')
  settleTool(off)
  const offCard = buildStatusCard(off, { sessionLabel: 'repo · ab12cd34', displayThink: false, now: 1600 })
  assert.doesNotMatch(md(offCard.card), /⮡/)

  const brief = initialRunState('brief')
  settleTool(brief)
  const briefCard = buildStatusCard(brief, { sessionLabel: 'repo · ab12cd34', displayThink: false, now: 1600 })
  assert.match(md(briefCard.card), /- 🔧 bash · ✔ /)
  assert.match(md(briefCard.card), /  ⮡ \{"command":"npm test"\}/)
})
