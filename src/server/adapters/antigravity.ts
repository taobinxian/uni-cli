import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join, relative, sep } from 'node:path';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import type { Adapter, AdapterDeps } from './base.js';
import { requireCommand, resolveCommand } from './command-discovery.js';
import { exists, listFiles, listFilesRecursive } from './fs-utils.js';
import { compactHistoryFrames, historyFrame, textFromContent } from './history.js';
import { extractUsage, parseJsonLine, sessionFromFile } from '../../shared/parsers.js';
import type { AdapterStatus, DeleteSessionLogsResult, Session, StartSessionInput, TerminalFrame, TimeScope, TokenUsage } from '../../shared/types.js';

export class AntigravityAdapter implements Adapter {
  appId = 'antigravity' as const;
  label = 'Antigravity';
  color = '#4c6fff';
  defaultModel = 'app session';
  private commandHint = process.env.ANTIGRAVITY_CMD || 'agy';
  private logDir = process.env.ANTIGRAVITY_LOG_DIR;
  private launcher: AdapterDeps['launcher'];

  constructor(deps: AdapterDeps) {
    this.launcher = deps.launcher;
  }

  async detect(): Promise<AdapterStatus> {
    const command = await resolveCommand({ envVar: 'ANTIGRAVITY_CMD', names: ['agy', 'antigravity'] });
    const sessions = await this.listSessions();
    return {
      appId: this.appId,
      label: this.label,
      command: command ?? this.commandHint,
      status: command ? 'connected' : 'missing',
      message: command ? 'Antigravity CLI 可用' : '未找到 Antigravity CLI，可设置 ANTIGRAVITY_CMD 或将 agy 加入 PATH',
      sessions: sessions.length,
      tasks: sessions.length
    };
  }

  async listSessions(): Promise<Session[]> {
    return this.parseHistoricalLogs();
  }

  async startSession(input: StartSessionInput, sessionId = `antigravity-${randomUUID()}`): Promise<Session> {
    const command = await requireCommand({ envVar: 'ANTIGRAVITY_CMD', names: ['agy', 'antigravity'] }, this.label);
    const timestamp = new Date().toISOString();
    const session: Session = {
      id: sessionId,
      appId: this.appId,
      title: input.title ?? input.prompt?.slice(0, 48) ?? 'Antigravity session',
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
      args: input.prompt ? antigravityPrintArgs(input.prompt) : [],
      pty: !input.prompt,
      stdin: input.prompt ? 'ignore' : 'pipe',
      cwd: input.cwd
    });
    return session;
  }

  async resumeSession(session: Session): Promise<void> {
    if (this.launcher.has(session.id)) return;
    const command = await requireCommand({ envVar: 'ANTIGRAVITY_CMD', names: ['agy', 'antigravity'] }, this.label);
    await this.launcher.launch({
      appId: this.appId,
      sessionId: session.id,
      command,
      args: session.nativeId ? ['--conversation', session.nativeId] : ['--continue'],
      cwd: session.cwd
    });
  }

  async sendPrompt(session: Session, prompt: string): Promise<void> {
    const command = await requireCommand({ envVar: 'ANTIGRAVITY_CMD', names: ['agy', 'antigravity'] }, this.label);
    this.launcher.stop(session.id);
    await this.launcher.launch({
      appId: this.appId,
      sessionId: session.id,
      command,
      args: session.nativeId ? antigravityPrintArgs(prompt, ['--conversation', session.nativeId]) : antigravityPrintArgs(prompt),
      cwd: session.cwd,
      pty: false,
      stdin: 'ignore'
    });
  }

  async stopSession(session: Session): Promise<void> {
    this.launcher.stop(session.id);
  }

  async parseHistoricalLogs(): Promise<Session[]> {
    const sessions = new Map<string, Session>();
    const transcriptSessions = [
      ...(await this.parseTranscriptSessions(join(homedir(), '.gemini', 'antigravity-cli', 'brain'), 'Antigravity CLI transcript')),
      ...(await this.parseTranscriptSessions(join(homedir(), '.gemini', 'antigravity', 'brain'), 'Antigravity App transcript'))
    ];
    const transcriptById = new Map(transcriptSessions.map((session) => [session.id, session]));
    for (const session of await this.parseCliHistory(transcriptById)) sessions.set(session.id, session);
    for (const session of transcriptSessions) {
      const current = sessions.get(session.id);
      if (!current || (current.totalTokens === 0 && session.totalTokens > 0)) sessions.set(session.id, session);
    }
    const files = this.logDir ? (await listFiles(this.logDir, '.jsonl')).slice(0, 200) : [];
    for (const file of files) {
      const content = await readFile(file.path, 'utf8');
      const usage = content
        .split('\n')
        .map(parseJsonLine)
        .filter(Boolean)
        .map((row) => extractUsage(row))
        .reduce(
          (acc, next) => ({ inputTokens: acc.inputTokens + next.inputTokens, outputTokens: acc.outputTokens + next.outputTokens }),
          { inputTokens: 0, outputTokens: 0 }
        );
      const session = sessionFromFile(this.appId, basename(file.path, '.jsonl'), basename(file.path, '.jsonl'), file.mtime, usage);
      sessions.set(session.id, session);
    }
    return [...sessions.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  async getTokenUsage(scope: TimeScope): Promise<TokenUsage[]> {
    const sessions = await this.listSessions();
    const inputTokens = sessions.reduce((sum, session) => sum + session.inputTokens, 0);
    const outputTokens = sessions.reduce((sum, session) => sum + session.outputTokens, 0);
    return [{ appId: this.appId, scope, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }];
  }

  async deleteSessionLogs(session: Session): Promise<DeleteSessionLogsResult> {
    const id = session.nativeId ?? session.id;
    const deletedFiles: string[] = [];
    const modifiedFiles: string[] = [];
    const skippedFiles: string[] = [];

    for (const file of await this.findTranscriptHistoryFiles(id)) {
      await unlink(file);
      deletedFiles.push(file);
    }

    if (this.logDir) {
      const file = join(this.logDir, `${id}.jsonl`);
      if (await exists(file)) {
        await unlink(file);
        deletedFiles.push(file);
      }
    }

    const sharedHistory = await this.deleteCliHistoryRows(id);
    if (sharedHistory === 'modified') modifiedFiles.push(antigravityCliHistoryPath());
    if (sharedHistory === 'skipped') skippedFiles.push(antigravityCliHistoryPath());

    return { deletedFiles, modifiedFiles, skippedFiles };
  }

  async readSessionHistory(session: Session): Promise<TerminalFrame[]> {
    const id = session.nativeId ?? session.id;
    const transcript = await this.findTranscriptHistoryFile(id);
    if (transcript) return parseTranscriptHistoryFrames(session, await readFile(transcript, 'utf8'));

    const cliHistory = await this.readCliHistoryFrames(session, id);
    if (cliHistory.length) return cliHistory;

    if (this.logDir) {
      const file = join(this.logDir, `${id}.jsonl`);
      if (await exists(file)) return parseGenericJsonlHistoryFrames(session, await readFile(file, 'utf8'));
    }
    return [];
  }

  private async findTranscriptHistoryFile(id: string): Promise<string | undefined> {
    return (await this.findTranscriptHistoryFiles(id))[0];
  }

  private async findTranscriptHistoryFiles(id: string): Promise<string[]> {
    const roots = [join(homedir(), '.gemini', 'antigravity-cli', 'brain'), join(homedir(), '.gemini', 'antigravity', 'brain')];
    const files: string[] = [];
    for (const root of roots) {
      const candidates = [
        join(root, id, 'transcript_full.jsonl'),
        join(root, id, 'transcript.jsonl'),
        join(root, id, '.system_generated', 'logs', 'transcript_full.jsonl'),
        join(root, id, '.system_generated', 'logs', 'transcript.jsonl')
      ];
      for (const file of candidates) {
        if ((await exists(file)) && !files.includes(file)) files.push(file);
      }
    }
    return files;
  }

  private async readCliHistoryFrames(session: Session, id: string): Promise<TerminalFrame[]> {
    const path = antigravityCliHistoryPath();
    if (!(await exists(path))) return [];
    const content = await readFile(path, 'utf8');
    const frames: Array<TerminalFrame | undefined> = [];
    for (const line of content.split('\n')) {
      const row = parseJsonLine(line) as Record<string, unknown> | undefined;
      if (!row || row.conversationId !== id) continue;
      const timestamp = typeof row.timestamp === 'number' ? new Date(row.timestamp).toISOString() : session.updatedAt;
      frames.push(historyFrame(session, 'user', String(row.display ?? row.prompt ?? ''), timestamp));
    }
    return compactHistoryFrames(frames);
  }

  private async parseCliHistory(transcriptById: Map<string, Session>): Promise<Session[]> {
    const path = antigravityCliHistoryPath();
    let content = '';
    try {
      content = await readFile(path, 'utf8');
    } catch {
      return [];
    }
    const groups = new Map<
      string,
      { id: string; title: string; cwd?: string; firstTs: number; lastTs: number; turns: number }
    >();
    for (const line of content.split('\n')) {
      const row = parseJsonLine(line) as Record<string, unknown> | undefined;
      if (!row) continue;
      const timestamp = typeof row.timestamp === 'number' ? row.timestamp : Date.now();
      const id = typeof row.conversationId === 'string' ? row.conversationId : `history-${timestamp}`;
      const current = groups.get(id) ?? {
        id,
        title: cleanTitle(String(row.display ?? id)),
        cwd: typeof row.workspace === 'string' ? row.workspace : undefined,
        firstTs: timestamp,
        lastTs: timestamp,
        turns: 0
      };
      current.turns += 1;
      current.firstTs = Math.min(current.firstTs, timestamp);
      current.lastTs = Math.max(current.lastTs, timestamp);
      if (typeof row.workspace === 'string') current.cwd = row.workspace;
      groups.set(id, current);
    }
    return [...groups.values()].map((item) => ({
      ...sessionFromHistory(this.appId, this.defaultModel, item, transcriptById.get(item.id))
    }));
  }

  private async deleteCliHistoryRows(id: string): Promise<'modified' | 'missing' | 'skipped'> {
    const path = antigravityCliHistoryPath();
    if (!(await exists(path))) return 'missing';
    const content = await readFile(path, 'utf8');
    const lines = content.split('\n');
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      const row = parseJsonLine(line) as Record<string, unknown> | undefined;
      if (row?.conversationId === id) {
        removed += 1;
        continue;
      }
      kept.push(line);
    }
    if (!removed) return 'skipped';
    await writeFile(path, kept.length ? `${kept.join('\n')}\n` : '');
    return 'modified';
  }

  private async parseTranscriptSessions(root: string, model: string): Promise<Session[]> {
    const files = await listFilesRecursive(root, '.jsonl');
    const chosen = new Map<string, { path: string; mtime: Date; full: boolean }>();
    for (const file of files) {
      const name = basename(file.path);
      if (name !== 'transcript_full.jsonl' && name !== 'transcript.jsonl') continue;
      const sessionId = relative(root, file.path).split(sep)[0];
      if (!sessionId || sessionId.startsWith('..')) continue;
      const current = chosen.get(sessionId);
      const full = name === 'transcript_full.jsonl';
      if (!current || (full && !current.full) || file.mtime > current.mtime) chosen.set(sessionId, { ...file, full });
    }

    const sessions: Session[] = [];
    for (const [sessionId, file] of chosen) {
      const content = await readFile(file.path, 'utf8');
      const parsed = parseTranscript(content);
      sessions.push({
        id: sessionId,
        appId: this.appId,
        nativeId: sessionId,
        title: parsed.title || `Antigravity ${sessionId.slice(0, 8)}`,
        cwd: undefined,
        status: 'completed',
        model,
        createdAt: parsed.createdAt ?? file.mtime.toISOString(),
        updatedAt: parsed.updatedAt ?? file.mtime.toISOString(),
        inputTokens: parsed.usage.inputTokens,
        outputTokens: parsed.usage.outputTokens,
        totalTokens: parsed.usage.inputTokens + parsed.usage.outputTokens,
        live: false
      });
    }
    return sessions;
  }
}

function antigravityCliHistoryPath(): string {
  return join(homedir(), '.gemini', 'antigravity-cli', 'history.jsonl');
}

function sessionFromHistory(
  appId: 'antigravity',
  model: string,
  item: { id: string; title: string; cwd?: string; firstTs: number; lastTs: number },
  transcript?: Session
): Session {
  const createdAt = new Date(item.firstTs).toISOString();
  const updatedAt = new Date(item.lastTs).toISOString();
  const inputTokens = transcript?.inputTokens ?? 0;
  const outputTokens = transcript?.outputTokens ?? 0;
  return {
    id: item.id,
    appId,
    nativeId: item.id,
    title: item.title || transcript?.title || `Antigravity ${item.id.slice(0, 8)}`,
    cwd: item.cwd ?? transcript?.cwd,
    status: 'completed',
    model: transcript?.totalTokens ? `${model} · transcript estimate` : model,
    createdAt: earlierIso(createdAt, transcript?.createdAt),
    updatedAt: laterIso(updatedAt, transcript?.updatedAt),
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    live: false
  };
}

function parseTranscript(content: string): { title?: string; createdAt?: string; updatedAt?: string; usage: { inputTokens: number; outputTokens: number } } {
  const usage = { inputTokens: 0, outputTokens: 0 };
  let title: string | undefined;
  let createdAt: string | undefined;
  let updatedAt: string | undefined;
  for (const line of content.split('\n')) {
    const row = parseJsonLine(line) as Record<string, unknown> | undefined;
    if (!row) continue;
    const timestamp = typeof row.created_at === 'string' ? validIso(row.created_at) : undefined;
    if (timestamp) {
      createdAt ||= timestamp;
      updatedAt = timestamp;
    }
    if (!title && row.source === 'USER_EXPLICIT' && typeof row.content === 'string') {
      title = cleanTitle(extractTaggedContent(row.content, 'USER_REQUEST') || row.content);
    }
    const delta = estimateAntigravityTranscriptUsage(row);
    usage.inputTokens += delta.inputTokens;
    usage.outputTokens += delta.outputTokens;
  }
  return { title, createdAt, updatedAt, usage };
}

export function parseTranscriptHistoryFrames(session: Session, content: string): TerminalFrame[] {
  const frames: Array<TerminalFrame | undefined> = [];
  for (const line of content.split('\n')) {
    const row = parseJsonLine(line) as Record<string, unknown> | undefined;
    if (!row) continue;
    if (shouldSkipAntigravityTranscriptRow(row)) continue;
    const role = antigravityHistoryRole(row);
    const timestamp = typeof row.created_at === 'string' ? row.created_at : session.updatedAt;
    const text = antigravityTranscriptText(row, role);
    if (role && text) frames.push(historyFrame(session, role, text, timestamp));
  }
  return compactHistoryFrames(frames);
}

function parseGenericJsonlHistoryFrames(session: Session, content: string): TerminalFrame[] {
  const frames: Array<TerminalFrame | undefined> = [];
  for (const line of content.split('\n')) {
    const row = parseJsonLine(line) as Record<string, unknown> | undefined;
    if (!row) continue;
    const role = antigravityHistoryRole(row) ?? 'system';
    const timestamp = typeof row.created_at === 'string' ? row.created_at : typeof row.timestamp === 'string' ? row.timestamp : session.updatedAt;
    const text = textFromContent(row.content ?? row.message ?? row.text ?? row.output);
    if (text) frames.push(historyFrame(session, role, text, timestamp));
  }
  return compactHistoryFrames(frames);
}

function antigravityHistoryRole(row: Record<string, unknown>): 'user' | 'assistant' | 'tool' | 'system' | undefined {
  const source = String(row.source ?? '').toUpperCase();
  const type = String(row.type ?? '').toUpperCase();
  if (source.includes('USER')) return 'user';
  if (type.includes('TOOL') || type.includes('COMMAND')) return 'tool';
  if (source === 'MODEL') return 'assistant';
  if (source === 'SYSTEM') return 'system';
  return undefined;
}

function shouldSkipAntigravityTranscriptRow(row: Record<string, unknown>): boolean {
  const source = String(row.source ?? '').toUpperCase();
  const type = String(row.type ?? '').toUpperCase();
  return source === 'SYSTEM' || type === 'CONVERSATION_HISTORY' || type === 'EPHEMERAL_MESSAGE';
}

function antigravityTranscriptText(row: Record<string, unknown>, role?: 'user' | 'assistant' | 'tool' | 'system'): string {
  if (role === 'user') {
    const raw = typeof row.content === 'string' ? row.content : textFromContent(row.content);
    return extractTaggedContent(raw, 'USER_REQUEST') || stripAntigravityMetadata(raw);
  }
  if (role === 'assistant') return textFromContent(row.content);
  if (role === 'tool') return textFromContent(row.content ?? row.tool_calls ?? row.thinking);
  if (role === 'system') return textFromContent(row.content);
  return '';
}

function extractTaggedContent(text: string, tag: string): string {
  const match = text.match(new RegExp(`<${tag}>\\s*([\\s\\S]*?)\\s*<\\/${tag}>`, 'i'));
  return match?.[1]?.trim() ?? '';
}

function stripAntigravityMetadata(text: string): string {
  return text
    .replace(/<ADDITIONAL_METADATA>[\s\S]*?<\/ADDITIONAL_METADATA>/gi, ' ')
    .replace(/<USER_SETTINGS_CHANGE>[\s\S]*?<\/USER_SETTINGS_CHANGE>/gi, ' ')
    .replace(/<\/?USER_REQUEST>/gi, ' ')
    .trim();
}

export function estimateAntigravityTranscriptUsage(row: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  const source = String(row.source ?? '').toUpperCase();
  const type = String(row.type ?? '').toUpperCase();
  const contentTokens = estimateTextTokens(typeof row.content === 'string' ? row.content : '');
  const thinkingTokens = estimateTextTokens(typeof row.thinking === 'string' ? row.thinking : '');
  const toolCallTokens = Array.isArray(row.tool_calls) ? estimateTextTokens(JSON.stringify(row.tool_calls)) : 0;

  if (source.includes('USER') || source === 'SYSTEM') return { inputTokens: contentTokens, outputTokens: 0 };
  if (source === 'MODEL') {
    if (type === 'PLANNER_RESPONSE' || type === 'GENERIC') return { inputTokens: 0, outputTokens: contentTokens + thinkingTokens + toolCallTokens };
    return { inputTokens: contentTokens, outputTokens: thinkingTokens + toolCallTokens };
  }
  return { inputTokens: contentTokens, outputTokens: thinkingTokens + toolCallTokens };
}

export function estimateTextTokens(text: string): number {
  if (!text.trim()) return 0;
  let ascii = 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (/\s/.test(char)) continue;
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3040 && code <= 0x30ff) || (code >= 0xac00 && code <= 0xd7af)) cjk += 1;
    else if (code <= 0x7f) ascii += 1;
    else other += 1;
  }
  return Math.max(1, Math.ceil(ascii / 4 + cjk + other / 2));
}

function earlierIso(a: string, b?: string): string {
  if (!b) return a;
  return Date.parse(b) < Date.parse(a) ? b : a;
}

function laterIso(a: string, b?: string): string {
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

function validIso(value: string): string | undefined {
  return Number.isNaN(Date.parse(value)) ? undefined : new Date(value).toISOString();
}

function cleanTitle(value: string): string {
  const line = value
    .split('\n')
    .map((line) => line.trim())
    .map((line) => line.replace(/<\/?USER_REQUEST>/g, '').trim())
    .find(Boolean);
  if (!line || looksSensitiveTitle(line)) return '';
  return line.slice(0, 96);
}

function looksSensitiveTitle(value: string): boolean {
  if (/^(AQ\.|ya29\.|sk-|ghp_|glpat-|xox[baprs]-)/i.test(value)) return true;
  if (value.length >= 32 && !/\s/.test(value) && /[A-Z]/.test(value) && /[a-z]/.test(value) && /\d/.test(value)) return true;
  return false;
}

function antigravityPrintArgs(prompt: string, resumeArgs: string[] = []): string[] {
  return [...resumeArgs, '--print', prompt];
}
