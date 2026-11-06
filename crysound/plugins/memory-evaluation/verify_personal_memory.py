#!/usr/bin/env python3
"""Verify committed synthetic observations and recorded model actions, without model access."""
import json
from pathlib import Path


def verify():
    evidence = json.loads(Path(__file__).with_name('personal-memory-evidence.json').read_text())
    sessions = {s['session']: s for s in evidence['sessions']}
    scenario = lambda name: sessions[evidence['scenarios'][name]]
    observed = evidence['observations']
    auto = scenario('autoUpdate')
    saves = [t for t in auto['memoryTools'] if t['name'] == 'crysound_memory_save']
    assert len(saves) == 3
    results = {r['callId']: json.loads(r['text']) for r in auto['memoryResults']}
    second = results[saves[1]['callId']]
    updated = results[saves[2]['callId']]
    assert len(second['facts']) == len(updated['facts']) == 2
    assert saves[2]['arguments']['id'] in {f['id'] for f in second['facts']}
    assert {f['id'] for f in second['facts']} == {f['id'] for f in updated['facts']}
    assert any('要点列表' in f['content'] for f in updated['facts'])
    for call in saves:
        result = next(r for r in auto['memoryResults'] if r['callId'] == call['callId'])
        assert result['meta']['memory']['ok']
        assert result['meta']['memory']['message'].startswith('已记住：')
        assert '设置 › 个人记忆' in result['meta']['memory']['message']
    no_save = scenario('noSave')
    assert len(no_save['userTurns']) == 2 and not no_save['memoryTools']
    assert not scenario('sensitive')['memoryTools']
    assert '敏感个人信息' in ''.join(t['text'] for t in scenario('sensitive')['assistantText'])
    edited = scenario('editedRecall')
    assert '编号清单' in ''.join(t['text'] for t in edited['assistantText'])
    assert any('编号清单' in f['content'] for r in edited['recall'] for f in r['snapshot']['facts'])
    disabled = scenario('disabledRecall')
    assert disabled['recall'] and all(r['snapshot'] == {'enabled': False, 'facts': []} for r in disabled['recall'])
    assert '不记得' in ''.join(t['text'] for t in disabled['assistantText'])
    assert len(observed['disabled']['data']['facts']) == 3
    assert observed['before-clear']['data']['facts'] == observed['clear-confirmation']['data']['facts']
    assert not observed['after-clear']['data']['facts']
    assert observed['secureClear'] == {'checkedValues': 6, 'allAbsent': True, 'files': ['memory.sqlite']}
    before = observed['full-seeded']['data']
    proposed = observed['full-proposed']['data']
    after = observed['full-merged']['data']
    assert before == proposed  # No write before consent.
    assert len(before['facts']) == len(after['facts']) == 50
    assert after['revision'] == before['revision'] + 1
    full = scenario('fullMerge')
    saves = [t for t in full['memoryTools'] if t['name'] == 'crysound_memory_save']
    assert len(saves) == 1 and saves[0]['turn'] == 2
    plan = saves[0]['arguments']
    assert plan['confirmed'] is True and len(plan['removeIds']) == len(plan['updates']) == 1
    a = {f['id']: f for f in before['facts']}
    b = {f['id']: f for f in after['facts']}
    assert a.keys() - b.keys() == set(plan['removeIds'])
    changed = {i for i in a.keys() & b.keys() if a[i] != b[i]}
    assert changed == {f['id'] for f in plan['updates']}
    assert any('ZX-7' in f['content'] for f in b.values())
    assert len(a.keys() & b.keys() - changed) == 48
    for session in sessions.values():
        assert all(call['model'] == 'codex/gpt-6.1-sol' for call in session['modelCalls'])
    print('Verified 6 real-model scenarios: stable-id update, two-turn opt-out, edited recall, disabled recall, sensitive refusal, confirmed 50/50 merge; page clear and 48 untouched facts.')


if __name__ == '__main__':
    verify()
