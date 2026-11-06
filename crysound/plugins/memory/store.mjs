/** Persistent, bounded personal facts. SQLite serializes writers across host processes. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

const kinds = new Set(['preference', 'identity', 'project']);
const sources = new Set(['conversation', 'manual', 'edited']);
const sensitive = /密码|口令|令牌|密钥|验证码|私钥|助记词|password|passwd|passphrase|passcode|api[ _-]?key|\btoken\b|credential|private[ _-]?key|secret|bearer\s|-----BEGIN|\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[\w-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/iu;
// Reject digit sequences even when written without a descriptive label. No checksum is needed.
const personalNumber = /(?<!\d)(?:\d{17}[\dXx]|\d{16,19})(?!\d)/u;
const idPattern = /^[a-f0-9]{24}$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function factInput(input) {
  if (!input || !kinds.has(input.kind) || typeof input.title !== 'string' || typeof input.content !== 'string') {
    throw new Error('请提供有效的记忆类别、标题和内容。');
  }
  const title = input.title.trim();
  const content = input.content.trim();
  if (!title || title.length > 40 || !content || content.length > 240 || /[\r\n\x00-\x1f]/u.test(title + content)) {
    throw new Error('每条记忆只保存一个事实：标题不超过 40 字，内容不超过 240 字，不含换行。');
  }
  if (sensitive.test(title + ' ' + content)) throw new Error('这条内容可能包含凭据，不保存。');
  if (personalNumber.test(title + ' ' + content)) throw new Error('这条内容可能包含身份证号或银行卡号，不保存。');
  return { kind: input.kind, title, content };
}

function factId(id) {
  if (typeof id !== 'string' || !idPattern.test(id)) throw new Error('请选择有效的记忆编号。');
  return id;
}

/** Model-facing facts include update dates; private UI metadata stays outside the recall budget. */
export function recallData({ revision, enabled, facts }) {
  return { revision, enabled, facts: enabled ? facts.map(({ id, kind, title, content, updatedAt }) =>
    ({ id, kind, title, content, updatedDate: updatedAt.slice(0, 10) })) : [] };
}

/** SQLite-backed store; one directory belongs to one user's persistent DSH home. */
export class MemoryStore {
  /** @param {string} directory Plugin-owned directory. @param {object} limits Configured limits. */
  constructor(directory, { maxMemories = 50, recallChars = 6000 } = {}) {
    if (!Number.isInteger(maxMemories) || maxMemories < 1 || maxMemories > 200
      || !Number.isInteger(recallChars) || recallChars < 512 || recallChars > 24000) {
      throw new Error('记忆数量须为 1–200，召回字符预算须为 512–24000。');
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = join(directory, 'memory.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.maxMemories = maxMemories;
    this.recallChars = recallChars;
    try {
      this.db.exec('PRAGMA busy_timeout=3000; PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON;');
      const version = this.db.prepare('PRAGMA user_version').get().user_version;
      if (version !== 0 && version !== 1) throw new Error('记忆数据库来自不支持的版本，请先升级插件。');
      // Unreleased format 1: no migration of disposable trial databases.
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, enabled INTEGER NOT NULL CHECK(enabled IN (0,1)));
        INSERT OR IGNORE INTO meta VALUES (1, 0, 1);
        CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL,
          createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, source TEXT NOT NULL);
        PRAGMA user_version=1; COMMIT;`);
      this.snapshot();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  /** Read one consistent snapshot; never trim silently when configuration is reduced. */
  snapshot() {
    this.db.exec('BEGIN');
    try {
      const value = this.read();
      this.db.exec('COMMIT');
      return value;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Read within the caller's transaction; validate disk data before model exposure. */
  read() {
    const { revision, enabled } = this.db.prepare('SELECT revision,enabled FROM meta WHERE id=1').get();
    const facts = this.db.prepare('SELECT * FROM facts ORDER BY createdAt,id').all().map(row => {
      const fact = factInput(row);
      if (!idPattern.test(row.id) || !sources.has(row.source) || !datePattern.test(row.createdAt) || !datePattern.test(row.updatedAt)) {
        throw new Error('记忆数据损坏，请检查存储。');
      }
      return { id: row.id, ...fact, createdAt: row.createdAt, updatedAt: row.updatedAt, source: row.source };
    });
    if (!Number.isSafeInteger(revision) || revision < 0 || ![0, 1].includes(enabled)) throw new Error('记忆版本或开关无效。');
    const value = { revision, enabled: enabled === 1, facts };
    // Count the full enabled recall JSON even when disabled, so toggling never hides an overrun.
    const chars = JSON.stringify(recallData({ ...value, enabled: true })).length;
    if (facts.length > this.maxMemories || chars > this.recallChars) {
      throw new Error('记忆已超出当前预算，请先整理；不会自动删除旧记忆。');
    }
    return { ...value, usage: { count: facts.length, chars, nearCapacity: facts.length >= this.maxMemories * 0.8 || chars >= this.recallChars * 0.8 } };
  }

  /** Commit against an observed revision so stale writers cannot undo deletion or the switch. */
  change(revision, update) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('请先读取当前记忆版本。');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const before = this.read();
      if (before.revision !== revision) throw new Error('记忆已变化，请重新读取；不要用旧会话内容恢复已删记忆。');
      update(before);
      this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
      const result = this.read();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Save by random id; approved merges, removals and the target write share one transaction. */
  save(input, { source = 'conversation', requireEnabled = true } = {}) {
    return this.change(input.revision, before => {
      if (requireEnabled && !before.enabled) throw new Error('记忆已关闭');
      const fact = factInput(input);
      const id = input.id === undefined ? randomBytes(12).toString('hex') : factId(input.id);
      const removeIds = input.removeIds ?? [];
      const updates = input.updates ?? [];
      if (!Array.isArray(removeIds) || !Array.isArray(updates) || removeIds.length + updates.length > this.maxMemories) {
        throw new Error('整理方案无效，请重新读取记忆。');
      }
      if ((removeIds.length || updates.length) && input.confirmed !== true) throw new Error('请先让用户确认要合并或删除的条目。');
      const touched = new Set([id]);
      for (const removeId of removeIds) {
        factId(removeId);
        if (touched.has(removeId)) throw new Error('整理方案中有重复编号。');
        touched.add(removeId);
        this.deleteFact(removeId);
      }
      for (const update of updates) {
        factId(update?.id);
        if (touched.has(update.id)) throw new Error('整理方案中有重复编号。');
        touched.add(update.id);
        this.writeFact(update.id, factInput(update), source, true);
      }
      this.writeFact(id, fact, source, input.id !== undefined);
    });
  }

  /** Write one validated fact and retain its creation timestamp on updates. */
  writeFact(id, fact, source, exists) {
    const now = new Date().toISOString();
    if (exists) {
      const result = this.db.prepare('UPDATE facts SET kind=?,title=?,content=?,updatedAt=?,source=? WHERE id=?')
        .run(fact.kind, fact.title, fact.content, now, source, id);
      if (result.changes !== 1) throw new Error('这条记忆已不存在，请刷新。');
    } else {
      this.db.prepare('INSERT INTO facts VALUES (?,?,?,?,?,?,?)').run(id, fact.kind, fact.title, fact.content, now, now, source);
    }
  }

  deleteFact(id) {
    if (this.db.prepare('DELETE FROM facts WHERE id=?').run(id).changes !== 1) throw new Error('这条记忆已不存在，请刷新。');
  }

  /** Remove one fact without a content-bearing tombstone or backup. */
  remove({ id, revision }) {
    factId(id);
    return this.change(revision, () => this.deleteFact(id));
  }

  /** The switch is personal, durable, and participates in optimistic concurrency. */
  setEnabled({ enabled, revision }) {
    if (typeof enabled !== 'boolean') throw new Error('请选择开启或关闭记忆。');
    return this.change(revision, () => this.db.prepare('UPDATE meta SET enabled=? WHERE id=1').run(enabled ? 1 : 0));
  }

  /** Securely clear every fact in one revision-checked transaction after confirmation. */
  clear({ revision, confirmed }) {
    if (confirmed !== true) throw new Error('请再次确认清空全部记忆。');
    return this.change(revision, () => this.db.exec('DELETE FROM facts'));
  }

  /** Release the database when the plugin is disposed. */
  close() { this.db.close(); }
}
