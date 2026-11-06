#!/usr/bin/env python3
"""Inspect pinned npm archives as data, without installing or executing plugins."""

import argparse
import base64
import datetime as dt
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import re
import tarfile
import urllib.parse
import urllib.request


MAX_DOWNLOAD_BYTES = 10 * 1024 * 1024
MAX_UNPACKED_BYTES = 20 * 1024 * 1024
EXTERNAL_IMPORT = re.compile(
    r'''(?:from\s*|import\s*\(|require\s*\()\s*['"]([^'"]+)['"]'''
)
SOURCE_SUFFIXES = {".js", ".mjs", ".cjs"}


def fetch(url):
    """Read bounded public npm data; reject redirects outside the registry."""
    def allowed(value):
        parsed = urllib.parse.urlsplit(value)
        return parsed.scheme == "https" and parsed.netloc == "registry.npmjs.org"

    class RegistryRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, request, file, code, message, headers, new_url):
            if not allowed(new_url):
                raise ValueError("npm redirect left registry.npmjs.org")
            return super().redirect_request(request, file, code, message, headers, new_url)

    if not allowed(url):
        raise ValueError("Only public registry.npmjs.org URLs are supported")
    opener = urllib.request.build_opener(RegistryRedirect())
    with opener.open(url, timeout=30) as response:
        payload = response.read(MAX_DOWNLOAD_BYTES + 1)
    if len(payload) > MAX_DOWNLOAD_BYTES:
        raise ValueError("npm response exceeds the download limit")
    return payload


def archive_files(payload):
    """Read only regular package files in memory, with no filesystem extraction."""
    files = {}
    size = 0
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if member.isdir():
                continue
            if not member.isfile() or path.parts[0] != "package" or ".." in path.parts:
                raise ValueError(f"Unsupported archive member: {member.name}")
            size += member.size
            if size > MAX_UNPACKED_BYTES:
                raise ValueError("Archive exceeds the unpacked size limit")
            if member.name in files:
                raise ValueError(f"Duplicate archive member: {member.name}")
            with archive.extractfile(member) as stream:
                files[member.name] = stream.read()
    return files


def inspect(candidate, as_of, cache):
    """Verify an archive, measure shipped JavaScript and record public metadata."""
    encoded = urllib.parse.quote(candidate["name"], safe="@/")
    cache_key = hashlib.sha256(candidate["integrity"].encode()).hexdigest()
    tar_path = cache / f"{cache_key}.tgz"
    meta_path = cache / f"{cache_key}.registry.json"
    if not tar_path.exists():
        tar_path.write_bytes(fetch(candidate["tarball"]))
    payload = tar_path.read_bytes()
    algorithm, expected = candidate["integrity"].split("-", 1)
    if algorithm != "sha512":
        raise ValueError("The candidate lock must use sha512 integrity")
    actual = base64.b64encode(hashlib.sha512(payload).digest()).decode()
    if actual != expected:
        raise ValueError(f"Archive integrity mismatch: {candidate['name']}")
    if not meta_path.exists():
        meta_path.write_bytes(fetch(f"https://registry.npmjs.org/{encoded}"))
    registry = json.loads(meta_path.read_bytes())
    published = registry["time"][candidate["version"]]
    cutoff = dt.datetime.fromisoformat(as_of.replace("Z", "+00:00"))
    published_at = dt.datetime.fromisoformat(published.replace("Z", "+00:00"))
    if published_at > cutoff:
        raise ValueError("Candidate was not released at the assessment cutoff")
    releases = sorted([
        {"version": version, "at": when}
        for version, when in registry["time"].items()
        if version not in {"created", "modified"}
        and cutoff - dt.timedelta(days=30)
        <= dt.datetime.fromisoformat(when.replace("Z", "+00:00")) <= cutoff
    ], key=lambda release: (release["at"], release["version"]))
    files = archive_files(payload)
    package = json.loads(files["package/package.json"])
    if (package["name"], package["version"]) != (candidate["name"], candidate["version"]):
        raise ValueError("Archive identity differs from the candidate lock")
    scripts = {
        name.removeprefix("package/"): data
        for name, data in files.items() if PurePosixPath(name).suffix in SOURCE_SUFFIXES
    }
    imports = set()
    for data in scripts.values():
        imports.update(
            specifier for specifier in EXTERNAL_IMPORT.findall(data.decode("utf-8"))
            if not specifier.startswith((".", "node:"))
            and re.fullmatch(r"[@A-Za-z0-9_./-]+", specifier)
        )
    return {
        **candidate,
        "published": published,
        "license": package.get("license"),
        "archiveSha256": hashlib.sha256(payload).hexdigest(),
        "archiveFiles": len(files),
        "unpackedBytes": sum(len(data) for data in files.values()),
        "shippedJs": {
            "files": len(scripts),
            "bytes": sum(len(data) for data in scripts.values()),
            "nonemptyPhysicalLinesIncludingComments": sum(
                bool(line.strip()) for data in scripts.values() for line in data.splitlines()
            ),
        },
        "dependencies": package.get("dependencies", {}),
        "peerDependencies": package.get("peerDependencies", {}),
        "engines": package.get("engines", {}),
        "lifecycleScripts": package.get("scripts", {}),
        "externalImportSpecifiersHeuristic": sorted(imports),
        "releaseCountInPrevious30DaysIncludingPrereleases": len(releases),
        "lastFiveReleasesBeforeCutoff": releases[-5:],
        "sourceFiles": {
            name: {"sha256": hashlib.sha256(data).hexdigest(), "lines": len(data.splitlines())}
            for name, data in sorted(scripts.items())
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    lock = json.loads(Path(__file__).with_name("candidates.json").read_text())
    args.cache.mkdir(parents=True, exist_ok=True)
    candidates = [inspect(candidate, lock["asOf"], args.cache) for candidate in lock["candidates"]]
    report = {
        "schemaVersion": 1,
        "asOf": lock["asOf"],
        "method": "Verified published archives, read as data; no installation or plugin execution.",
        "runtimeTrials": "not performed",
        "candidates": candidates,
    }
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    for candidate in candidates:
        print(f"{candidate['name']}@{candidate['version']}: integrity verified; "
              f"{candidate['shippedJs']['bytes']} shipped JS bytes; "
              f"{candidate['releaseCountInPrevious30DaysIncludingPrereleases']} releases in 30 days")


if __name__ == "__main__":
    main()
