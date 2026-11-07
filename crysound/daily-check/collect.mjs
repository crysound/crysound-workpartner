// The only commands admitted here are fixed read-only, user-identity shortcuts.
// Output shapes verified against larksuite/cli 1.0.99 and its shortcut sources.
export function createCollector(run) {
  return async (user, day, now) => {
    async function call(args) {
      const result = await run(user, [...args, '--as', 'user', '--format', 'json']);
      if (result.ok !== true || result.identity !== 'user' || result.data?.has_more || result.data?.notice) throw new Error('Feishu read incomplete');
      return result.data;
    }
    const search = await call(['im', '+messages-search', '--is-at-me', '--no-reactions', '--page-all', '--page-size', '50']);
    if (search.messages !== null && !Array.isArray(search.messages)) throw new Error('Missing message details');
    const messages = search.messages || [];
    const unread = new Set();
    for (let i = 0; i < messages.length; i += 50) {
      const ids = messages.slice(i, i + 50).map(message => message.message_id);
      if (ids.some(id => typeof id !== 'string' || !/^om_[a-zA-Z0-9_-]+$/.test(id))) throw new Error('Invalid message identity');
      const statuses = await call(['im', '+messages-read-status', '--message-ids', ids.join(',')]);
      if (statuses.invalid_message_ids?.length || !Array.isArray(statuses.items) || ids.some(id => !statuses.items.some(item => item.message_id === id && typeof item.is_read === 'boolean'))) throw new Error('Unknown read status');
      for (const item of statuses.items) if (!item.is_read) unread.add(item.message_id);
    }
    const start = `${day.date}T00:00:00+08:00`;
    const end = new Date(Date.parse(start) + 2 * 86400000).toISOString();
    const agenda = await call(['calendar', '+agenda', '--start', start, '--end', end]);
    const tasks = await call(['task', '+get-my-tasks', '--complete=false', '--page-all']);
    if (agenda !== null && !Array.isArray(agenda) || tasks.items !== null && !Array.isArray(tasks.items)) throw new Error('Invalid agenda/tasks');
    const items = [];
    const text = value => typeof value === 'string' ? value.slice(0, 1200) : JSON.stringify(value).slice(0, 1200);
    for (const message of messages) if (unread.has(message.message_id) && !message.deleted) {
      items.push({ id: 'mention:' + message.message_id, text: `未读 @：${text(message.content)}${message.chat_name ? '（' + text(message.chat_name) + '）' : ''}` });
    }
    for (const event of agenda || []) {
      if (event.status === 'cancelled' || event.self_attendee_status === 'decline') continue;
      const endAt = Date.parse(event.end_time?.datetime || (event.end_time?.date ? event.end_time.date + 'T23:59:59+08:00' : ''));
      if (!Number.isFinite(endAt) || !event.event_id || !event.summary) throw new Error('Incomplete calendar entry');
      if (endAt <= now) continue;
      const when = event.start_time?.datetime || event.start_time?.date;
      if (!when) throw new Error('Missing event time');
      items.push({ id: `event:${event.event_id}:${when}`, text: `日程：${text(event.summary)}，${when}` });
    }
    for (const task of tasks.items || []) {
      if (typeof task.completed !== 'boolean' || !task.guid || !task.summary) throw new Error('Incomplete task');
      if (task.completed) continue;
      items.push({ id: 'task:' + task.guid, text: `待办：${text(task.summary)}${task.due_at ? '，截止 ' + task.due_at : '，未设截止时间'}` });
    }
    return items;
  };
}
