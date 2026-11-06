/** Persistent, bounded personal facts. SQLite serializes writers across host processes. */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const kinds = new Set(['preference', 'identity', 'project']);
const sensitive = /密码|口令|令牌|密钥|验证码|私钥|助记词|password|passwd|passphrase|passcode|api[ _-]?key|\btoken\b|credential|private[ _-]?key|secret|bearer\s|-----BEGIN|\b(?:sk-|ghp_|github_pat_|xox[baprs]-)[\w-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/iu;

/** Validate model/file input without echoing rejected content. */
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
  return { kind: input.kind, title, content };
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
      this.db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL);
        INSERT OR IGNORE INTO meta VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS facts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, content TEXT NOT NULL);
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

  /** Read within the caller's transaction; data from disk is validated before model exposure. */
  read() {
    const revision = this.db.prepare('SELECT revision FROM meta WHERE id=1').get().revision;
    const facts = this.db.prepare('SELECT id,kind,title,content FROM facts ORDER BY id').all().map(row => {
      const fact = factInput(row);
      if (!/^[a-f0-9]{24}$/u.test(row.id)) throw new Error('记忆数据损坏，请检查存储。');
      return { id: row.id, ...fact };
    });
    const value = { revision, facts };
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('记忆版本无效。');
    if (facts.length > this.maxMemories || JSON.stringify(value).length > this.recallChars) {
      throw new Error('记忆已超出当前预算，请先在原预算下整理记忆。');
    }
    return value;
  }

  /** Commit only against an observed revision, so stale writers cannot undo deletion. */
  change(revision, update) {
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('请先读取当前记忆版本。');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (this.read().revision !== revision) throw new Error('记忆已变化，请重新读取；不要用旧会话内容恢复已删记忆。');
      update();
      this.db.exec('UPDATE meta SET revision=revision+1 WHERE id=1');
      const result = this.read();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** Save/update one stable concept, identified by category and normalized title. */
  save(input) {
    const fact = factInput(input);
    const id = createHash('sha256').update(fact.kind + ':' + fact.title.normalize('NFKC').toLowerCase()).digest('hex').slice(0, 24);
    return this.change(input.revision, () => {
      this.db.prepare('INSERT INTO facts VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,title=excluded.title')
        .run(id, fact.kind, fact.title, fact.content);
    });
  }

  /** Remove exactly one fact without a content-bearing tombstone or backup. */
  remove({ id, revision }) {
    if (typeof id !== 'string' || !/^[a-f0-9]{24}$/u.test(id)) throw new Error('请选择要删除的记忆。');
    return this.change(revision, () => {
      const result = this.db.prepare('DELETE FROM facts WHERE id=?').run(id);
      if (result.changes !== 1) throw new Error('这条记忆已不存在，请刷新。');
    });
  }

  /** Release the database when the plugin is disposed. */
  close() { this.db.close(); }
}
