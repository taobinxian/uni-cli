import { readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Adapter, AdapterDeps } from './base.js';
import { requireCommand, resolveCommand } from './command-discovery.js';
import { exists, listFilesRecursive, readJsonlTail } from './fs-utils.js';
import { compactHistoryFrames, historyFrame, textFromContent } from './history.js';
import { parseJsonLine } from '../../shared/parsers.js';
import type { AdapterStatus, DeleteSessionLogsResult, Session, StartSessionInput, TaskStatus, TerminalFrame, TimeScope, TokenUsage } from '../../shared/types.js';

const CODEX_STALE_LIVE_MS = 30 * 60 * 1000;

export class CodexAdapter implements Adapter {
  appId = 'codex' as const;
  label = 'Codex';
  color = '#0d8a72';
  defaultModel = 'gpt-5-codex';
  private commandHint = process.env.CODEX_CMD ?? 'codex';
  private launcher: AdapterDeps['launcher'];

  constructor(deps: AdapterDeps) {
    this.launcher = deps.launcher;
  }

  async detect(): Promise<AdapterStatus> {
    const command = await resolveCommand({ envVar: 'CODEX_CMD', names: ['codex'] });
    const sessions = await this.listSessions();
    return {
      appId: this.appId,
      label: this.label,
      command: command ?? this.commandHint,
      status: command ? 'connected' : 'missing',
      message: command ? 'Codex CLI 可用' : '未找到 Codex CLI，可设置 CODEX_CMD 或将 codex 加入 PATH',
      sessions: sessions.length,
      tasks: sessions.length
    };
  }

  async listSessions(): Promise<Session[]> {
    return this.parseHistoricalLogs();
  }

  async startSession(input: StartSessionInput, sessionId = `codex-${randomUUID()}`): Promise<Session> {
    const command = await requireCommand({ envVar: 'CODEX_CMD', names: ['codex'] }, this.label);
    const timestamp = new Date().toISOString();
    const session: Session = {
      id: sessionId,
      appId: this.appId,
      title: input.title ?? input.prompt?.slice(0, 48) ?? 'Codex session',
      cwd: input.cwd,
      status: 'running',
      model: this.defaultModel,
      createdAt: timestamp,
      updatedAt: timestamp,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      live: true
    };
    await this.launcher.launch({
      appId: this.appId,
      sessionId,
      command,
      args: input.prompt ? codexExecArgs(input.prompt) : [],
      pty: !input.prompt,
      stdin: input.prompt ? 'ignore' : 'pipe',
      cwd: input.cwd
    });
    return session;
  }

  async resumeSession(session: Session): Promise<void> {
    if (this.launcher.has(session.id)) return;
    const command = await requireCommand({ envVar: 'CODEX_CMD', names: ['codex'] }, this.label);
    await this.launcher.launch({
      appId: this.appId,
      sessionId: session.id,
      command,
      args: session.nativeId ? ['resume', session.nativeId] : ['resume', '--last'],
      cwd: session.cwd
    });
  }

  async sendPrompt(session: Session, prompt: string): Promise<void> {
    const command = await requireCommand({ envVar: 'CODEX_CMD', names: ['codex'] }, this.label);
    this.launcher.stop(session.id);
    await this.launcher.launch({
      appId: this.appId,
      sessionId: session.id,
      command,
      args: session.nativeId ? codexExecResumeArgs(session.nativeId, prompt) : codexExecArgs(prompt),
      cwd: session.cwd,
      pty: false,
      stdin: 'ignore'
    });
  }

  async stopSession(session: Session): Promise<void> {
    this.launcher.stop(session.id);
  }

  async parseHistoricalLogs(): Promise<Session[]> {
    const indexPath = join(homedir(), '.codex', 'session_index.jsonl');
    const indexRows = await readJsonlTail(indexPath, 10_000);
    const titles = new Map<string, string>();
    for (const row of indexRows) {
      const record = row as Record<string, unknown>;
      const id = String(record.id ?? '');
      const title = cleanTitle(String(record.thread_name ?? record.title ?? ''));
      if (id && title) titles.set(id, title);
    }
    const logUsage = await this.readSqliteLogUsage();
    const files = [
      ...(await listFilesRecursive(join(homedir(), '.codex', 'sessions'), '.jsonl')),
      ...(await listFilesRecursive(join(homedir(), '.codex', 'archived_sessions'), '.jsonl'))
    ];
    const sessions = new Map<string, Session>();
    for (const file of files) {
      const session = await this.parseSessionFile(file.path, file.mtime, titles, logUsage);
      if (!session) continue;
      const current = sessions.get(session.id);
      if (!current || Date.parse(session.updatedAt) > Date.parse(current.updatedAt)) sessions.set(session.id, session);
    }
    return [...sessions.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async readSessionHistory(session: Session): Promise<TerminalFrame[]> {
    const file = await this.findSessionHistoryFile(session.nativeId ?? session.id);
    if (!file) return [];
    const content = await readFile(file, 'utf8');
    const frames: Array<TerminalFrame | undefined> = [];
    for (const line of content.split('\n')) {
      const row = parseJsonLine(line) as Record<string, unknown> | undefined;
      if (!row) continue;
      const timestamp = typeof row.timestamp === 'string' ? row.timestamp : session.updatedAt;
      const payload = (row.payload && typeof row.payload === 'object' ? row.payload : row) as Record<string, unknown>;
      for (const message of codexHistoryMessages(payload)) {
        frames.push(historyFrame(session, message.role, message.text, timestamp));
      }
    }
    return compactHistoryFrames(frames);
  }

  async getTokenUsage(scope: TimeScope): Promise<TokenUsage[]> {
    const sessions = await this.listSessions();
    const inputTokens = sessions.reduce((sum, session) => sum + session.inputTokens, 0);
    const outputTokens = sessions.reduce((sum, session) => sum + session.outputTokens, 0);
    return [{ appId: this.appId, scope, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }];
  }

  async deleteSessionLogs(session: Session): Promise<DeleteSessionLogsResult> {
    const file = await this.findSessionHistoryFile(session.nativeId ?? session.id);
    if (!file) return emptyDeleteResult();
    await unlink(file);
    return { deletedFiles: [file], modifiedFiles: [], skippedFiles: [] };
  }

  private async findSessionHistoryFile(id: string): Promise<string | undefined> {
    if (!id) return undefined;
    const files = [
      ...(await listFilesRecursive(join(homedir(), '.codex', 'sessions'), '.jsonl')),
      ...(await listFilesRecursive(join(homedir(), '.codex', 'archived_sessions'), '.jsonl'))
    ];
    return files.find((file) => basename(file.path, '.jsonl') === id || file.path.includes(`${id}.jsonl`))?.path;
  }

  private async readSqliteLogUsage(): Promise<Map<string, { inputTokens: number; outputTokens: number }>> {
    const path = join(homedir(), '.codex', 'logs_2.sqlite');
    if (!(await exists(path))) return new Map();
    const usage = new Map<string, { inputTokens: number; outputTokens: number }>();
    const seenTurns = new Set<string>();
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path);
      const rows = db
        .prepare(
          `
          SELECT thread_id, feedback_log_body
          FROM logs
          WHERE thread_id IS NOT NULL AND feedback_log_body IS NOT NULL
          ORDER BY ts DESC, ts_nanos DESC
          LIMIT 5000
        `
        )
        .all() as Array<{ thread_id: string; feedback_log_body: string }>;
      for (const row of rows) {
        for (const delta of codexTurnUsage(row.feedback_log_body)) {
          const key = `${row.thread_id}:${delta.turnId}`;
          if (seenTurns.has(key)) continue;
          seenTurns.add(key);
          const current = usage.get(row.thread_id) ?? { inputTokens: 0, outputTokens: 0 };
          current.inputTokens += delta.inputTokens;
          current.outputTokens += delta.outputTokens;
          usage.set(row.thread_id, current);
        }
      }
    } catch {
      return usage;
    } finally {
      db?.close();
    }
    return usage;
  }

  private async parseSessionFile(
    path: string,
    mtime: Date,
    titles: Map<string, string>,
    logUsage: Map<string, { inputTokens: number; outputTokens: number }>
  ): Promise<Session | undefined> {
    let id = codexIdFromPath(path);
    let cwd: string | undefined;
    let model: string | undefined;
    let firstUser = '';
    let createdAt = '';
    let updatedAt = '';
    let usage = { inputTokens: 0, outputTokens: 0 };
    let status: TaskStatus = 'completed';
    let live = false;

    const content = await readFile(path, 'utf8');
    for (const line of content.split('\n')) {
      const row = parseJsonLine(line) as Record<string, unknown> | undefined;
      if (!row) continue;
      const timestamp = typeof row.timestamp === 'string' ? row.timestamp : undefined;
      if (timestamp) {
        createdAt ||= timestamp;
        updatedAt = timestamp;
      }
      const payload = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>;
      if (row.type === 'session_meta') {
        if (typeof payload.id === 'string') id = payload.id;
        if (typeof payload.cwd === 'string') cwd = payload.cwd;
      }
      if (row.type === 'turn_context') {
        if (typeof payload.cwd === 'string') cwd = payload.cwd;
        if (typeof payload.model === 'string') model = payload.model;
      }
      if (!firstUser) firstUser = extractCodexUserText(payload);
      const tokenUsage = codexTokenUsage(payload);
      if (tokenUsage.inputTokens + tokenUsage.outputTokens > 0) usage = tokenUsage;
      const lifecycle = codexLifecycleState(payload);
      if (lifecycle) {
        status = lifecycle.status;
        live = lifecycle.live;
      }
    }

    if (!id) return undefined;
    const sqliteUsage = logUsage.get(id);
    if (sqliteUsage && usage.inputTokens + usage.outputTokens === 0) usage = sqliteUsage;
    const title = titles.get(id) ?? cleanTitle(firstUser) ?? basename(id);
    const createdIso = validIso(createdAt) ?? mtime.toISOString();
    const updatedIso = validIso(updatedAt) ?? mtime.toISOString();
    if (live && Date.now() - Date.parse(updatedIso) > CODEX_STALE_LIVE_MS) {
      status = 'completed';
      live = false;
    }
    return {
      id,
      appId: this.appId,
      nativeId: id,
      title,
      cwd,
      status,
      model: model ?? this.defaultModel,
      createdAt: createdIso,
      updatedAt: updatedIso,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      live
    };
  }
}

function emptyDeleteResult(): DeleteSessionLogsResult {
  return { deletedFiles: [], modifiedFiles: [], skippedFiles: [] };
}

function codexIdFromPath(path: string): string {
  return basename(path, '.jsonl').match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)?.[0] ?? '';
}

function codexTokenUsage(payload: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  if (payload.type !== 'token_count') return { inputTokens: 0, outputTokens: 0 };
  const info = payload.info as Record<string, unknown> | undefined;
  const total = info?.total_token_usage as Record<string, unknown> | undefined;
  return {
    inputTokens: safeToken(total?.input_tokens),
    outputTokens: safeToken(total?.output_tokens)
  };
}

function codexLifecycleState(payload: Record<string, unknown>): { status: TaskStatus; live: boolean } | undefined {
  const type = String(payload.type ?? '');
  if (type === 'task_started') return { status: 'running', live: true };
  if (type === 'task_complete') return { status: 'completed', live: false };
  if (type === 'turn_aborted' || type === 'task_failed' || type === 'task_cancelled' || type === 'task_interrupted') {
    return { status: 'interrupted', live: false };
  }
  return undefined;
}

function extractCodexUserText(payload: Record<string, unknown>): string {
  if (payload.type === 'user_message' && typeof payload.message === 'string') return cleanTitle(payload.message) ?? '';
  if (payload.type !== 'message' || payload.role !== 'user') return '';
  const content = payload.content;
  if (typeof content === 'string') return cleanTitle(content) ?? '';
  if (Array.isArray(content)) {
    const item = content.find((part) => part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string') as
      | Record<string, unknown>
      | undefined;
    return cleanTitle(String(item?.text ?? '')) ?? '';
  }
  return '';
}

function codexHistoryMessages(payload: Record<string, unknown>): Array<{ role: 'user' | 'assistant' | 'tool' | 'system'; text: string }> {
  const type = String(payload.type ?? '');
  if (type === 'user_message') return [{ role: 'user', text: String(payload.message ?? '') }];
  if (type === 'agent_message') return [{ role: 'assistant', text: textFromContent(payload.message ?? payload.text ?? payload.content) }];
  if (type === 'message') {
    const role = String(payload.role ?? 'assistant').includes('user') ? 'user' : 'assistant';
    return [{ role, text: textFromContent(payload.content ?? payload.message) }];
  }
  if (type === 'response_item' && payload.item && typeof payload.item === 'object') {
    return codexHistoryMessages(payload.item as Record<string, unknown>);
  }
  if (type === 'function_call' || type === 'tool_call') {
    const name = String(payload.name ?? payload.command ?? payload.call_id ?? '工具调用');
    const input = textFromContent(payload.arguments ?? payload.input);
    return [{ role: 'tool', text: input ? `${name}\n${input}` : name }];
  }
  if (type === 'function_call_output' || type === 'tool_result') return [{ role: 'tool', text: textFromContent(payload.output ?? payload.content) }];
  if (type === 'exec_command') return [{ role: 'tool', text: textFromContent(payload.command ?? payload.cmd) }];
  return [];
}

function cleanTitle(value: string): string | undefined {
  const line = value
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, ' ')
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.slice(0, 96);
}

function validIso(value: string): string | undefined {
  return Number.isNaN(Date.parse(value)) ? undefined : new Date(value).toISOString();
}

function safeToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function codexTurnUsage(text: string): Array<{ turnId: string; inputTokens: number; outputTokens: number }> {
  const results = [];
  const pattern =
    /turn\.id=([^\s}]+)[\s\S]*?codex\.turn\.token_usage\.input_tokens=(\d+)[\s\S]*?codex\.turn\.token_usage\.output_tokens=(\d+)/g;
  for (const match of text.matchAll(pattern)) {
    results.push({
      turnId: match[1],
      inputTokens: Number(match[2]),
      outputTokens: Number(match[3])
    });
  }
  return results;
}

function codexExecArgs(prompt: string): string[] {
  return ['exec', '--json', '--skip-git-repo-check', prompt];
}

function codexExecResumeArgs(sessionId: string, prompt: string): string[] {
  return ['exec', 'resume', '--json', '--skip-git-repo-check', sessionId, prompt];
}
