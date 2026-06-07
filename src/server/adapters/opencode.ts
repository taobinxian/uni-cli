import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Adapter, AdapterDeps } from './base.js';
import { exists } from './fs-utils.js';
import { compactHistoryFrames, historyFrame, textFromContent } from './history.js';
import type { AdapterStatus, AppId, DeleteSessionLogsResult, Session, StartSessionInput, TerminalFrame, TimeScope, TokenUsage } from '../../shared/types.js';

type OpenCodeLikeAppId = Extract<AppId, 'opencode' | 'oh-my-pi'>;

interface OpenCodeLikeConfig {
  appId: OpenCodeLikeAppId;
  label: string;
  color: string;
  defaultModel: string;
  commandEnv: string;
  commandCandidates: string[];
  dbEnv: string;
  dbCandidates: string[];
  missingMessage: string;
  notConfiguredWhenMissing?: boolean;
}

interface OpenCodeSessionRow {
  id: string;
  title?: string | null;
  directory?: string | null;
  time_created?: number | string | null;
  time_updated?: number | string | null;
  agent?: string | null;
  model?: string | null;
  tokens_input?: number | null;
  tokens_output?: number | null;
  tokens_reasoning?: number | null;
  tokens_cache_read?: number | null;
  tokens_cache_write?: number | null;
}

interface OpenCodeMessageRow {
  id: string;
  time_created?: number | string | null;
  data: string;
}

interface OpenCodePartRow {
  message_id: string;
  time_created?: number | string | null;
  data: string;
}

class OpenCodeLikeAdapter implements Adapter {
  appId: OpenCodeLikeAppId;
  label: string;
  color: string;
  defaultModel: string;
  private command: string;
  private launcher: AdapterDeps['launcher'];
  private config: OpenCodeLikeConfig;

  constructor(config: OpenCodeLikeConfig, deps: AdapterDeps) {
    this.config = config;
    this.appId = config.appId;
    this.label = config.label;
    this.color = config.color;
    this.defaultModel = config.defaultModel;
    this.command = process.env[config.commandEnv] ?? config.commandCandidates[0];
    this.launcher = deps.launcher;
  }

  async detect(): Promise<AdapterStatus> {
    const command = await this.resolveCommand();
    const commandOk = Boolean(command && (await executableCommand(command)));
    const sessions = await this.listSessions();
    const status = commandOk ? 'connected' : this.config.notConfiguredWhenMissing && !process.env[this.config.commandEnv] ? 'not_configured' : 'missing';
    const dbPath = await this.existingDbPath();
    const message = commandOk
      ? dbPath
        ? `${this.label} CLI 可用，已读取本地会话库`
        : `${this.label} CLI 可用，暂未发现历史会话库`
      : this.config.missingMessage;
    return {
      appId: this.appId,
      label: this.label,
      command: command ?? this.command,
      status,
      message,
      sessions: sessions.length,
      tasks: sessions.length
    };
  }

  async listSessions(): Promise<Session[]> {
    return this.parseHistoricalLogs();
  }

  async startSession(input: StartSessionInput, sessionId = `${this.appId}-${randomUUID()}`): Promise<Session> {
    const command = await this.requireCommand();
    const timestamp = new Date().toISOString();
    const session: Session = {
      id: sessionId,
      appId: this.appId,
      title: input.title ?? input.prompt?.slice(0, 48) ?? `${this.label} session`,
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
      args: input.prompt ? runArgs(input.prompt, { cwd: input.cwd }) : [],
      pty: !input.prompt,
      stdin: input.prompt ? 'ignore' : 'pipe',
      cwd: input.cwd
    });
    return session;
  }

  async resumeSession(session: Session): Promise<void> {
    if (this.launcher.has(session.id)) return;
    const command = await this.requireCommand();
    const nativeId = nativeSessionId(session, this.appId);
    await this.launcher.launch({
      appId: this.appId,
      sessionId: session.id,
      command,
      args: nativeId ? ['--session', nativeId] : ['--continue'],
      cwd: session.cwd
    });
  }

  async sendPrompt(session: Session, prompt: string): Promise<void> {
    const command = await this.requireCommand();
    this.launcher.stop(session.id);
    const nativeId = nativeSessionId(session, this.appId);
    await this.launcher.launch({
      appId: this.appId,
      sessionId: session.id,
      command,
      args: runArgs(prompt, { sessionId: nativeId, cwd: session.cwd }),
      cwd: session.cwd,
      pty: false,
      stdin: 'ignore'
    });
  }

  async stopSession(session: Session): Promise<void> {
    this.launcher.stop(session.id);
  }

  async parseHistoricalLogs(): Promise<Session[]> {
    const dbPath = await this.existingDbPath();
    if (!dbPath) return [];
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath);
      const rows = db
        .prepare(
          `
          SELECT id, title, directory, time_created, time_updated, agent, model,
                 tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
          FROM session
          ORDER BY time_updated DESC
          LIMIT 3000
        `
        )
        .all() as unknown as OpenCodeSessionRow[];
      return rows.map((row) => this.sessionFromRow(row)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  async readSessionHistory(session: Session): Promise<TerminalFrame[]> {
    const dbPath = await this.existingDbPath();
    const nativeId = nativeSessionId(session, this.appId);
    if (!dbPath || !nativeId) return [];
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath);
      const messages = db
        .prepare(
          `
          SELECT id, time_created, data
          FROM message
          WHERE session_id = ?
          ORDER BY time_created ASC
        `
        )
        .all(nativeId) as unknown as OpenCodeMessageRow[];
      const parts = db
        .prepare(
          `
          SELECT message_id, time_created, data
          FROM part
          WHERE session_id = ?
          ORDER BY time_created ASC
        `
        )
        .all(nativeId) as unknown as OpenCodePartRow[];
      return this.historyFromRows(session, messages, parts);
    } catch {
      return [];
    } finally {
      db?.close();
    }
  }

  async getTokenUsage(scope: TimeScope): Promise<TokenUsage[]> {
    const sessions = await this.listSessions();
    const inputTokens = sessions.reduce((sum, session) => sum + session.inputTokens, 0);
    const outputTokens = sessions.reduce((sum, session) => sum + session.outputTokens, 0);
    return [{ appId: this.appId, scope, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }];
  }

  async deleteSessionLogs(session: Session): Promise<DeleteSessionLogsResult> {
    const dbPath = await this.existingDbPath();
    const nativeId = nativeSessionId(session, this.appId);
    if (!dbPath || !nativeId) return emptyDeleteResult();
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath);
      const changed = deleteOpenCodeSessionRows(db, nativeId);
      return changed ? { deletedFiles: [], modifiedFiles: [dbPath], skippedFiles: [] } : emptyDeleteResult();
    } catch {
      return emptyDeleteResult();
    } finally {
      db?.close();
    }
  }

  private sessionFromRow(row: OpenCodeSessionRow): Session {
    const nativeId = String(row.id);
    const inputTokens = safeToken(row.tokens_input) + safeToken(row.tokens_cache_read) + safeToken(row.tokens_cache_write);
    const outputTokens = safeToken(row.tokens_output) + safeToken(row.tokens_reasoning);
    const createdAt = timestampIso(row.time_created) ?? new Date().toISOString();
    const updatedAt = timestampIso(row.time_updated) ?? createdAt;
    return {
      id: `${this.appId}-${nativeId}`,
      appId: this.appId,
      nativeId,
      title: cleanTitle(row.title) || `${this.label} ${shortId(nativeId)}`,
      cwd: stringValue(row.directory),
      status: 'completed',
      model: modelLabel(row.model, row.agent) ?? this.defaultModel,
      createdAt,
      updatedAt,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      live: false
    };
  }

  private historyFromRows(session: Session, messages: OpenCodeMessageRow[], parts: OpenCodePartRow[]): TerminalFrame[] {
    const partsByMessage = new Map<string, OpenCodePartRow[]>();
    for (const part of parts) {
      const current = partsByMessage.get(part.message_id) ?? [];
      current.push(part);
      partsByMessage.set(part.message_id, current);
    }

    const frames: Array<TerminalFrame | undefined> = [];
    for (const message of messages) {
      const messageData = parseJsonRecord(message.data);
      const role = openCodeRole(messageData);
      const messageTime = timestampIso(messageData.time && typeof messageData.time === 'object' ? (messageData.time as Record<string, unknown>).created : undefined) ?? timestampIso(message.time_created) ?? session.updatedAt;
      const messageParts = partsByMessage.get(message.id) ?? [];
      let emittedText = false;

      for (const part of messageParts) {
        const partData = parseJsonRecord(part.data);
        const partTime = timestampIso(partData.time && typeof partData.time === 'object' ? (partData.time as Record<string, unknown>).start : undefined) ?? timestampIso(part.time_created) ?? messageTime;
        const partType = String(partData.type ?? '').toLowerCase();
        if (partType === 'tool') {
          frames.push(historyFrame(session, 'tool', openCodeToolText(partData), partTime));
          continue;
        }
        if (partType === 'text') {
          const text = textFromContent(partData.text ?? partData.content);
          if (text && role) {
            frames.push(historyFrame(session, role, text, partTime));
            emittedText = true;
          }
        }
      }

      if (!emittedText && role) {
        const fallbackText = textFromContent(messageData.text ?? messageData.content ?? messageData.message ?? messageData.summary);
        if (fallbackText) frames.push(historyFrame(session, role, fallbackText, messageTime));
      }
    }
    return compactHistoryFrames(frames);
  }

  private async requireCommand(): Promise<string> {
    const command = await this.resolveCommand();
    if (!command || !(await executableCommand(command))) throw new Error(`${this.label} CLI is not configured`);
    return command;
  }

  private async resolveCommand(): Promise<string | undefined> {
    const candidates = [process.env[this.config.commandEnv], this.command, ...this.config.commandCandidates].filter(Boolean) as string[];
    for (const candidate of candidates) {
      if (await executableCommand(candidate)) return candidate;
    }
    return candidates[0];
  }

  private async existingDbPath(): Promise<string | undefined> {
    const candidates = [process.env[this.config.dbEnv], ...this.config.dbCandidates].filter(Boolean) as string[];
    for (const candidate of candidates) {
      if (await exists(candidate)) return candidate;
    }
    return undefined;
  }
}

export class OpenCodeAdapter extends OpenCodeLikeAdapter {
  constructor(deps: AdapterDeps) {
    super(
      {
        appId: 'opencode',
        label: 'OpenCode',
        color: '#0284c7',
        defaultModel: 'opencode',
        commandEnv: 'OPENCODE_CMD',
        commandCandidates: [join(homedir(), '.opencode', 'bin', 'opencode'), '/opt/homebrew/bin/opencode', '/usr/local/bin/opencode', 'opencode'],
        dbEnv: 'OPENCODE_DB',
        dbCandidates: [join(homedir(), '.local', 'share', 'opencode', 'opencode.db')],
        missingMessage: '未找到 OpenCode CLI，可设置 OPENCODE_CMD'
      },
      deps
    );
  }
}

export class OhMyPiAdapter extends OpenCodeLikeAdapter {
  constructor(deps: AdapterDeps) {
    super(
      {
        appId: 'oh-my-pi',
        label: 'Oh My Pi',
        color: '#7c3aed',
        defaultModel: 'oh-my-pi',
        commandEnv: 'OH_MY_PI_CMD',
        commandCandidates: ['oh-my-pi', 'ompi', 'pi'],
        dbEnv: 'OH_MY_PI_DB',
        dbCandidates: [
          join(homedir(), '.local', 'share', 'oh-my-pi', 'opencode.db'),
          join(homedir(), '.local', 'share', 'oh-my-pi', 'oh-my-pi.db'),
          join(homedir(), '.oh-my-pi', 'opencode.db'),
          join(homedir(), '.oh-my-pi', 'oh-my-pi.db')
        ],
        missingMessage: '未配置 Oh My Pi CLI，可设置 OH_MY_PI_CMD 和 OH_MY_PI_DB',
        notConfiguredWhenMissing: true
      },
      deps
    );
  }
}

function runArgs(prompt: string, options: { sessionId?: string; cwd?: string } = {}): string[] {
  return [
    'run',
    '--format',
    'json',
    ...(options.sessionId ? ['--session', options.sessionId] : []),
    ...(options.cwd ? ['--dir', options.cwd] : []),
    prompt
  ];
}

function nativeSessionId(session: Session, appId: OpenCodeLikeAppId): string {
  if (session.nativeId) return session.nativeId;
  const prefix = `${appId}-`;
  return session.id.startsWith(prefix) ? session.id.slice(prefix.length) : session.id;
}

async function executableCommand(command: string): Promise<boolean> {
  if (command.includes('/')) return executablePath(command);
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    if (await executablePath(join(dir, command))) return true;
  }
  return false;
}

async function executablePath(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function deleteOpenCodeSessionRows(db: DatabaseSync, sessionId: string): boolean {
  db.exec('BEGIN');
  let changes = 0;
  try {
    changes += runDelete(db, 'part', sessionId);
    changes += runDelete(db, 'message', sessionId);
    changes += runDelete(db, 'session_message', sessionId);
    changes += runDelete(db, 'todo', sessionId);
    changes += runDelete(db, 'session', sessionId, 'id');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return changes > 0;
}

function runDelete(db: DatabaseSync, table: string, value: string, column = 'session_id'): number {
  if (!tableExists(db, table)) return 0;
  const result = db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(value) as { changes?: number };
  return Number(result.changes ?? 0);
}

function tableExists(db: DatabaseSync, table: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1").get(table);
  return Boolean(row);
}

function openCodeRole(data: Record<string, unknown>): 'user' | 'assistant' | 'system' | undefined {
  const role = String(data.role ?? '').toLowerCase();
  if (role === 'user' || role.includes('human')) return 'user';
  if (role === 'assistant' || role.includes('agent') || role.includes('model')) return 'assistant';
  if (role === 'system') return 'system';
  return undefined;
}

function openCodeToolText(data: Record<string, unknown>): string {
  const state = data.state && typeof data.state === 'object' ? (data.state as Record<string, unknown>) : {};
  const title = stringValue(state.title) || stringValue(data.tool) || '工具调用';
  const status = stringValue(state.status);
  const input = textFromContent(state.input ?? data.input);
  const output = textFromContent(state.output ?? data.output);
  const lines = [`${title}${status ? ` · ${status}` : ''}`];
  if (input) lines.push(`Input:\n${input}`);
  if (output) lines.push(`Output:\n${output}`);
  return lines.join('\n');
}

function modelLabel(modelValue: unknown, agentValue: unknown): string | undefined {
  const model = typeof modelValue === 'string' ? parseJsonRecord(modelValue) : modelValue && typeof modelValue === 'object' ? (modelValue as Record<string, unknown>) : {};
  const provider = stringValue(model.providerID ?? model.provider ?? model.provider_id);
  const modelId = stringValue(model.modelID ?? model.modelId ?? model.id ?? model.model);
  const variant = stringValue(model.variant);
  const agent = stringValue(agentValue);
  const base = provider && modelId ? `${provider}/${modelId}` : modelId || provider || agent;
  if (!base) return undefined;
  return variant ? `${base} · ${variant}` : base;
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function timestampIso(value: unknown): string | undefined {
  const raw = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
  if (!Number.isFinite(raw) || raw <= 0) return undefined;
  const millis = raw > 10_000_000_000 ? raw : raw * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function cleanTitle(value: unknown): string {
  if (typeof value !== 'string') return '';
  const line = value
    .split('\n')
    .map((part) => part.trim())
    .find(Boolean);
  return line ? line.slice(0, 96) : '';
}

function shortId(id: string): string {
  return id.replace(/^ses_/, '').slice(0, 6);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeToken(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
}

function emptyDeleteResult(): DeleteSessionLogsResult {
  return { deletedFiles: [], modifiedFiles: [], skippedFiles: [] };
}
