/** Safe, deliberately small tool summaries. Never render arguments or results. */
const SECRET = /\.env|secret|token|password|credential|api_key|apikey|sk-|ghp_|bearer|id_rsa|id_ed25519/i
export function safeLabel(value: unknown): string {
  return typeof value === 'string' && /^[a-z0-9._-]{1,64}$/i.test(value)
    && !SECRET.test(value) && !/[a-z0-9]{24}/i.test(value) ? value : ''
}
export function toolProgress(name: string, raw: unknown): string {
  let args: Record<string, unknown> = {}
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) args = parsed
  } catch { /* malformed arguments carry no label */ }
  for (const key of ['description', 'title']) {
    const value = args[key]
    if (typeof value === 'string' && /\p{Script=Han}/u.test(value)) return value.replace(/[\r\n]+/g, ' ')
  }
  const tool = name.toLowerCase()
  const label = (value: unknown) => { const safe = safeLabel(value); return safe ? ` ${safe}` : '' }
  const file = typeof (args.path ?? args.file_path ?? args.filename) === 'string'
    ? String(args.path ?? args.file_path ?? args.filename).split(/[\\/]/).pop() : undefined
  if (/^(bash|pwsh|powershell|run_code|exec_command|shell)$/.test(tool)) return '运行命令'
  if (/^(read|read_file|read_image)$/.test(tool)) return `读取文件${label(file)}`
  if (/^(write|edit|write_file|edit_file|str_replace_editor|apply_patch)$/.test(tool)) return `修改文件${label(file)}`
  if (/^(grep|glob|search_files)$/.test(tool)) return '搜索文件'
  if (/^(web_fetch|fetch|fetch_url|read_url|browse|open_url)$/.test(tool)) {
    let host = ''
    try { const url = new URL(String(args.url)); if (/^https?:$/.test(url.protocol)) host = url.hostname } catch { /* no label */ }
    return `读取网页${label(host)}`
  }
  if (/^(web_search|search|search_web)$/.test(tool)) return '联网搜索'
  if (/subagent|delegate|agent_spawn|spawn_agent|task_agent/.test(tool)) return '派子代理'
  if (tool === 'skill') return `加载技能${label(args.name ?? args.skill ?? args.skill_name)}`
  if (tool === 'todo_write') return '更新待办'
  const mcp = /^mcp__(.*?)__/.exec(tool)
  if (mcp) return `调用工具${label(mcp[1])}`
  return '执行操作'
}
