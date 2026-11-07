import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { matchesGlob } from 'node:path'
import { test } from 'node:test'
import { load } from 'js-yaml'

const workflows = await Promise.all(['mac', 'windows'].map(async platform => ({
  platform,
  workflow: load(await readFile(new URL(`../../.github/workflows/desktop-${platform}.yml`, import.meta.url), 'utf8')),
})))

// These conditions use only the GitHub expression subset shared with JavaScript.
function condition(expression, github, env = {}, needs = {}) {
  return Function('github', 'env', 'needs', 'always', `return (${expression.replace(/^\$\{\{|\}\}$/gu, '')})`)(github, env, needs, () => true)
}

function triggers(paths, file) {
  return paths.reduce((included, pattern) => matchesGlob(file, pattern.replace(/^!/u, '')) ? !pattern.startsWith('!') : included, false)
}

for (const { platform, workflow } of workflows) {
  test(`${platform}: main pushes build; desktop inputs match; document-only PRs do not`, () => {
    assert.deepEqual(workflow.on.push.branches, ['main'])
    assert.equal(workflow.on.workflow_dispatch.inputs.version.required, true)
    const paths = workflow.on.pull_request.paths
    for (const file of ['apps/desktop/src/main.ts', 'apps/desktop-host/src/index.ts', 'packages/client/gui/src/index.ts', 'crysound/brand/brand.js', 'scripts/build.ts', 'apps/cli/package.json', 'pnpm-lock.yaml', 'tsdown.config.ts', '.github/workflows/desktop-mac.yml', '.github/workflows/desktop-windows.yml']) {
      assert.equal(triggers(paths, file), true, file)
    }
    for (const file of ['CRYSOUND.md', 'docs/architecture.md', 'packages/core/README.md', 'apps/desktop/packaging/README.md', 'website/index.md']) {
      assert.equal(triggers(paths, file), false, file)
    }
    assert.equal(condition(workflow.concurrency['cancel-in-progress'], { event_name: 'push' }), true)
    assert.equal(condition(workflow.concurrency['cancel-in-progress'], { event_name: 'workflow_dispatch' }), false)
    assert.match(workflow.concurrency.group, /github.event_name/u)
    assert.match(workflow.concurrency.group, /github.ref/u)
  })

  test(`${platform}: only a failed main push can use the isolated issue-writing job`, async () => {
    assert.deepEqual(workflow.permissions, { contents: 'read' })
    const report = workflow.jobs['report-failure']
    assert.deepEqual(report.permissions, { issues: 'write' })
    for (const event of ['push', 'pull_request', 'workflow_dispatch']) {
      for (const ref of ['refs/heads/main', 'refs/heads/feature']) {
        for (const result of ['success', 'failure', 'cancelled']) {
          assert.equal(condition(report.if, { event_name: event, ref }, {}, { package: { result } }), event === 'push' && ref === 'refs/heads/main' && result === 'failure')
        }
      }
    }
    assert.equal(report.steps.length, 1)
    assert.equal(report.steps[0].run, undefined)
    assert.match(report.steps[0].uses, /^actions\/github-script@/u)
    const script = report.steps[0].with.script
    const run = new (Object.getPrototypeOf(async function () {}).constructor)('github', 'context', script)
    const context = { repo: { owner: 'example', repo: 'example' }, sha: 'a'.repeat(40), runId: 17, serverUrl: 'https://github.com' }
    const existing = []
    const created = []
    const updated = []
    const github = {
      rest: { issues: {
        listForRepo() {},
        create: async issue => { created.push(issue); existing.push({ ...issue, number: 1, state: 'closed' }) },
        update: async issue => { updated.push(issue) },
      } },
      paginate: async () => existing,
    }
    await run(github, context)
    await run(github, context)
    assert.equal(created.length, 1)
    assert.equal(updated.length, 1)
    assert.equal(updated[0].state, 'open')
    assert.deepEqual(created[0].labels, ['agent'])
    assert.ok(created[0].title.includes(context.sha))
    assert.match(created[0].body, /actions\/runs\/17/u)
    await run(github, { ...context, sha: 'b'.repeat(40) })
    assert.equal(created.length, 2)
  })
}

test('automatic Mac signing never exports the release ZIP or update feed', () => {
  const mac = workflows.find(item => item.platform === 'mac').workflow
  const uploads = mac.jobs.package.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
  const preview = uploads.find(step => step.name === 'Upload signed preview installer')
  const release = uploads.find(step => step.name === 'Upload signed installer and update feed')
  for (const event of ['push', 'pull_request']) {
    assert.equal(condition(preview.if, { event_name: event }, { HAS_SIGNING: 'true' }), true)
    assert.equal(condition(release.if, { event_name: event }, { HAS_SIGNING: 'true' }), false)
  }
  assert.equal(condition(preview.if, { event_name: 'pull_request' }, { HAS_SIGNING: 'false' }), false)
  assert.equal(condition(release.if, { event_name: 'workflow_dispatch' }, { HAS_SIGNING: 'true' }), true)
  assert.equal(preview.with.path, 'signed/*.dmg')
  for (const upload of uploads.filter(step => step.name.includes('installer') || step.name === 'Upload installer')) {
    assert.equal(upload.with['retention-days'], 14)
  }
  const windows = workflows.find(item => item.platform === 'windows').workflow
  assert.equal(windows.jobs.package.defaults.run.shell, 'pwsh')
})
