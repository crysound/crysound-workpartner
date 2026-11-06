// Small real-artifact smoke: no downloads, dependencies, service changes or long full-resolution renders.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.OM_CHROME) throw new Error('Set OM_CHROME to an existing renderer browser.');
const cli = fileURLToPath(new URL('../cli/om.mjs', import.meta.url));
const cwd = mkdtempSync(join(tmpdir(), 'motion-smoke-'));
const run = (...args) => {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', timeout: 45_000 });
  assert.equal(result.status, 0, `${args.join(' ')}\n${result.stderr}\n${result.stdout}`);
  process.stdout.write(result.stdout);
  return result;
};
run('new', 'company');
run('check', 'company', '--source');
run('still', 'company');
run('still', 'company', '--at', '0,4.5,13,23');
run('still', 'company', '--at', '4.5');
run('still', 'company', '--at', '0,23');
assert.equal(readFileSync(join(cwd, 'company/out/stills/index-4.50s.png')).subarray(1, 4).toString(), 'PNG');
const firstPixel = spawnSync('ffmpeg', ['-v', 'error', '-i', join(cwd, 'company/out/stills/index-0.00s.png'),
  '-vf', 'crop=1:1:0:0,format=rgb24', '-frames:v', '1', '-f', 'rawvideo', '-'], { encoding: 'buffer' });
assert.equal(firstPixel.status, 0);
assert.deepEqual([...firstPixel.stdout], [23, 0, 87], 'Opening frame must show only its deep-purple background, without overlaid later scenes');
// Use the actual bundled fonts, GSAP, runtime and music path at tiny resolution and duration.
let html = readFileSync(join(cwd, 'company/index.html'), 'utf8');
html = html.replace('data-width="1280" data-height="720"', 'data-width="320" data-height="180"')
  .replace("window.__timelines.film = tl;", "tl.clear(); tl.to('#open', { x: 20, duration: 2, ease: 'none' }, 0); window.__timelines.film = tl;")
  .replace("drop: 'product'", 'drop: 0.5').replace('end: 23.8', 'end: 1.9');
writeFileSync(join(cwd, 'company/index.html'), html);
run('render', 'company', '--workers', '2', '--format', 'mp4');
run('render', 'company', '--workers', '1', '--format', 'gif');
const mp4 = join(cwd, 'company/out/company-v1.mp4');
const gif = join(cwd, 'company/out/company-v1.gif');
const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', mp4], { encoding: 'utf8' });
assert.equal(probe.status, 0, probe.stderr);
const info = JSON.parse(probe.stdout);
assert.ok(info.streams.some((s) => s.codec_type === 'audio'), 'MP4 must contain music');
const levels = spawnSync('ffmpeg', ['-hide_banner', '-i', mp4, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
assert.equal(levels.status, 0, levels.stderr);
assert.match(levels.stderr, /mean_volume: -?\d+(?:\.\d+)? dB/, 'Music must be non-silent');
const video = info.streams.find((s) => s.codec_type === 'video');
assert.equal(video.width, 320);
assert.equal(video.height, 180);
assert.ok(Math.abs(Number(info.format.duration) - 2) < .2);
assert.match(readFileSync(gif).subarray(0, 6).toString(), /^GIF8[79]a$/);
const log = JSON.parse(readFileSync(join(cwd, 'company/.om/renders.jsonl'), 'utf8').trim().split('\n')[0]);
assert.equal(log.workers, 2, 'Exercise the two-browser render path');
// Read a live timeline with an excessive duration: it must fail before synthesizing music or encoding.
writeFileSync(join(cwd, 'company/index.html'), html.replace('duration: 2,', 'duration: 31,'));
const excessive = spawnSync(process.execPath, [cli, 'still', 'company'], { cwd, encoding: 'utf8', timeout: 15_000 });
assert.equal(excessive.status, 1);
assert.match(excessive.stderr, /duration must be at most 30/);
console.log(JSON.stringify({ result: 'passed', artifacts: cwd, video: { width: 320, height: 180, duration: info.format.duration }, audio: true, gif: true }));
