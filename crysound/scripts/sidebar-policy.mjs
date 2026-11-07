/** Company panel ordering without installation history or persisted preferences. */
export function sidebarPanels(panels) {
  const fixedIds = ['baoyu-design.artifacts', 'schedules', 'plugins'];
  const fixed = fixedIds.flatMap(id => panels.filter(panel => panel.id === id));
  const names = new Intl.Collator('zh-CN-u-co-pinyin', { numeric: true });
  const labels = new Map();
  for (const panel of panels) {
    const owner = panel.owner ?? panel.id;
    const name = panel.pluginName ?? panel.label;
    if (!labels.has(owner) || names.compare(name, labels.get(owner)) < 0) labels.set(owner, name);
  }
  const extras = panels.filter(panel => !fixedIds.includes(panel.id)).slice().sort((a, b) => {
    const ownerA = a.owner ?? a.id;
    const ownerB = b.owner ?? b.id;
    return names.compare(labels.get(ownerA), labels.get(ownerB))
      || (ownerA < ownerB ? -1 : ownerA > ownerB ? 1 : 0)
      || a.order - b.order;
  });
  return { fixed, extras, visible: [...fixed, ...(extras.length <= 2 ? extras : [])] };
}

/** Single-workspace presentation is flat; the saved grouping choice stays intact. */
export function sidebarGrouping(workspaceCount, saved) {
  return workspaceCount <= 1 ? 'flat' : saved === 'workspace-tree' ? saved : 'workspace';
}
