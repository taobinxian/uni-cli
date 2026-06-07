import { readFile, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Adapter, AdapterDeps } from './base.js';
import { requireCommand, resolveCommand } from './command-discovery.js';
import { listFiles, listFilesRecursive } from './fs-utils.js';
import { compactHistoryFrames, historyFrame, textFromContent } from './history.js';
import { extractUsage, parseJsonLine } from '../../shared/parsers.js';
import type { AdapterStatus, DeleteSessionLogsResult, Session, StartSessionInput, TerminalFrame, TimeScope, TokenUsage } from '../../shared/types.js';

export class ClaudeAdapter implements Adapter {
  appId = 'claude' as const;
  label = 'Claude';
  color = '#bd5b2f';
  defaultModel = 'opus/sonnet';
  private commandHint = process.env.CLAUDE_CMD ?? 'claude';
  private launcher: AdapterDeps['launcher'];

  constructor(deps: AdapterDeps) {
    this.launcher = deps.launcher;
  }

  async detect(): Promise<AdapterStatus> {
    const command = await resolveCommand({ envVar: 'CLAUDE_CMD', names: ['claude'] });
    const sessions = await this.listSessions();
    return {
      appId: this.appId,
      label: this.label,
      command: command ?? this.commandHint,
      status: command ? 'connected' : 'missing',
      message: command ? 'Claude CLI 可用' : '未找到 Claude CLI，可设置 CLAUDE_CMD 或将 claude 加入 PATH',
      sessions: sessions.length,
      tasks: sessions.length
    };
  }

  async listSessions(): Promise<Session[]> {
    return this.parseHistoricalLogs();
  }

  async startSession(input: StartSessionInput, sessionId = `claude-${randomUUID()}`): Promise<Session> {
    const command = await requireCommand({ envVar: 'CLAUDE_CMD', names: ['claude'] }, this.label);
    const timestamp = new Date().toISOString();
    const hasPrompt = Boolean(input.prompt?.trim());
    const session: Session = {
      id: sessionId,
      appId: this.appId,
      title: input.title ?? input.prompt?.slice(0, 48) ?? 'Claude session',
      cwd: input.cwd,
      status: hasPrompt ? 'running' : 'pending',
      model: this.defaultModel,
      createdAt: timestamp,
      updatedAt: timestamp,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      live: hasPrompt
    };
    if (hasPrompt) {
      await this.launcher.launch({
        appId: this.appId,
        sessionId,
        command,
        args: claudePrintArgs(input.prompt!),
        pty: false,
        stdin: 'ignore',
        cwd: input.cwd
      });
    }
    return session;
  }

  async resumeSession(session: Session): Promise<void> {
    if (this.launcher.has(session.id)) return;
    const command = await requireCommand({ envVar: 'CLAUDE_CMD', names: ['claude'] }, this.label);
    await this.launcher.launch({
      appId: this.appId,
      sessionId: session.id,
      command,
      args: session.nativeId ? ['--resume', session.nativeId] : ['--continue'],
      cwd: session.cwd
    });
  }

  async sendPrompt(session: Session, prompt: string): Promise<void> {
    const command = await requireCommand({ envVar: 'CLAUDE_CMD', names: ['claude'] }, this.label);
    this.launcher.stop(session.id);
    await this.launcher.launch({
      appId: this.appId,
      sessionId: session.id,
      command,
      args: session.nativeId ? claudePrintArgs(prompt, ['--resume', session.nativeId]) : claudePrintArgs(prompt),
      cwd: session.cwd,
      pty: false,
      stdin: 'ignore'
    });
  }

  async stopSession(session: Session): Promise<void> {
    this.launcher.stop(session.id);
  }

  async parseHistoricalLogs(): Promise<Session[]> {
    const files = [
      ...(await listFilesRecursive(join(homedir(), '.claude', 'projects'), '.jsonl')),
      ...(await listFiles(join(homedir(), '.claude', 'transcripts'), '.jsonl'))
    ];
    const sessions = new Map<string, Session>();
    for (const file of files) {
      const session = await this.parseSessionFile(file.path, file.mtime);
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
      const type = String(row.type ?? '');
      const message = (row.message && typeof row.message === 'object' ? row.message : row) as Record<string, unknown>;
      const role = claudeHistoryRole(type, message);
      const text = textFromClaudeContent(message.content) || textFromContent(row.content ?? row.text ?? message.text);
      if (role && text) frames.push(historyFrame(session, role, text, timestamp));
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
      ...(await listFilesRecursive(join(homedir(), '.claude', 'projects'), '.jsonl')),
      ...(await listFiles(join(homedir(), '.claude', 'transcripts'), '.jsonl'))
    ];
    for (const file of files) {
      if (basename(file.path, '.jsonl') === id) return file.path;
      const content = await readFile(file.path, 'utf8');
      if (
        content.includes(`"sessionId":"${id}"`) ||
        content.includes(`"sessionId": "${id}"`) ||
        content.includes(`"session_id":"${id}"`) ||
        content.includes(`"session_id": "${id}"`)
      ) {
        return file.path;
      }
    }
    return undefined;
  }

  private async parseSessionFile(path: string, mtime: Date): Promise<Session | undefined> {
    const fallbackId = basename(path, '.jsonl');
    let id = fallbackId;
    let cwd: string | undefined;
    let model: string | undefined;
    let firstUser = '';
    let createdAt = '';
    let updatedAt = '';
    const usage = { inputTokens: 0, outputTokens: 0 };

    const content = await readFile(path, 'utf8');
    for (const line of content.split('\n')) {
      const row = parseJsonLine(line) as Record<string, unknown> | undefined;
      if (!row) continue;
      if (typeof row.sessionId === 'string') id = row.sessionId;
      if (typeof row.session_id === 'string') id = row.session_id;
      if (typeof row.cwd === 'string') cwd = row.cwd;
      const timestamp = typeof row.timestamp === 'string' ? row.timestamp : undefined;
      if (timestamp) {
        createdAt ||= timestamp;
        updatedAt = timestamp;
      }

      const message = (row.message && typeof row.message === 'object' ? row.message : undefined) as Record<string, unknown> | undefined;
      if (message) {
        if (typeof message.model === 'string' && message.model !== '<synthetic>') model ||= message.model;
        if (row.type === 'assistant') {
          const delta = claudeUsage(message.usage);
          usage.inputTokens += delta.inputTokens;
          usage.outputTokens += delta.outputTokens;
        }
        if (!firstUser && row.type === 'user') firstUser = textFromClaudeContent(message.content);
      } else {
        const delta = extractUsage(row);
        usage.inputTokens += delta.inputTokens;
        usage.outputTokens += delta.outputTokens;
        if (!firstUser && row.type === 'user') firstUser = typeof row.content === 'string' ? row.content : '';
      }
    }

    const title = cleanTitle(firstUser) ?? fallbackId.replace(/^ses_/, 'Claude ');
    return {
      id,
      appId: this.appId,
      nativeId: id,
      title,
      cwd,
      status: 'completed',
      model: model ?? this.defaultModel,
      createdAt: validIso(createdAt) ?? mtime.toISOString(),
      updatedAt: validIso(updatedAt) ?? mtime.toISOString(),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.inputTokens + usage.outputTokens,
      live: false
    };
  }
}

function emptyDeleteResult(): DeleteSessionLogsResult {
  return { deletedFiles: [], modifiedFiles: [], skippedFiles: [] };
}

function claudeUsage(value: unknown): { inputTokens: number; outputTokens: number } {
  const usage = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    inputTokens: safeToken(usage.input_tokens) + safeToken(usage.cache_creation_input_tokens) + safeToken(usage.cache_read_input_tokens),
    outputTokens: safeToken(usage.output_tokens)
  };
}

function textFromClaudeContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const text = content
    .map((item) => (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string' ? String((item as Record<string, unknown>).text) : ''))
    .find(Boolean);
  return text ?? '';
}

function claudeHistoryRole(type: string, message: Record<string, unknown>): 'user' | 'assistant' | 'system' | 'tool' | undefined {
  if (type === 'user' || type === 'assistant' || type === 'system') return type;
  const role = String(message.role ?? '');
  if (role === 'user' || role === 'assistant' || role === 'system') return role;
  if (type.includes('tool')) return 'tool';
  return undefined;
}

function cleanTitle(value: string): string | undefined {
  const line = value
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

function claudePrintArgs(prompt: string, resumeArgs: string[] = []): string[] {
  return ['--print', '--verbose', '--output-format', 'stream-json', '--include-partial-messages', ...resumeArgs, prompt];
}
