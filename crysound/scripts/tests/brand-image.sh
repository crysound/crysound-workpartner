#!/bin/sh
# Exercise only the Dockerfile's branding step in a disposable frontend; no image build.
set -eu
python3 - <<'PY'
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

# Run from the repository root.
root = Path.cwd()
with tempfile.TemporaryDirectory(prefix='brand-image-') as name:
    temp = Path(name)
    brand, frontend = temp / 'brand', temp / 'frontend'
    shutil.copytree(root / 'crysound/brand', brand)
    frontend.mkdir()
    (frontend / 'index.html').write_text('<html><head><title>DeepSeek Harness</title><link href="./favicon.svg"></head></html>')
    (frontend / 'manifest.webmanifest').write_text('{"name":"DeepSeek Harness","short_name":"DSH"}')
    docker = (root / 'crysound/web/Dockerfile').read_text()
    run = 'set -e; v=' + docker.split('RUN set -e; v=', 1)[1].split('\n# 公司配置', 1)[0]
    run = run.replace('\\\n', ' ').replace('/tmp/brand', str(brand))
    run = run.replace('$(npm root -g)/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist', str(frontend))
    subprocess.run(['sh', '-c', run], check=True)
    assert (frontend / 'pet.js').read_bytes() == (root / 'crysound/brand/pet.js').read_bytes()
    assert (frontend / 'pet.js').stat().st_mode & 0o777 == 0o644
    assert re.search(r'brand.js\?v=[0-9a-f]{8}', (frontend / 'index.html').read_text())
    assert (frontend / 'brand.css').read_text().count('zp-mark.svg?v=') == 1
    print('PASS Docker branding step: pet asset, permissions, cache version and fallback')
PY
