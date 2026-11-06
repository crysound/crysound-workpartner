#!/usr/bin/env python3
"""从固定的官方仓库提交生成技能归档，不打包应用配置、凭据或二进制。"""
import gzip
import io
from pathlib import Path
import subprocess
import sys
import tarfile

root = Path(__file__).resolve().parent
sources = [(Path(sys.argv[1]), '8d8357d39dd15ac5e9aa815d4ab2639d56bd3239', 'lark'),
           (Path(sys.argv[2]), '51b6c92fe7bab9f830db9f4bbf2739927c434815', 'meegle')]
items = []
for repo, commit, name in sources:
    actual = subprocess.check_output(['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip()
    if actual != commit:
        sys.exit('官方来源提交不匹配')
    directory = repo / 'skills' if name == 'lark' else repo / 'skills/meegle'
    for file in sorted(directory.rglob('*')):
        if file.is_file() and not file.is_symlink():
            archive_name = str(file.relative_to(directory)) if name == 'lark' else 'meegle/' + str(file.relative_to(directory))
            items.append((archive_name, file.read_bytes()))
    items.append(('LICENSE-' + name, (repo / 'LICENSE').read_bytes()))
for file in sorted((root.parent / 'config/skills/company-feishu').rglob('*')):
    if file.is_file() and not file.is_symlink():
        items.append(('company-feishu/' + str(file.relative_to(root.parent / 'config/skills/company-feishu')), file.read_bytes()))
with gzip.GzipFile(filename='', mode='wb', fileobj=(root / 'official-skills.tar.gz').open('wb'), mtime=0) as gz:
    with tarfile.open(mode='w', fileobj=gz) as archive:
        for name, data in sorted(items):
            item = tarfile.TarInfo(name)
            item.size = len(data)
            item.mode = 0o644
            archive.addfile(item, io.BytesIO(data))
