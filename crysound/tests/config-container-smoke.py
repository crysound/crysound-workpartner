#!/usr/bin/env python3
"""Exercise mounted config with a real dsh in an existing image; never build or touch a live user container."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import uuid

REPO = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get('PARTNER_TEST_IMAGE', 'zhaohua-partner:0.2.2-rc.1')


def run(*args, check=True):
    result = subprocess.run(args, text=True, capture_output=True)
    if check and result.returncode:
        raise RuntimeError(result.stderr or result.stdout)
    return result


(REPO / '.artifacts').mkdir(exist_ok=True)
with tempfile.TemporaryDirectory(prefix='partner-config-smoke-', dir=REPO / '.artifacts') as temporary:
    root = Path(temporary)
    config = root / 'config'
    shutil.copytree(REPO / 'crysound/config', config)
    config.chmod(0o755)
    for file in config.iterdir():
        file.chmod(0o644)
    # No plugin downloads in this local smoke; full plugin integration belongs to delivery verification.
    (config / 'plugins.json').write_text(json.dumps({'plugins': [], 'defaultBundles': []}))
    data = root / 'data'
    data.mkdir(mode=0o777)
    data.chmod(0o777)
    key = root / 'fake.key'
    key.write_text('fake-key-for-local-smoke')
    key.chmod(0o444)
    name = 'partner-config-smoke-' + uuid.uuid4().hex[:12]
    mounts = ['--mount', f'type=bind,src={data},dst=/data',
              '--mount', f'type=bind,src={config},dst=/opt/partner-config,readonly',
              '--mount', f'type=bind,src={key},dst=/etc/partner/magpie.key,readonly',
              '--mount', f'type=bind,src={REPO / "crysound/web/entrypoint.sh"},dst=/test-entrypoint.sh,readonly']
    try:
        run('docker', 'run', '-d', '--name', name, '--network', 'none', '--user', '1001:1001',
            '--cpus', '1', '--memory', '768m', '--hostname', 'config-smoke',
            '--add-host', 'config-smoke:127.0.0.1', *mounts,
            '-e', 'PUBLIC_HOST=partner.example.invalid', '-e', 'MAGPIE_BASE_URL=http://127.0.0.1:9/v1',
            '--entrypoint', 'sh', IMAGE, '-c',
            'dsh --profile web --dump-config >/dev/null && exec sh /test-entrypoint.sh')

        def ready():
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                logs = run('docker', 'logs', name).stdout
                if 'dsh web:' in logs:
                    return
                if run('docker', 'inspect', '-f', '{{.State.Running}}', name).stdout.strip() != 'true':
                    raise AssertionError(run('docker', 'logs', name).stderr + logs)
                time.sleep(1)
            raise AssertionError('dsh readiness timed out: ' + run('docker', 'logs', name).stdout[-4000:])

        ready()
        run('docker', 'exec', name, 'node', '-e', "fetch('http://127.0.0.1:3080/', {headers:{host:'partner.example.invalid'}}).then(r=>{if(r.status>=500)process.exit(1)})")
        inspect = json.loads(run('docker', 'inspect', name).stdout)[0]
        assert any(m['Destination'] == '/opt/partner-config' and not m['RW'] for m in inspect['Mounts'])
        patch = data / '.dsh/profiles/web/cordis.patch.yml'
        assert 'codex/gpt-6.1-sol' in patch.read_text()
        # Edit the test user configuration while retaining the real startup path.
        logs_before = len(run('docker', 'logs', name).stdout)
        change = '''const fs=require('fs'),p='/data/.dsh/profiles/web/cordis.patch.yml';
let text=fs.readFileSync(p,'utf8');text=text.replace('    providers:', "    providers:\\n      mine: {api: openai-completions, baseURL: 'http://127.0.0.1:9/v1', apiKeyEnv: PERSONAL_FAKE_KEY, models: [{id: personal-model, name: Personal, contextWindow: 1000}]}");fs.writeFileSync(p,text);'''
        run('docker', 'exec', name, 'node', '-e', change)
        seed = config / 'partner.patch.yml'
        seed.write_text(seed.read_text().replace('codex/gpt-6.1-terra', 'codex/company-model-next'))
        run('docker', 'restart', name)
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            logs = run('docker', 'logs', name).stdout[logs_before:]
            if 'dsh web:' in logs:
                break
            if run('docker', 'inspect', '-f', '{{.State.Running}}', name).stdout.strip() != 'true':
                raise AssertionError(run('docker', 'logs', name).stderr + logs)
            time.sleep(1)
        else:
            raise AssertionError('restart readiness timed out: ' + logs[-4000:])
        text = patch.read_text()
        assert 'codex/company-model-next' in text and 'codex/gpt-6.1-terra' not in text
        assert 'personal-model' in text
        print('PASS: real dsh starts with mounted config, restart refreshes company models and retains a personal provider')
    finally:
        run('docker', 'rm', '-f', name, check=False)

    missing = run('docker', 'run', '--rm', '--network', 'none', '--cpus', '1', '--memory', '128m',
                  '--mount', f'type=bind,src={REPO / "crysound/web/entrypoint.sh"},dst=/test-entrypoint.sh,readonly',
                  '--entrypoint', 'sh', IMAGE, '/test-entrypoint.sh', check=False)
    assert missing.returncode != 0 and '公司配置缺失或不可读' in missing.stderr
    print('PASS: missing configuration exits with an actionable error')
