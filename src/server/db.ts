import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseJsonLine } from '../shared/parsers.js';
import type {
  AppId,
  AppInfo,
  BillingMode,
  CommandRun,
  Confirmation,
  EventRecord,
  Session,
  Task,
  TaskStatus,
  TerminalFrame,
  TimeScope,
  TokenUsage
} from '../shared/types.js';

type Row = Record<string, unknown>;

export class Store {
  private db: DatabaseSync;

  constructor(file = join(process.cwd(), 'data', 'workbench.sqlite')) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.migrate();
  }

  upsertApp(app: AppInfo): void {
    this.db.prepare(`
      INSERT INTO apps (id, label, command, status, message, sessions, tasks, color, billing_mode, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        label = excluded.label,
        command = excluded.command,
        status = excluded.status,
        message = excluded.message,
        sessions = excluded.sessions,
        tasks = excluded.tasks,
        color = excluded.color,
        billing_mode = excluded.billing_mode,
        updated_at = excluded.updated_at
    `).run(app.appId, app.label, app.command ?? null, app.status, app.message, app.sessions, app.tasks, app.color, app.billingMode, now());
  }

  listApps(): AppInfo[] {
    return this.db
      .prepare("SELECT * FROM apps ORDER BY CASE id WHEN 'codex' THEN 1 WHEN 'claude' THEN 2 WHEN 'antigravity' THEN 3 WHEN 'oh-my-pi' THEN 4 WHEN 'opencode' THEN 5 ELSE 99 END")
      .all()
      .map(mapApp);
  }

  syncAppCounts(appId: AppId): void {
    const sessions = this.db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE app_id = ?').get(appId) as { count: number };
    const tasks = this.db.prepare('SELECT COUNT(*) AS count FROM tasks WHERE app_id = ?').get(appId) as { count: number };
    this.db.prepare('UPDATE apps SET sessions = ?, tasks = ?, updated_at = ? WHERE id = ?').run(sessions.count, tasks.count, now(), appId);
  }

  upsertSession(session: Session): void {
    this.db.prepare(`
      INSERT INTO sessions (id, app_id, native_id, title, cwd, status, model, created_at, updated_at, input_tokens, output_tokens, total_tokens, live)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        native_id = excluded.native_id,
        title = excluded.title,
        cwd = excluded.cwd,
        status = excluded.status,
        model = excluded.model,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        total_tokens = excluded.total_tokens,
        live = excluded.live
    `).run(
      session.id,
      session.appId,
      session.nativeId ?? null,
      session.title,
      session.cwd ?? null,
      session.status,
      session.model ?? null,
      session.createdAt,
      session.updatedAt,
      session.inputTokens,
      session.outputTokens,
      session.totalTokens,
      session.live ? 1 : 0
    );
  }

  isSessionDeleted(session: Pick<Session, 'id' | 'nativeId'>): boolean {
    const row = this.db
      .prepare(
        `
        SELECT 1 FROM deleted_sessions
        WHERE session_id = ?
           OR (native_id IS NOT NULL AND native_id = ?)
        LIMIT 1
      `
      )
      .get(session.id, session.nativeId ?? '') as Row | undefined;
    return Boolean(row);
  }

  getSession(id: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as Row | undefined;
    return row ? mapSession(row) : undefined;
  }

  getSessionByNativeId(appId: AppId, nativeId: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE app_id = ? AND native_id = ? LIMIT 1').get(appId, nativeId) as Row | undefined;
    return row ? mapSession(row) : undefined;
  }

  listSessionsByNativeId(appId: AppId, nativeId: string): Session[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE app_id = ? AND native_id = ? ORDER BY live DESC, updated_at DESC')
      .all(appId, nativeId)
      .map(mapSession);
  }

  updateSessionNativeId(sessionId: string, nativeId: string): Session | undefined {
    const session = this.getSession(sessionId);
    if (!session || session.nativeId === nativeId) return undefined;
    const timestamp = now();
    this.db
      .prepare('UPDATE sessions SET native_id = ?, updated_at = ? WHERE id = ?')
      .run(nativeId, timestamp, sessionId);
    this.db.prepare('UPDATE tasks SET updated_at = ? WHERE session_id = ?').run(timestamp, sessionId);
    return { ...session, nativeId, updatedAt: timestamp };
  }

  backfillNativeSessionIdsFromEvents(appId: AppId): number {
    const rows = this.db
      .prepare(
        `
        SELECT session_id, payload FROM events
        WHERE app_id = ?
          AND session_id IS NOT NULL
          AND (payload LIKE '%session_id%' OR payload LIKE '%sessionID%' OR payload LIKE '%thread_id%')
        ORDER BY created_at DESC
        LIMIT 4000
      `
      )
      .all(appId) as Array<{ session_id?: string; payload?: string }>;
    let changed = 0;
    const seenSessions = new Set<string>();
    for (const row of rows) {
      if (!row.session_id || !row.payload) continue;
      if (seenSessions.has(row.session_id)) continue;
      const nativeId = nativeSessionIdFromPayload(row.payload, appId);
      if (!nativeId) continue;
      seenSessions.add(row.session_id);
      if (this.updateSessionNativeId(row.session_id, nativeId)) changed += 1;
    }
    return changed;
  }

  listSessions(appId?: AppId): Session[] {
    const sql = appId
      ? 'SELECT * FROM sessions WHERE app_id = ? ORDER BY live DESC, updated_at DESC LIMIT 1000'
      : 'SELECT * FROM sessions ORDER BY live DESC, updated_at DESC LIMIT 2000';
    const rows = appId ? this.db.prepare(sql).all(appId) : this.db.prepare(sql).all();
    return rows.map(mapSession);
  }

  pruneMissingImportedSessions(appId: AppId, importedSessionIds: string[], importedNativeIds = importedSessionIds): number {
    const ids = uniqueStrings(importedSessionIds);
    const nativeIds = uniqueStrings(importedNativeIds);
    if (!ids.length && !nativeIds.length) return 0;
    const idClause = ids.length ? `id NOT IN (${ids.map(() => '?').join(', ')})` : '1 = 1';
    const nativeClause = nativeIds.length ? `(native_id IS NULL OR native_id NOT IN (${nativeIds.map(() => '?').join(', ')}))` : '1 = 1';
    const removableRows = this.db
      .prepare(
        `
        SELECT id FROM sessions
        WHERE app_id = ?
          AND live = 0
          AND native_id IS NOT NULL
          AND ${idClause}
          AND ${nativeClause}
          AND NOT EXISTS (SELECT 1 FROM command_runs WHERE command_runs.session_id = sessions.id)
          AND NOT EXISTS (SELECT 1 FROM events WHERE events.session_id = sessions.id)
      `
      )
      .all(appId, ...ids, ...nativeIds) as Array<{ id: string }>;
    const removableIds = removableRows.map((row) => row.id);
    if (!removableIds.length) return 0;
    const deletePlaceholders = removableIds.map(() => '?').join(', ');
    this.db.exec('BEGIN');
    try {
      this.db.prepare(`DELETE FROM confirmations WHERE session_id IN (${deletePlaceholders})`).run(...removableIds);
      this.db.prepare(`DELETE FROM command_runs WHERE session_id IN (${deletePlaceholders})`).run(...removableIds);
      this.db.prepare(`DELETE FROM events WHERE session_id IN (${deletePlaceholders})`).run(...removableIds);
      this.db.prepare(`DELETE FROM tasks WHERE session_id IN (${deletePlaceholders})`).run(...removableIds);
      this.db.prepare(`DELETE FROM sessions WHERE id IN (${deletePlaceholders})`).run(...removableIds);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.syncAppCounts(appId);
    return removableIds.length;
  }

  listSessionsSince(sinceIso: string): Session[] {
    return this.listSessionsForTokenUsage(sinceIso);
  }

  listSessionsForTokenUsage(sinceIso?: string): Session[] {
    const where = sinceIso ? 'WHERE updated_at >= ?' : '';
    const rows = sinceIso
      ? this.db
          .prepare(`
            SELECT * FROM sessions
            ${where}
            ORDER BY updated_at DESC
          `)
          .all(sinceIso)
      : this.db
          .prepare(`
            SELECT * FROM sessions
            ORDER BY updated_at DESC
          `)
          .all();
    return rows.map(mapSession);
  }

  mergeDuplicateSession(targetSessionId: string, duplicateSessionId: string): void {
    if (targetSessionId === duplicateSessionId) return;
    const target = this.getSession(targetSessionId);
    const duplicate = this.getSession(duplicateSessionId);
    if (!target || !duplicate || target.appId !== duplicate.appId) return;
    this.db.exec('BEGIN');
    try {
      this.db.prepare('UPDATE events SET session_id = ? WHERE session_id = ?').run(targetSessionId, duplicateSessionId);
      this.db.prepare('UPDATE command_runs SET session_id = ? WHERE session_id = ?').run(targetSessionId, duplicateSessionId);
      this.db.prepare('UPDATE confirmations SET session_id = ? WHERE session_id = ?').run(targetSessionId, duplicateSessionId);
      this.db.prepare('DELETE FROM tasks WHERE session_id = ?').run(duplicateSessionId);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(duplicateSessionId);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.syncAppCounts(target.appId);
  }

  incrementSessionTokens(sessionId: string, inputDelta: number, outputDelta: number): Session | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    const inputTokens = session.inputTokens + safeToken(inputDelta);
    const outputTokens = session.outputTokens + safeToken(outputDelta);
    const totalTokens = inputTokens + outputTokens;
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE sessions
        SET input_tokens = ?, output_tokens = ?, total_tokens = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(inputTokens, outputTokens, totalTokens, timestamp, sessionId);
    this.db
      .prepare(`
        UPDATE tasks
        SET input_tokens = ?, output_tokens = ?, total_tokens = ?, updated_at = ?
        WHERE session_id = ?
      `)
      .run(inputTokens, outputTokens, totalTokens, timestamp, sessionId);
    return { ...session, inputTokens, outputTokens, totalTokens, updatedAt: timestamp };
  }

  upsertTask(task: Task): void {
    this.db.prepare(`
      INSERT INTO tasks (id, session_id, app_id, title, cwd, status, billing_mode, started_at, updated_at, duration_ms, input_tokens, output_tokens, total_tokens)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        cwd = excluded.cwd,
        status = excluded.status,
        billing_mode = excluded.billing_mode,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        duration_ms = excluded.duration_ms,
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        total_tokens = excluded.total_tokens
    `).run(
      task.id,
      task.sessionId,
      task.appId,
      task.title,
      task.cwd ?? null,
      task.status,
      task.billingMode,
      task.startedAt,
      task.updatedAt,
      task.durationMs,
      task.inputTokens,
      task.outputTokens,
      task.totalTokens
    );
  }

  updateTaskStatusBySession(sessionId: string, status: TaskStatus): void {
    this.db.prepare('UPDATE tasks SET status = ?, updated_at = ? WHERE session_id = ?').run(status, now(), sessionId);
  }

  listTasks(filters: { appId?: AppId; status?: TaskStatus } = {}): Task[] {
    const clauses: string[] = [];
    const params: string[] = [];
    if (filters.appId) {
      clauses.push('app_id = ?');
      params.push(filters.appId);
    }
    if (filters.status) {
      clauses.push('status = ?');
      params.push(filters.status);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    return this.db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT 2000`).all(...params).map(mapTask);
  }

  insertEvent(event: EventRecord): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO events (id, type, app_id, session_id, task_id, message, token_delta, created_at, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.type,
      event.appId ?? null,
      event.sessionId ?? null,
      event.taskId ?? null,
      event.message,
      event.tokenDelta ?? null,
      event.createdAt,
      event.payload ? JSON.stringify(event.payload) : null
    );
  }

  listEvents(limit = 40): EventRecord[] {
    return this.db.prepare('SELECT * FROM events ORDER BY created_at DESC LIMIT ?').all(limit).map(mapEvent);
  }

  listTerminalFramesForSession(sessionId: string, limit = 5000): TerminalFrame[] {
    const rows = this.db
      .prepare(
        `
        SELECT app_id, payload, created_at FROM events
        WHERE session_id = ?
          AND type = 'terminal.output'
          AND payload IS NOT NULL
        ORDER BY created_at ASC
        LIMIT ?
      `
      )
      .all(sessionId, limit) as Array<{ app_id?: string; payload?: string; created_at: string }>;
    const frames: TerminalFrame[] = [];
    for (const row of rows) {
      const frame = terminalFrameFromPayload(row.payload, sessionId, row.app_id as AppId | undefined, row.created_at);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  replaceTokenUsage(rows: TokenUsage[]): void {
    const insert = this.db.prepare(`
      INSERT INTO token_usage (app_id, scope, input_tokens, output_tokens, total_tokens, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(app_id, scope) DO UPDATE SET
        input_tokens = excluded.input_tokens,
        output_tokens = excluded.output_tokens,
        total_tokens = excluded.total_tokens,
        updated_at = excluded.updated_at
    `);
    const timestamp = now();
    this.db.exec('BEGIN');
    try {
      for (const row of rows) insert.run(row.appId, row.scope, row.inputTokens, row.outputTokens, row.totalTokens, timestamp);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  listTokenUsage(scope: TimeScope): TokenUsage[] {
    return this.db
      .prepare(`
        SELECT * FROM token_usage
        WHERE scope = ?
        ORDER BY CASE app_id WHEN 'codex' THEN 1 WHEN 'claude' THEN 2 WHEN 'antigravity' THEN 3 WHEN 'oh-my-pi' THEN 4 WHEN 'opencode' THEN 5 ELSE 99 END
      `)
      .all(scope)
      .map(mapTokenUsage);
  }

  insertCommandRun(run: CommandRun): void {
    this.db.prepare(`
      INSERT INTO command_runs (id, session_id, app_id, prompt, status, created_at, updated_at, risk)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, run.sessionId, run.appId, run.prompt, run.status, run.createdAt, run.updatedAt, run.risk ? JSON.stringify(run.risk) : null);
  }

  updateCommandRun(id: string, status: CommandRun['status']): void {
    this.db.prepare('UPDATE command_runs SET status = ?, updated_at = ? WHERE id = ?').run(status, now(), id);
  }

  updateActiveCommandRunsBySession(sessionId: string, status: CommandRun['status']): number {
    const result = this.db
      .prepare("UPDATE command_runs SET status = ?, updated_at = ? WHERE session_id = ? AND status IN ('queued', 'running')")
      .run(status, now(), sessionId);
    return Number(result.changes ?? 0);
  }

  getCommandRun(id: string): CommandRun | undefined {
    const row = this.db.prepare('SELECT * FROM command_runs WHERE id = ?').get(id) as Row | undefined;
    return row ? mapCommandRun(row) : undefined;
  }

  insertConfirmation(confirmation: Confirmation): void {
    this.db.prepare(`
      INSERT INTO confirmations (id, session_id, app_id, command_run_id, reason, status, created_at, resolved_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      confirmation.id,
      confirmation.sessionId,
      confirmation.appId,
      confirmation.commandRunId ?? null,
      confirmation.reason,
      confirmation.status,
      confirmation.createdAt,
      confirmation.resolvedAt ?? null
    );
  }

  resolveConfirmation(id: string, status: 'approved' | 'rejected'): Confirmation | undefined {
    this.db.prepare('UPDATE confirmations SET status = ?, resolved_at = ? WHERE id = ?').run(status, now(), id);
    const row = this.db.prepare('SELECT * FROM confirmations WHERE id = ?').get(id) as Row | undefined;
    return row ? mapConfirmation(row) : undefined;
  }

  getConfirmation(id: string): Confirmation | undefined {
    const row = this.db.prepare('SELECT * FROM confirmations WHERE id = ?').get(id) as Row | undefined;
    return row ? mapConfirmation(row) : undefined;
  }

  listConfirmations(): Confirmation[] {
    return this.db.prepare("SELECT * FROM confirmations WHERE status = 'pending' ORDER BY created_at DESC").all().map(mapConfirmation);
  }

  deleteSession(sessionId: string): Session | undefined {
    const session = this.getSession(sessionId);
    if (!session) return undefined;
    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(
          `
          INSERT INTO deleted_sessions (session_id, app_id, native_id, title, deleted_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            app_id = excluded.app_id,
            native_id = excluded.native_id,
            title = excluded.title,
            deleted_at = excluded.deleted_at
        `
        )
        .run(session.id, session.appId, session.nativeId ?? null, session.title, now());
      this.db.prepare('DELETE FROM confirmations WHERE session_id = ?').run(session.id);
      this.db.prepare('DELETE FROM command_runs WHERE session_id = ?').run(session.id);
      this.db.prepare('DELETE FROM events WHERE session_id = ?').run(session.id);
      this.db.prepare('DELETE FROM tasks WHERE session_id = ?').run(session.id);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(session.id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
    this.syncAppCounts(session.appId);
    return session;
  }

  deleteDemoData(): void {
    const demoSessionIds = ['codex-C-184', 'claude-CL-77', 'antigravity-AG-12', 'codex-C-201'];
    const placeholders = demoSessionIds.map(() => '?').join(', ');
    this.db.prepare(`DELETE FROM tasks WHERE session_id IN (${placeholders})`).run(...demoSessionIds);
    this.db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...demoSessionIds);
    this.db.prepare("DELETE FROM events WHERE id LIKE 'event-demo-%'").run();
  }

  deleteWorkbenchTestData(): void {
    const defaultPrompt = '继续当前任务，先说明失败原因，再只修改必要文件；完成后运行相关测试。';
    const rows = this.db
      .prepare(
        `
        SELECT id FROM sessions
        WHERE title LIKE 'PTY smoke test%'
           OR title LIKE 'Claude PTY smoke test%'
           OR (title = ? AND total_tokens = 0 AND live = 1)
      `
      )
      .all(defaultPrompt) as Array<{ id: string }>;
    const ids = rows.map((row) => row.id);
    if (!ids.length) return;
    const placeholders = ids.map(() => '?').join(', ');
    this.db.prepare(`DELETE FROM confirmations WHERE session_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM command_runs WHERE session_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM events WHERE session_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM tasks WHERE session_id IN (${placeholders})`).run(...ids);
    this.db.prepare(`DELETE FROM sessions WHERE id IN (${placeholders})`).run(...ids);
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS apps (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        command TEXT,
        status TEXT NOT NULL,
        message TEXT NOT NULL,
        sessions INTEGER NOT NULL DEFAULT 0,
        tasks INTEGER NOT NULL DEFAULT 0,
        color TEXT NOT NULL,
        billing_mode TEXT NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        native_id TEXT,
        title TEXT NOT NULL,
        cwd TEXT,
        status TEXT NOT NULL,
        model TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        live INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        title TEXT NOT NULL,
        cwd TEXT,
        status TEXT NOT NULL,
        billing_mode TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        app_id TEXT,
        session_id TEXT,
        task_id TEXT,
        message TEXT NOT NULL,
        token_delta INTEGER,
        created_at TEXT NOT NULL,
        payload TEXT
      );

      CREATE TABLE IF NOT EXISTS token_usage (
        app_id TEXT NOT NULL,
        scope TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        total_tokens INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (app_id, scope)
      );

      CREATE TABLE IF NOT EXISTS command_runs (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        risk TEXT
      );

      CREATE TABLE IF NOT EXISTS confirmations (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        app_id TEXT NOT NULL,
        command_run_id TEXT,
        reason TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS deleted_sessions (
        session_id TEXT PRIMARY KEY,
        app_id TEXT NOT NULL,
        native_id TEXT,
        title TEXT NOT NULL,
        deleted_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_deleted_sessions_native_id ON deleted_sessions(native_id);
    `);
    this.db.prepare("UPDATE apps SET sort_order = CASE id WHEN 'codex' THEN 1 WHEN 'claude' THEN 2 WHEN 'antigravity' THEN 3 WHEN 'oh-my-pi' THEN 4 WHEN 'opencode' THEN 5 ELSE 99 END").run();
  }
}

export function now(): string {
  return new Date().toISOString();
}

function mapApp(row: Row): AppInfo {
  return {
    appId: row.id as AppId,
    label: row.label as string,
    command: nullable(row.command),
    status: row.status as AppInfo['status'],
    message: row.message as string,
    sessions: row.sessions as number,
    tasks: row.tasks as number,
    color: row.color as string,
    billingMode: row.billing_mode as BillingMode
  };
}

function mapSession(row: Row): Session {
  return {
    id: row.id as string,
    appId: row.app_id as AppId,
    nativeId: nullable(row.native_id),
    title: row.title as string,
    cwd: nullable(row.cwd),
    status: row.status as TaskStatus,
    model: nullable(row.model),
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    totalTokens: row.total_tokens as number,
    live: Boolean(row.live)
  };
}

function mapTask(row: Row): Task {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    appId: row.app_id as AppId,
    title: row.title as string,
    cwd: nullable(row.cwd),
    status: row.status as TaskStatus,
    billingMode: row.billing_mode as BillingMode,
    startedAt: row.started_at as string,
    updatedAt: row.updated_at as string,
    durationMs: row.duration_ms as number,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    totalTokens: row.total_tokens as number
  };
}

function mapEvent(row: Row): EventRecord {
  return {
    id: row.id as string,
    type: row.type as EventRecord['type'],
    appId: nullable(row.app_id) as AppId | undefined,
    sessionId: nullable(row.session_id),
    taskId: nullable(row.task_id),
    message: row.message as string,
    tokenDelta: row.token_delta as number | undefined,
    createdAt: row.created_at as string,
    payload: row.payload ? JSON.parse(row.payload as string) : undefined
  };
}

function mapTokenUsage(row: Row): TokenUsage {
  return {
    appId: row.app_id as AppId,
    scope: row.scope as TimeScope,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    totalTokens: row.total_tokens as number
  };
}

function mapCommandRun(row: Row): CommandRun {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    appId: row.app_id as AppId,
    prompt: row.prompt as string,
    status: row.status as CommandRun['status'],
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
    risk: row.risk ? JSON.parse(row.risk as string) : undefined
  };
}

function mapConfirmation(row: Row): Confirmation {
  return {
    id: row.id as string,
    sessionId: row.session_id as string,
    appId: row.app_id as AppId,
    commandRunId: nullable(row.command_run_id),
    reason: row.reason as string,
    status: row.status as Confirmation['status'],
    createdAt: row.created_at as string,
    resolvedAt: nullable(row.resolved_at)
  };
}

function nullable(value: unknown): string | undefined {
  return typeof value === 'string' && value.length ? value : undefined;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function terminalFrameFromPayload(payload: string | undefined, sessionId: string, appId: AppId | undefined, createdAt: string): TerminalFrame | undefined {
  if (!payload) return undefined;
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!parsed || typeof parsed !== 'object') return undefined;
    const frame = parsed as Partial<TerminalFrame>;
    if (typeof frame.text !== 'string' || !frame.text.trim()) return undefined;
    const stream = frame.stream === 'stdout' || frame.stream === 'stderr' || frame.stream === 'system' ? frame.stream : 'system';
    return {
      sessionId: typeof frame.sessionId === 'string' ? frame.sessionId : sessionId,
      appId: (typeof frame.appId === 'string' ? frame.appId : appId) as AppId,
      stream,
      text: frame.text,
      createdAt: typeof frame.createdAt === 'string' ? frame.createdAt : createdAt
    };
  } catch {
    return undefined;
  }
}

function safeToken(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function nativeSessionIdFromPayload(payload: string, appId: AppId): string | undefined {
  try {
    const parsed = JSON.parse(payload) as unknown;
    const text = parsed && typeof parsed === 'object' ? (parsed as { text?: unknown }).text : undefined;
    if (typeof text === 'string') return nativeSessionIdFromText(text, appId);
  } catch {
    return nativeSessionIdFromText(payload, appId);
  }
  return nativeSessionIdFromText(payload, appId);
}

function nativeSessionIdFromText(text: string, appId: AppId): string | undefined {
  for (const line of text.split('\n')) {
    const parsed = parseJsonLine(line);
    if (parsed && typeof parsed === 'object') {
      const nativeId = nativeSessionIdFromJson(parsed as Record<string, unknown>, appId);
      if (nativeId) return nativeId;
    }
    const match = /"(?:session_id|sessionID)"\s*:\s*"([^"]{8,})"/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

function nativeSessionIdFromJson(record: Record<string, unknown>, appId: AppId): string | undefined {
  const sessionId = stringNativeId(record.session_id ?? record.sessionID);
  if (sessionId) return sessionId;
  if (appId !== 'codex' || record.type !== 'thread.started') return undefined;
  const threadId = stringNativeId(record.thread_id);
  return threadId && isUuid(threadId) ? threadId : undefined;
}

function stringNativeId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length >= 8 ? value : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
