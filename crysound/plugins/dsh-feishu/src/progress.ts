/** Short activity names for the progress element; arguments never enter the card. */
export function toolProgress(name: string): string {
  const tool = name.toLowerCase()
  if (/^(bash|pwsh|powershell|run_code|exec_command|shell)$/.test(tool)) return '执行命令'
  if (/^(read|read_file|read_image)$/.test(tool)) return '读取文件'
  if (/^(write|edit|write_file|edit_file|str_replace_editor|apply_patch)$/.test(tool)) return '修改文件'
  if (/^(grep|glob|search_files)$/.test(tool)) return '搜索文件'
  if (/^(web_fetch|fetch|fetch_url|read_url|browse|open_url)$/.test(tool)) return '读取网页'
  if (/^(web_search|search|search_web)$/.test(tool)) return '搜索网页'
  if (/subagent|delegate|agent_spawn|spawn_agent|task_agent/.test(tool)) return '派子代理'
  if (tool === 'skill') return '加载技能'
  if (tool === 'todo_write') return '更新待办'
  return '执行工具'
}
