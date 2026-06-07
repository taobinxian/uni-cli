import { randomUUID } from 'node:crypto';
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Adapter, AdapterDeps } from './base.js';
import { requireCommand as requireDiscoveredCommand, resolveCommand as resolveDiscoveredCommand } from './command-discovery.js';
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
  commandNames: string[];
  commandCandidates?: string[];
  dbEnv: string;
  dbCandidates: string[];
  missingMessage: string;
  notConfiguredWhenMissing?: boolean;
  sessionWhereSql?: string;
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
  private commandHint: string;
  private launcher: AdapterDeps['launcher'];
  private config: OpenCodeLikeConfig;

  constructor(config: OpenCodeLikeConfig, deps: AdapterDeps) {
    this.config = config;
    this.appId = config.appId;
    this.label = config.label;
    this.color = config.color;
    this.defaultModel = config.defaultModel;
    this.commandHint = process.env[config.commandEnv] ?? config.commandNames[0];
    this.launcher = deps.launcher;
  }

  async detect(): Promise<AdapterStatus> {
    const command = await this.resolveCommand();
    const sessions = await this.listSessions();
    const status = command ? 'connected' : this.config.notConfiguredWhenMissing && !process.env[this.config.commandEnv] ? 'not_configured' : 'missing';
    const dbPath = await this.existingDbPath();
    const message = command
      ? dbPath
        ? `${this.label} CLI 可用，已读取本地会话库`
        : `${this.label} CLI 可用，暂未发现历史会话库`
      : this.config.missingMessage;
    return {
      appId: this.appId,
      label: this.label,
      command: command ?? this.commandHint,
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
      const whereClause = this.config.sessionWhereSql ? `WHERE ${this.config.sessionWhereSql}` : '';
      const rows = db
        .prepare(
          `
          SELECT id, title, directory, time_created, time_updated, agent, model,
                 tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write
          FROM session
          ${whereClause}
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
    return requireDiscoveredCommand(
      { envVar: this.config.commandEnv, names: this.config.commandNames, candidates: this.config.commandCandidates },
      this.label
    );
  }

  private async resolveCommand(): Promise<string | undefined> {
    return resolveDiscoveredCommand({
      envVar: this.config.commandEnv,
      names: this.config.commandNames,
      candidates: this.config.commandCandidates
    });
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
        commandNames: ['opencode'],
        commandCandidates: [join(homedir(), '.opencode', 'bin', 'opencode')],
        dbEnv: 'OPENCODE_DB',
        dbCandidates: [join(homedir(), '.local', 'share', 'opencode', 'opencode.db')],
        missingMessage: '未找到 OpenCode CLI，可设置 OPENCODE_CMD',
        sessionWhereSql: 'agent IS NULL'
      },
      deps
    );
  }
}

export class OhMyPiAdapter implements Adapter {
  appId: Extract<AppId, 'oh-my-pi'> = 'oh-my-pi';
  label = 'Oh My Pi';
  color = '#7c3aed';
  defaultModel = 'oh-my-pi';
  private commandHint = process.env.OH_MY_PI_CMD ?? 'omp';
  private sessionRoot = process.env.OH_MY_PI_SESSION_DIR ?? join(homedir(), '.omp', 'agent', 'sessions');
  private launcher: AdapterDeps['launcher'];

  constructor(deps: AdapterDeps) {
    this.launcher = deps.launcher;
  }

  async detect(): Promise<AdapterStatus> {
    const command = await this.resolveOmpCommand();
    const sessions = await this.listSessions();
    const hasSessionRoot = await exists(this.sessionRoot);
    return {
      appId: this.appId,
      label: this.label,
      command: command ?? this.commandHint,
      status: command ? 'connected' : !process.env.OH_MY_PI_CMD ? 'not_configured' : 'missing',
      message: command
        ? hasSessionRoot
          ? `Oh My Pi CLI 可用，已读取 ${this.sessionRoot}`
          : `Oh My Pi CLI 可用，暂未发现会话目录 ${this.sessionRoot}`
        : '未找到 Oh My Pi CLI，可设置 OH_MY_PI_CMD 或将 omp 加入 PATH',
      sessions: sessions.length,
      tasks: sessions.length
    };
  }

  async listSessions(): Promise<Session[]> {
    return this.parseHistoricalLogs();
  }

  async startSession(input: StartSessionInput, sessionId = `oh-my-pi-${randomUUID()}`): Promise<Session> {
    const command = await this.requireOmpCommand();
    const timestamp = new Date().toISOString();
    const session: Session = {
      id: sessionId,
      appId: this.appId,
      title: input.title ?? input.prompt?.slice(0, 48) ?? 'Oh My Pi session',
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
      args: input.prompt ? ompPrintArgs(input.prompt, { sessionRoot: this.sessionRoot }) : ompSessionRootArgs(this.sessionRoot),
      pty: !input.prompt,
      stdin: input.prompt ? 'ignore' : 'pipe',
      cwd: input.cwd
    });
    return session;
  }

  async resumeSession(session: Session): Promise<void> {
    if (this.launcher.has(session.id)) return;
    const command = await this.requireOmpCommand();
    const nativeId = ompNativeSessionId(session);
    await this.launcher.launch({
      appId: this.appId,
      sessionId: session.id,
      command,
      args: [...ompSessionRootArgs(this.sessionRoot), ...(nativeId ? ['--resume', nativeId] : ['--continue'])],
      cwd: session.cwd
    });
  }

  async sendPrompt(session: Session, prompt: string): Promise<void> {
    const command = await this.requireOmpCommand();
    this.launcher.stop(session.id);
    const nativeId = ompNativeSessionId(session);
    await this.launcher.launch({
      appId: this.appId,
      sessionId: session.id,
      command,
      args: ompPrintArgs(prompt, { sessionId: nativeId, sessionRoot: this.sessionRoot }),
      cwd: session.cwd,
      pty: false,
      stdin: 'ignore'
    });
  }

  async stopSession(session: Session): Promise<void> {
    this.launcher.stop(session.id);
  }

  async parseHistoricalLogs(): Promise<Session[]> {
    const files = await findOmpSessionFiles(this.sessionRoot);
    const parsed = await Promise.all(files.map((file) => parseOmpSessionSummary(file, this.appId, this.defaultModel)));
    return parsed
      .filter((item): item is Session => Boolean(item))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 3000);
  }

  async readSessionHistory(session: Session): Promise<TerminalFrame[]> {
    const filePath = await this.findSessionFile(session);
    if (!filePath) return [];
    return parseOmpSessionHistory(filePath, session);
  }

  async getTokenUsage(scope: TimeScope): Promise<TokenUsage[]> {
    const sessions = await this.listSessions();
    const inputTokens = sessions.reduce((sum, session) => sum + session.inputTokens, 0);
    const outputTokens = sessions.reduce((sum, session) => sum + session.outputTokens, 0);
    return [{ appId: this.appId, scope, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }];
  }

  async deleteSessionLogs(session: Session): Promise<DeleteSessionLogsResult> {
    const filePath = await this.findSessionFile(session);
    if (!filePath) return emptyDeleteResult();
    const deletedFiles: string[] = [];
    try {
      await rm(filePath, { force: true });
      deletedFiles.push(filePath);
    } catch {
      // Keep deleting the sidecar logs if possible.
    }
    const sidecarDir = filePath.replace(/\.jsonl$/, '');
    if (await exists(sidecarDir)) {
      try {
        await rm(sidecarDir, { recursive: true, force: true });
        deletedFiles.push(sidecarDir);
      } catch {
        // Deleting the JSONL already removes the session from OMP history.
      }
    }
    return deletedFiles.length ? { deletedFiles, modifiedFiles: [], skippedFiles: [] } : emptyDeleteResult();
  }

  private async requireOmpCommand(): Promise<string> {
    return requireDiscoveredCommand({ envVar: 'OH_MY_PI_CMD', names: ['omp', 'oh-my-pi', 'oh-my-opencode'] }, this.label);
  }

  private async resolveOmpCommand(): Promise<string | undefined> {
    return resolveDiscoveredCommand({ envVar: 'OH_MY_PI_CMD', names: ['omp', 'oh-my-pi', 'oh-my-opencode'] });
  }

  private async findSessionFile(session: Session): Promise<string | undefined> {
    const nativeId = ompNativeSessionId(session);
    const files = await findOmpSessionFiles(this.sessionRoot);
    if (nativeId) {
      const direct = files.find((file) => basename(file).includes(nativeId));
      if (direct) return direct;
    }
    for (const file of files) {
      const summary = await parseOmpSessionSummary(file, this.appId, this.defaultModel);
      if (summary?.id === session.id || summary?.nativeId === nativeId) return file;
    }
    return undefined;
  }
}

async function findOmpSessionFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 8) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl') && !entry.name.startsWith('.')) {
        files.push(fullPath);
      }
    }
  }
  await visit(root, 0);
  return files;
}

async function parseOmpSessionSummary(filePath: string, appId: Extract<AppId, 'oh-my-pi'>, defaultModel: string): Promise<Session | undefined> {
  const parsed = await readOmpJsonl(filePath);
  if (!parsed.length) return undefined;
  const meta = parsed.find((row) => row.type === 'session') ?? {};
  const statInfo = await safeStat(filePath);
  const nativeId = stringValue(meta.id) ?? ompIdFromFilePath(filePath);
  if (!nativeId) return undefined;

  let model = defaultModel;
  let firstUserText = '';
  let updatedAt = timestampIso(meta.timestamp) ?? statInfo?.mtime.toISOString() ?? new Date().toISOString();
  let inputTokens = 0;
  let outputTokens = 0;

  for (const row of parsed) {
    const rowTime = timestampIso(row.timestamp);
    if (rowTime && Date.parse(rowTime) > Date.parse(updatedAt)) updatedAt = rowTime;
    if (row.type === 'model_change') model = stringValue(row.model) ?? model;
    const message = objectValue(row.message);
    if (!message) continue;
    const role = String(message.role ?? '').toLowerCase();
    if (!firstUserText && role === 'user') firstUserText = ompContentText(message.content);
    const usage = ompUsage(message.usage);
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
  }

  const createdAt = timestampIso(meta.timestamp) ?? statInfo?.birthtime.toISOString() ?? updatedAt;
  return {
    id: `${appId}-${nativeId}`,
    appId,
    nativeId,
    title: cleanTitle(meta.title) || cleanTitle(firstUserText) || `Oh My Pi ${shortId(nativeId)}`,
    cwd: stringValue(meta.cwd),
    status: 'completed',
    model,
    createdAt,
    updatedAt,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    live: false
  };
}

async function parseOmpSessionHistory(filePath: string, session: Session): Promise<TerminalFrame[]> {
  const parsed = await readOmpJsonl(filePath);
  const frames: Array<TerminalFrame | undefined> = [];
  for (const row of parsed) {
    const message = objectValue(row.message);
    if (!message) continue;
    const createdAt = timestampIso(row.timestamp) ?? timestampIso(message.timestamp) ?? session.updatedAt;
    const role = String(message.role ?? '').toLowerCase();
    if (role === 'user') {
      frames.push(historyFrame(session, 'user', ompContentText(message.content), createdAt));
      continue;
    }
    if (role === 'assistant') {
      frames.push(...ompAssistantFrames(session, message.content, createdAt));
      continue;
    }
    if (role === 'toolresult' || role === 'tool_result') {
      frames.push(historyFrame(session, 'tool', ompToolResultText(message), createdAt));
      continue;
    }
    if (role === 'system') {
      frames.push(historyFrame(session, 'system', ompContentText(message.content), createdAt));
    }
  }
  return compactHistoryFrames(frames);
}

async function readOmpJsonl(filePath: string): Promise<Record<string, unknown>[]> {
  try {
    const content = await readFile(filePath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => parseJsonRecord(line))
      .filter((row) => Object.keys(row).length > 0);
  } catch {
    return [];
  }
}

function ompAssistantFrames(session: Session, content: unknown, createdAt: string): Array<TerminalFrame | undefined> {
  if (!Array.isArray(content)) return [historyFrame(session, 'assistant', ompContentText(content), createdAt)];
  const frames: Array<TerminalFrame | undefined> = [];
  for (const part of content) {
    const record = objectValue(part);
    if (!record) {
      const text = textFromContent(part);
      if (text) frames.push(historyFrame(session, 'assistant', text, createdAt));
      continue;
    }
    const type = String(record.type ?? '').toLowerCase();
    if (type === 'thinking' || type === 'reasoning') {
      const thinking = textFromContent(record.thinking ?? record.text ?? record.content);
      if (thinking) frames.push(historyFrame(session, 'system', `思考/推理：${thinking}`, createdAt));
      continue;
    }
    if (type === 'toolcall' || type === 'tool_call') {
      frames.push(historyFrame(session, 'tool', ompToolCallText(record), createdAt));
      continue;
    }
    const text = textFromContent(record);
    if (text) frames.push(historyFrame(session, 'assistant', text, createdAt));
  }
  return frames.length ? frames : [historyFrame(session, 'assistant', ompContentText(content), createdAt)];
}

function ompToolCallText(record: Record<string, unknown>): string {
  const name = stringValue(record.name) ?? stringValue(record.tool) ?? '工具调用';
  const args = record.arguments ?? record.input;
  const formattedArgs = formatJsonLike(args);
  return formattedArgs ? `${name}\n${formattedArgs}` : name;
}

function ompToolResultText(message: Record<string, unknown>): string {
  const name = stringValue(message.toolName) ?? '工具结果';
  const content = ompContentText(message.content);
  const details = formatJsonLike(message.details);
  return [name, content, details].filter(Boolean).join('\n');
}

function ompContentText(content: unknown): string {
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        const record = objectValue(part);
        if (!record) return textFromContent(part);
        const type = String(record.type ?? '').toLowerCase();
        if (type === 'toolcall' || type === 'tool_call') return ompToolCallText(record);
        if (type === 'thinking' || type === 'reasoning') return textFromContent(record.thinking ?? record.text ?? record.content);
        return textFromContent(record);
      })
      .filter(Boolean)
      .join('\n');
  }
  return textFromContent(content);
}

function ompUsage(value: unknown): { inputTokens: number; outputTokens: number } {
  const usage = objectValue(value);
  if (!usage) return { inputTokens: 0, outputTokens: 0 };
  const inputTokens = safeToken(usage.input) + safeToken(usage.cacheRead) + safeToken(usage.cacheWrite);
  const rawOutputTokens = safeToken(usage.output);
  const totalTokens = safeToken(usage.totalTokens);
  return {
    inputTokens,
    outputTokens: totalTokens > inputTokens ? totalTokens - inputTokens : rawOutputTokens
  };
}

function ompPrintArgs(prompt: string, options: { sessionId?: string; sessionRoot?: string } = {}): string[] {
  return [...ompSessionRootArgs(options.sessionRoot), '-p', ...(options.sessionId ? ['--resume', options.sessionId] : []), prompt];
}

function ompSessionRootArgs(sessionRoot?: string): string[] {
  return sessionRoot ? ['--session-dir', sessionRoot] : [];
}

function ompNativeSessionId(session: Session): string {
  if (session.nativeId) return session.nativeId;
  const prefix = 'oh-my-pi-';
  return session.id.startsWith(prefix) ? session.id.slice(prefix.length) : session.id;
}

function ompIdFromFilePath(filePath: string): string | undefined {
  const name = basename(filePath).replace(/\.jsonl$/, '');
  const match = name.match(/_([0-9a-f]{8,}(?:-[0-9a-f]{4,})*)$/i);
  return match?.[1] ?? (name || undefined);
}

async function safeStat(filePath: string) {
  try {
    return await stat(filePath);
  } catch {
    return undefined;
  }
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function formatJsonLike(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
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

function nativeSessionId(session: Session, _appId: OpenCodeLikeAppId): string | undefined {
  return session.nativeId;
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
  if (typeof value === 'string' && value.trim() && Number.isNaN(Number(value))) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
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
