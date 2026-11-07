/** Company desktop CI numbering and summaries; does not publish artifacts or update feeds. */
import { appendFile, readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseVersion, updateDirectory } from './mac-update-release.mjs'

/**
 * Validate a preview version without relaxing stable release validation.
 * @param {string} value Preview version from CI or the packaging environment.
 * @returns {string} Validated version.
 */
export function previewVersion(value) {
  const match = /^(\d+\.\d+\.\d+)-dev\.([1-9]\d*)$/u.exec(value)
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('Preview version must be <next release>-dev.<run number>')
  releaseVersion(match[1])
  return value
}

/**
 * Select the company shell version for either platform, leaving runtime manifests unchanged.
 * @param {NodeJS.ProcessEnv} env Packaging environment.
 * @returns {string | undefined} Company override, or no override for upstream builds.
 */
export function companyDesktopVersion(env) {
  if (env.CRYSOUND_DESKTOP_PREVIEW_VERSION && env.CRYSOUND_DESKTOP_VERSION) throw new Error('Choose a preview or a formal version, never both')
  if (env.CRYSOUND_DESKTOP_PREVIEW_VERSION) return previewVersion(env.CRYSOUND_DESKTOP_PREVIEW_VERSION)
  if (env.CRYSOUND_DESKTOP_VERSION) return releaseVersion(env.CRYSOUND_DESKTOP_VERSION)
}

/**
 * Resolve the CI inputs before dependencies or signing tools run; fork PRs require no secrets.
 * @param {NodeJS.ProcessEnv} env GitHub event and requested manual release settings.
 * @param {string} [nextVersion] Stable target for automatic previews; unused by manual builds.
 * @returns {Record<string, string>} Validated settings to append to GITHUB_ENV.
 */
export function prepareBuild(env, nextVersion) {
  const manual = env.GITHUB_EVENT_NAME === 'workflow_dispatch'
  const mac = env.DESKTOP_PLATFORM === 'mac'
  if (!manual && !['push', 'pull_request'].includes(env.GITHUB_EVENT_NAME)) throw new Error('Unsupported desktop CI event')
  if (mac && env.GITHUB_EVENT_NAME === 'push' && env.GITHUB_REF === 'refs/heads/main' && env.HAS_SIGNING !== 'true') {
    throw new Error('main 的 Mac 构建缺少完整签名和公证凭据，已停止，不能作为签名包交付。')
  }
  const version = manual ? releaseVersion(env.REQUESTED_VERSION)
    : previewVersion(`${releaseVersion(nextVersion)}-dev.${env.GITHUB_RUN_NUMBER}`)
  return {
    DESKTOP_CI_VERSION: version,
    CRYSOUND_DESKTOP_VERSION: manual ? version : '',
    CRYSOUND_DESKTOP_PREVIEW_VERSION: manual ? '' : version,
    CRYSOUND_DESKTOP_UPDATE_URL: manual && mac ? updateDirectory(env.REQUESTED_UPDATE_URL) : '',
  }
}

/**
 * Report actual retained installers, their byte sizes, and any signing failure.
 * @param {NodeJS.ProcessEnv} env CI version, commit and signing outcomes.
 * @param {string[]} paths Candidate artifact paths; absent files are omitted after failed builds.
 * @returns {Promise<string>} Markdown for the run summary.
 */
export async function buildSummary(env, paths) {
  const preview = env.GITHUB_EVENT_NAME !== 'workflow_dispatch'
  const unsigned = env.DESKTOP_PLATFORM === 'win' || env.HAS_SIGNING !== 'true'
  const lines = [
    `## ${env.DESKTOP_PLATFORM === 'mac' ? 'Mac' : 'Windows'} · ${preview ? (unsigned ? '未签名预览' : '签名预览') : '手动正式版构建'}`,
    `版本：${env.DESKTOP_CI_VERSION || '未生成'}  `,
    `提交：${env.GITHUB_SHA}  `,
    '安装包保留 14 天；下载站仍由伙伴助理手动发布。',
  ]
  if (preview) lines.push('预览包不生成或上传更新清单，不进入正式更新目录。')
  if (env.DESKTOP_PLATFORM === 'mac') {
    const signing = env.HAS_SIGNING === 'true'
      ? `签名与公证：${env.SIGNING_OUTCOME || '未运行'}；Gatekeeper 核对：${env.VERIFY_OUTCOME || '未运行'}。`
      : '未签名：没有完整凭据；PR 仅供预览。main 缺少凭据会失败。'
    lines.push(signing)
    if (env.SIGNING_OUTCOME === 'failure') lines.push('签名、公证或盖章失败，具体原因见 Sign and notarize 步骤日志；此运行未通过验收。')
    if (env.VERIFY_OUTCOME === 'failure') lines.push('签名安装包未通过 Gatekeeper 核对，具体原因见 Verify signed installer 步骤日志。')
  }
  lines.push('', '| 产物文件 | 大小（字节） |', '| --- | ---: |')
  for (const path of paths.filter(Boolean)) {
    try {
      const info = await stat(path)
      if (info.isFile()) lines.push(`| ${basename(path)} | ${info.size} |`)
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return `${lines.join('\n')}\n`
}

async function main() {
  const [command, ...paths] = process.argv.slice(2)
  if (command === 'prepare') {
    const { nextVersion } = JSON.parse(await readFile(new URL('../config/desktop-release.json', import.meta.url), 'utf8'))
    const values = prepareBuild(process.env, nextVersion)
    await appendFile(process.env.GITHUB_ENV, Object.entries(values).map(([name, value]) => `${name}=${value}\n`).join(''))
  } else if (command === 'summary') {
    await appendFile(process.env.GITHUB_STEP_SUMMARY, await buildSummary(process.env, paths))
  } else throw new Error('Usage: desktop-ci.mjs prepare | summary [INSTALLER ...]')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(async error => {
    console.error(error.message)
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `构建失败：${error.message}\n`)
    process.exitCode = 1
  })
}
