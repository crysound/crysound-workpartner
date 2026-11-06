import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { configureSignedApp, prepareRelease, releaseVersion, updateDirectory, verifyUpdateMetadata, writeUpdateMetadata } from './mac-update-release.mjs'

test('release inputs reject versions the updater cannot order and unsafe feed URLs', () => {
  assert.equal(releaseVersion('0.2.3'), '0.2.3')
  for (const value of ['v0.2.3', '0.2.3-rc.1', '0.2.3+1', '01.2.3', '', '1.2', '1.2.9007199254740992']) {
    assert.throws(() => releaseVersion(value))
  }
  assert.equal(updateDirectory('https://downloads.example.test/mac-arm64'), 'https://downloads.example.test/mac-arm64/')
  for (const value of ['http://downloads.example.test/', 'https://user:password@example.test/', 'https://example.test/?key=x', 'https://example.test/#x', '']) {
    assert.throws(() => updateDirectory(value))
  }
})

test('ephemeral version preparation is repeatable and leaves runtime and dependency versions intact', async t => {
  const root = await mkdtemp(join(tmpdir(), 'company-release-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'apps/desktop'), { recursive: true })
  const path = join(root, 'apps/desktop/package.json')
  await writeFile(path, JSON.stringify({ name: 'desktop', version: '0.2.2-rc.1', dependencies: { runtime: 'workspace:*' } }))
  const runtime = '{"version":"0.2.2-rc.1"}\n'
  await writeFile(join(root, 'package.json'), runtime)
  await prepareRelease(root, '0.2.3', 'https://downloads.example.test/mac-arm64/')
  const first = await readFile(path, 'utf8')
  await prepareRelease(root, '0.2.3', 'https://downloads.example.test/mac-arm64/')
  assert.equal(await readFile(path, 'utf8'), first)
  assert.deepEqual(JSON.parse(first), { name: 'desktop', version: '0.2.3', dependencies: { runtime: 'workspace:*' } })
  assert.equal(await readFile(join(root, 'package.json'), 'utf8'), runtime)
  await assert.rejects(prepareRelease(root, '0.2.4', 'http://invalid.example.test/'))
  assert.equal(await readFile(path, 'utf8'), first)
})

test('signed-app configuration and feed describe the exact final ZIP bytes', async t => {
  const root = await mkdtemp(join(tmpdir(), 'company-update-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const app = join(root, 'CRYSOUND WorkPartner.app')
  await mkdir(join(app, 'Contents/Resources'), { recursive: true })
  await configureSignedApp(app, 'https://downloads.example.test/desktop/mac-arm64')
  assert.deepEqual(JSON.parse(await readFile(join(app, 'Contents/Resources/app-update.yml'), 'utf8')), {
    provider: 'generic', url: 'https://downloads.example.test/desktop/mac-arm64/', channel: 'latest',
    updaterCacheDirName: 'crysound-workpartner-updater',
  })
  const zip = join(root, 'crysound-workpartner-0.2.3-mac-arm64.zip')
  const bytes = Buffer.from('fixture representing the final ZIP bytes')
  await writeFile(zip, bytes)
  const metadata = await writeUpdateMetadata(zip, '0.2.3')
  const first = await readFile(metadata, 'utf8')
  const feed = JSON.parse(first)
  const downloaded = await readFile(join(root, feed.files[0].url))
  assert.equal(feed.version, '0.2.3')
  assert.equal(feed.path, 'crysound-workpartner-0.2.3-mac-arm64.zip')
  assert.equal(feed.files[0].size, downloaded.length)
  assert.equal(feed.files[0].sha512, createHash('sha512').update(downloaded).digest('base64'))
  assert.equal(feed.sha512, feed.files[0].sha512)
  await writeUpdateMetadata(zip, '0.2.3')
  assert.equal(await readFile(metadata, 'utf8'), first)
  await verifyUpdateMetadata(zip, '0.2.3')
  await writeFile(zip, 'changed after hashing')
  await assert.rejects(verifyUpdateMetadata(zip, '0.2.3'))
  await writeFile(zip, bytes)
  await writeFile(metadata, JSON.stringify({ ...feed, version: '0.2.4' }))
  await assert.rejects(verifyUpdateMetadata(zip, '0.2.3'))
  await writeFile(metadata, JSON.stringify({ ...feed, files: [{ ...feed.files[0], size: 1 }] }))
  await assert.rejects(verifyUpdateMetadata(zip, '0.2.3'))
  await assert.rejects(writeUpdateMetadata(zip, '0.2.4'))
  await writeFile(zip, '')
  await assert.rejects(writeUpdateMetadata(zip, '0.2.3'))
})
