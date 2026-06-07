import { randomUUID } from 'node:crypto';
import type { Adapter } from '../adapters/base.js';
import type { AdapterManager } from '../adapters/index.js';
import { compactHistoryFrames, historyFrame, textFromContent, type HistoryRole } from '../adapters/history.js';
import { now, Store } from '../db.js';
import { EventBus } from '../event-bus.js';
import type { LauncherExitInfo } from '../launcher-service.js';
import { parseJsonLine } from '../../shared/parsers.js';
import { assessRisk } from '../../shared/safety.js';
import type { AppId, CommandRun, Confirmation, DeleteSessionLogsResult, DeleteSessionResult, RiskAssessment, Session, SessionHistory, StartSessionInput, Task, TerminalFrame } from '../../shared/types.js';

const APP_META = {
  codex: { label: 'Codex', color: '#0d8a72', billingMode: 'subscription' as const },
  claude: { label: 'Claude', color: '#bd5b2f', billingMode: 'usage' as const },
  antigravity: { label: 'Antigravity', color: '#4c6fff', billingMode: 'included' as const },
  'oh-my-pi': { label: 'Oh My Pi', color: '#7c3aed', billingMode: 'usage' as const },
  opencode: { label: 'OpenCode', color: '#0284c7', billingMode: 'usage' as const }
} satisfies Record<AppId, { label: string; color: string; billingMode: Task['billingMode'] }>;
const DEFAULT_HISTORY_PAGE_SIZE = 12;
const MAX_HISTORY_PAGE_SIZE = 40;
const HISTORICAL_REFRESH_INTERVAL_MS = 3_000;

export class SessionManager {
  private store: Store;
  private adapters: AdapterManager;
  private bus: EventBus;
  private lastHistoricalRefresh = new Map<AppId, number>();
  private historicalRefreshInFlight = new Map<AppId, Promise<void>>();
  private runtimeActiveSessionIds = new Set<string>();

  constructor(store: Store, adapters: AdapterManager, bus: EventBus) {
    this.store = store;
    this.adapters = adapters;
    this.bus = bus;
    this.bus.setSessionTailProvider((sessionId) => this.tailSessionHistoryForSse(sessionId));
  }

  async bootstrap(): Promise<void> {
    if (process.env.WORKBENCH_DEMO_DATA !== '1') {
      this.store.deleteDemoData();
      this.store.deleteWorkbenchTestData();
      for (const appId of Object.keys(APP_META) as AppId[]) this.store.backfillNativeSessionIdsFromEvents(appId);
    }
    for (const adapter of this.adapters.all()) {
      const status = await adapter.detect();
      const meta = APP_META[adapter.appId];
      this.store.upsertApp({ ...status, color: meta.color, billingMode: meta.billingMode });
      const sessions = await adapter.parseHistoricalLogs();
      for (const session of sessions) {
        if (this.store.isSessionDeleted(session)) continue;
        this.upsertHistoricalSession(session);
      }
      this.pruneMissingImportedSessions(adapter.appId, sessions);
      this.store.syncAppCounts(adapter.appId);
    }
    if (process.env.WORKBENCH_DEMO_DATA === '1') this.seedDesignData();
  }

  async refreshHistoricalSessions(appId?: AppId): Promise<void> {
    if (process.env.WORKBENCH_DEMO_DATA === '1') return;
    const adapters = this.adapters.all().filter((adapter) => !appId || adapter.appId === appId);
    await Promise.all(adapters.map((adapter) => this.refreshHistoricalAdapter(adapter)));
  }

  async start(input: StartSessionInput): Promise<Session> {
    const adapter = this.adapters.get(input.appId);
    const startRisk = input.prompt ? assessRisk(input.prompt) : { risky: false, reasons: [] };
    const launchInput = startRisk.risky ? { ...input, prompt: undefined } : input;
    const session = await adapter.startSession(launchInput, `${input.appId}-${randomUUID()}`);
    if (isActiveSession(session)) this.runtimeActiveSessionIds.add(session.id);
    this.store.upsertSession(session);
    this.store.upsertTask(taskFromSession(session, input.title ?? session.title));
    if (input.prompt && startRisk.risky) this.blockPrompt(session, input.prompt, startRisk);
    this.bus.emit('session.updated', `${adapter.label} 会话已启动`, { appId: input.appId, sessionId: session.id });
    return session;
  }

  async sendPrompt(sessionId: string, prompt: string): Promise<{ run: CommandRun; confirmation?: Confirmation }> {
    const session = this.requireSession(sessionId);
    const risk = assessRisk(prompt);
    const timestamp = now();
    const run: CommandRun = {
      id: randomUUID(),
      sessionId,
      appId: session.appId,
      prompt,
      status: risk.risky ? 'blocked' : 'running',
      createdAt: timestamp,
      updatedAt: timestamp,
      risk
    };
    this.store.insertCommandRun(run);
    this.emitUserPrompt(session, prompt, timestamp);
    if (risk.risky) {
      const confirmation = this.createConfirmation(session, run.id, risk, timestamp);
      return { run, confirmation };
    }
    void this.dispatchPrompt(session, prompt).catch((error) => this.failAsyncPromptDispatch(session, run.id, error));
    return { run };
  }

  async continue(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.adapters.get(session.appId).resumeSession(session);
    const running: Session = { ...session, status: 'running', live: true, updatedAt: now() };
    this.runtimeActiveSessionIds.add(sessionId);
    this.store.upsertSession(running);
    this.store.updateTaskStatusBySession(sessionId, 'running');
    this.bus.emit('session.updated', `${session.title} 已继续`, { appId: session.appId, sessionId });
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.adapters.get(session.appId).stopSession(session);
    this.runtimeActiveSessionIds.delete(sessionId);
    const stopped: Session = { ...session, status: 'stopped', live: false, updatedAt: now() };
    this.store.upsertSession(stopped);
    this.store.updateTaskStatusBySession(sessionId, 'stopped');
    this.store.updateActiveCommandRunsBySession(sessionId, 'stopped');
    this.bus.emit('task.updated', `${session.title} 已停止`, { appId: session.appId, sessionId });
  }

  handleLauncherExit(info: LauncherExitInfo): void {
    const session = this.store.getSession(info.sessionId);
    if (!session) return;
    this.runtimeActiveSessionIds.delete(info.sessionId);
    const status = info.reason === 'completed' ? 'completed' : info.reason === 'stopped' ? 'stopped' : 'interrupted';
    const completedRunStatus = status === 'completed' ? 'completed' : status === 'stopped' ? 'stopped' : 'failed';
    const timestamp = now();
    const updated: Session = { ...session, status, live: false, updatedAt: timestamp };
    this.store.upsertSession(updated);
    this.store.upsertTask(taskFromSession(updated, updated.title));
    this.store.updateActiveCommandRunsBySession(session.id, completedRunStatus);
    this.bus.emit('session.updated', launcherExitMessage(updated, info), {
      appId: updated.appId,
      sessionId: updated.id,
      payload: { reason: info.reason, code: info.code, signal: info.signal }
    });
  }

  async delete(sessionId: string): Promise<DeleteSessionResult | undefined> {
    const session = this.store.getSession(sessionId);
    if (!session) return undefined;
    const adapter = this.adapters.get(session.appId);
    await adapter.stopSession(session);
    const sourceDelete = await adapter.deleteSessionLogs(session);
    const sourceFound = deletedAnySource(sourceDelete);
    if (!sourceFound) sourceDelete.skippedFiles.push(`${session.appId}:${session.nativeId ?? session.id}:no-source-log`);
    const deleted = this.store.deleteSession(sessionId);
    if (deleted) {
      this.bus.emit('session.updated', sourceFound ? `${deleted.title} 的 CLI 原始日志已删除` : `${deleted.title} 未发现原始日志，已从工作台移除`, {
        appId: deleted.appId,
        payload: { deletedSessionId: deleted.id, ...sourceDelete }
      });
    }
    return deleted ? { ok: true, session: deleted, ...sourceDelete } : undefined;
  }

  async history(sessionId: string, options: { limit?: number; cursor?: number } = {}): Promise<SessionHistory> {
    const session = this.requireSession(sessionId);
    const sourceFrames = await this.adapters.get(session.appId).readSessionHistory(session);
    const eventFrames = semanticHistoryFromTerminalFrames(session, this.store.listTerminalFramesForSession(sessionId));
    const frames = mergeHistoryFrames(sourceFrames, eventFrames);
    const limit = clampNumber(options.limit ?? DEFAULT_HISTORY_PAGE_SIZE, 1, MAX_HISTORY_PAGE_SIZE);
    const end = clampNumber(options.cursor ?? frames.length, 0, frames.length);
    const start = Math.max(0, end - limit);
    return {
      sessionId,
      frames: frames.slice(start, end),
      hasMore: start > 0,
      nextCursor: start > 0 ? start : undefined,
      totalFrames: frames.length
    };
  }

  async resolveConfirmation(id: string, status: 'approved' | 'rejected'): Promise<Confirmation> {
    const confirmation = this.store.resolveConfirmation(id, status);
    if (!confirmation) throw new Error('Confirmation not found');
    if (confirmation.commandRunId) {
      const run = this.store.getCommandRun(confirmation.commandRunId);
      if (run) {
        this.store.updateCommandRun(run.id, status === 'approved' ? 'running' : 'failed');
        if (status === 'approved') {
          try {
            await this.dispatchPrompt(this.requireSession(run.sessionId), run.prompt);
          } catch (error) {
            this.store.updateCommandRun(run.id, 'failed');
            throw error;
          }
        }
      }
    }
    this.bus.emit('confirmation.resolved', `确认已${status === 'approved' ? '通过' : '拒绝'}`, {
      appId: confirmation.appId,
      sessionId: confirmation.sessionId,
      payload: confirmation
    });
    return confirmation;
  }

  private requireSession(id: string): Session {
    const session = this.store.getSession(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    return session;
  }

  private async tailSessionHistoryForSse(sessionId: string): Promise<TerminalFrame[]> {
    const session = this.store.getSession(sessionId);
    if (!session) return [];
    const frames = await this.adapters.get(session.appId).readSessionHistory(session);
    return frames.slice(-80);
  }

  private upsertHistoricalSession(session: Session): void {
    const existing = this.findExistingSession(session);
    const merged =
      existing && this.runtimeActiveSessionIds.has(existing.id) && isActiveSession(existing)
        ? mergeHistoricalSession(existing, session)
        : session;
    this.store.upsertSession(merged);
    this.store.upsertTask(taskFromSession(merged, merged.title));
  }

  private refreshHistoricalAdapter(adapter: Adapter): Promise<void> {
    const current = this.historicalRefreshInFlight.get(adapter.appId);
    if (current) return current;
    const nowMs = Date.now();
    const previous = this.lastHistoricalRefresh.get(adapter.appId) ?? 0;
    if (nowMs - previous < HISTORICAL_REFRESH_INTERVAL_MS) return Promise.resolve();

    const refresh = (async () => {
      const sessions = await adapter.parseHistoricalLogs();
      for (const session of sessions) {
        if (this.store.isSessionDeleted(session)) continue;
        this.upsertHistoricalSession(session);
      }
      this.pruneMissingImportedSessions(adapter.appId, sessions);
      this.store.syncAppCounts(adapter.appId);
      this.lastHistoricalRefresh.set(adapter.appId, Date.now());
    })().finally(() => {
      this.historicalRefreshInFlight.delete(adapter.appId);
    });
    this.historicalRefreshInFlight.set(adapter.appId, refresh);
    return refresh;
  }

  private findExistingSession(session: Session): Session | undefined {
    return this.store.getSession(session.id) ?? (session.nativeId ? this.store.getSessionByNativeId(session.appId, session.nativeId) : undefined);
  }

  private pruneMissingImportedSessions(appId: AppId, sessions: Session[]): void {
    if (!sessions.length) return;
    this.store.pruneMissingImportedSessions(
      appId,
      sessions.filter((session) => session.nativeId).map((session) => session.id)
    );
  }

  private async dispatchPrompt(session: Session, prompt: string): Promise<void> {
    const running: Session = { ...session, status: 'running', live: true, updatedAt: now() };
    this.runtimeActiveSessionIds.add(session.id);
    this.store.upsertSession(running);
    this.store.updateTaskStatusBySession(session.id, 'running');
    try {
      await this.adapters.get(session.appId).sendPrompt(running, prompt);
    } catch (error) {
      this.runtimeActiveSessionIds.delete(session.id);
      const interrupted: Session = { ...running, status: 'interrupted', live: false, updatedAt: now() };
      this.store.upsertSession(interrupted);
      this.store.updateTaskStatusBySession(session.id, 'interrupted');
      this.bus.emit('task.updated', `${session.title} 指令发送失败：${errorMessage(error)}`, {
        appId: session.appId,
        sessionId: session.id
      });
      throw error;
    }
    this.runtimeActiveSessionIds.add(session.id);
    this.store.upsertSession({ ...running, updatedAt: now() });
    this.store.updateTaskStatusBySession(session.id, 'running');
    this.bus.emit('session.updated', `Dashboard · 向 ${session.title} 发送指令`, {
      appId: session.appId,
      sessionId: session.id
    });
  }

  private failAsyncPromptDispatch(session: Session, runId: string, error: unknown): void {
    this.runtimeActiveSessionIds.delete(session.id);
    this.store.updateCommandRun(runId, 'failed');
    this.bus.terminal({
      appId: session.appId,
      sessionId: session.id,
      stream: 'stderr',
      text: `error> 指令发送失败：${errorMessage(error)}`,
      createdAt: now()
    });
  }

  private emitUserPrompt(session: Session, prompt: string, timestamp = now()): void {
    this.bus.terminal({
      appId: session.appId,
      sessionId: session.id,
      stream: 'system',
      text: JSON.stringify({ type: 'history.message', role: 'user', text: prompt, live: true }),
      createdAt: timestamp
    });
  }

  private blockPrompt(session: Session, prompt: string, risk: RiskAssessment): { run: CommandRun; confirmation: Confirmation } {
    const timestamp = now();
    const run: CommandRun = {
      id: randomUUID(),
      sessionId: session.id,
      appId: session.appId,
      prompt,
      status: 'blocked',
      createdAt: timestamp,
      updatedAt: timestamp,
      risk
    };
    this.store.insertCommandRun(run);
    const confirmation = this.createConfirmation(session, run.id, risk, timestamp);
    return { run, confirmation };
  }

  private createConfirmation(session: Session, commandRunId: string, risk: RiskAssessment, timestamp: string): Confirmation {
    const confirmation: Confirmation = {
      id: randomUUID(),
      sessionId: session.id,
      appId: session.appId,
      commandRunId,
      reason: risk.reasons.join('、'),
      status: 'pending',
      createdAt: timestamp
    };
    this.store.insertConfirmation(confirmation);
    this.bus.emit('confirmation.required', `需要确认：${confirmation.reason}`, {
      appId: session.appId,
      sessionId: session.id,
      payload: confirmation
    });
    return confirmation;
  }

  private seedDesignData(): void {
    const base = new Date();
    const iso = (minutesAgo: number) => new Date(base.getTime() - minutesAgo * 60_000).toISOString();
    const sessions: Session[] = [
      {
        id: 'codex-C-184',
        appId: 'codex',
        nativeId: 'C-184',
        title: 'auth-refresh · Codex #C-184',
        cwd: '~/work/app-auth',
        status: 'running',
        model: 'gpt-5-codex',
        createdAt: iso(18),
        updatedAt: iso(1),
        inputTokens: 300_000,
        outputTokens: 128_000,
        totalTokens: 428_000,
        live: true
      },
      {
        id: 'claude-CL-77',
        appId: 'claude',
        nativeId: 'CL-77',
        title: 'analytics-sql · Claude #CL-77',
        cwd: 'remote: analytics-prod',
        status: 'completed',
        model: 'opus/sonnet',
        createdAt: iso(32),
        updatedAt: iso(9),
        inputTokens: 130_000,
        outputTokens: 56_000,
        totalTokens: 186_000,
        live: false
      },
      {
        id: 'antigravity-AG-12',
        appId: 'antigravity',
        nativeId: 'AG-12',
        title: 'collector-tests · Antigravity #AG-12',
        cwd: '~/agent-monitor',
        status: 'running',
        model: 'app session',
        createdAt: iso(6),
        updatedAt: iso(2),
        inputTokens: 70_000,
        outputTokens: 22_000,
        totalTokens: 92_000,
        live: false
      },
      {
        id: 'codex-C-201',
        appId: 'codex',
        nativeId: 'C-201',
        title: 'dashboard-layout · Codex #C-201',
        cwd: '~/dashboard',
        status: 'interrupted',
        model: 'gpt-5-codex',
        createdAt: iso(44),
        updatedAt: iso(22),
        inputTokens: 240_000,
        outputTokens: 74_000,
        totalTokens: 314_000,
        live: false
      }
    ];
    const tasks = [
      '修复登录态刷新失败',
      '生成 Q2 运营分析 SQL',
      '重构日志采集器测试',
      '更新前端看板布局'
    ];
    sessions.forEach((session, index) => {
      this.store.upsertSession(session);
      this.store.upsertTask(taskFromSession(session, tasks[index]));
    });
    [
      ['event-demo-1', 'Dashboard · 向 Codex #C-184 发送继续任务指令 · 等待执行', 'codex', 'codex-C-184', 42_000],
      ['event-demo-2', 'Codex · 修复登录态刷新失败 · shell test 通过', 'codex', 'codex-C-184', 38_000],
      ['event-demo-3', 'Claude · 生成 Q2 运营分析 SQL · 任务完成', 'claude', 'claude-CL-77', 186_000],
      ['event-demo-4', 'Antigravity · 重构日志采集器测试 · 开始执行', 'antigravity', 'antigravity-AG-12', 92_000]
    ].forEach(([id, message, appId, sessionId, tokenDelta], index) => {
      this.store.insertEvent({
        id: id as string,
        type: 'task.updated',
        appId: appId as AppId,
        sessionId: sessionId as string,
        message: message as string,
        tokenDelta: tokenDelta as number,
        createdAt: iso(42 - index * 5)
      });
    });
  }
}

export class SessionSourceLogNotFoundError extends Error {
  statusCode = 409;
}

function deletedAnySource(result: DeleteSessionLogsResult): boolean {
  return result.deletedFiles.length > 0 || result.modifiedFiles.length > 0;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function semanticHistoryFromTerminalFrames(session: Session, frames: TerminalFrame[]): TerminalFrame[] {
  const items: Array<{ role: HistoryRole; text: string; createdAt: string }> = [];
  for (const frame of frames) {
    for (const item of historyItemsFromTerminalFrame(frame)) {
      const previous = items[items.length - 1];
      if (previous?.role === item.role) {
        previous.text = mergeHistoryItemText(previous.text, item.text, item.role);
        previous.createdAt = frame.createdAt;
      } else {
        items.push({ ...item, createdAt: frame.createdAt });
      }
    }
  }
  const semanticFrames = items.map((item) => historyFrame(session, item.role, item.text, item.createdAt));
  return compactHistoryFrames(semanticFrames, 1200);
}

function historyItemsFromTerminalFrame(frame: TerminalFrame): Array<{ role: HistoryRole; text: string }> {
  if (isClaudeStreamJsonFragment(frame)) return [];
  if (isNoisyTerminalHistoryText(frame.text)) return [];
  const items: Array<{ role: HistoryRole; text: string }> = [];
  let sawJson = false;
  for (const line of frame.text.split('\n')) {
    const parsed = parseJsonLine(line);
    if (!parsed || typeof parsed !== 'object') continue;
    sawJson = true;
    items.push(...historyItemsFromJson(parsed as Record<string, unknown>, frame));
  }
  const visibleItems = items.filter((item) => !isNoisyTerminalHistoryText(item.text));
  if (visibleItems.length || sawJson) return visibleItems;

  const role = fallbackHistoryRole(frame);
  return frame.text.trim() && !isNoisyTerminalHistoryText(frame.text) ? [{ role, text: frame.text }] : [];
}

function isClaudeStreamJsonFragment(frame: TerminalFrame): boolean {
  if (frame.appId !== 'claude' || frame.stream !== 'stdout') return false;
  const normalized = cleanTerminalFragment(frame.text);
  if (!normalized || normalized.startsWith('{')) return false;
  return /"?(?:event|type|delta|text|session_id|stop_sequence|parent_tool_use_id|uuid)"?\s*:|content_block_delta|text_delta|message_delta/.test(normalized);
}

function isNoisyTerminalHistoryText(text: string): boolean {
  const normalized = cleanTerminalFragment(text);
  if (!normalized) return true;
  if (/NO_COLOR/i.test(normalized) && /FORCE_COLOR/i.test(normalized)) return true;
  if (/warnOnDeactivatedColors|getColorDepth|shouldColorize|internal:util\/colors|loadAssertionError/i.test(normalized)) return true;
  if (/opentui-notifications|Capabilities|Ptmux|\]66;|\]1337;|\]99;|\]10;|\]11;|\]12;/i.test(normalized)) return true;
  if (/Connecting to MCP servers|(?:^|\s)omp v\d/i.test(normalized)) return true;
  if (isBlockUiSplash(normalized)) return true;
  if (/⊙/.test(normalized) || /^([A-Za-z]\s+){2,}.*\/\s*\d+$/.test(normalized)) return true;
  if (normalized.length <= 20 && /^[A-Za-z](?:\s+[A-Za-z]){2,}$/.test(normalized)) return true;
  if (/[▀▄█▌▐▁▂▃▄▅▆▇]/.test(normalized) && /[\]\[]?\d{1,4};|[A-Z]\s+[A-Z]\s+·/.test(normalized)) return true;
  return /^[\]\[\d;:\s.default]+$/i.test(normalized) && /\]\d/.test(normalized);
}

function cleanTerminalFragment(text: string): string {
  return text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isBlockUiSplash(text: string): boolean {
  const compact = text.replace(/\s+/g, '');
  if (!compact) return false;
  const blockChars = compact.match(/[▀▄█▌▐▁▂▃▄▅▆▇╘╒╓╔╗╝╚║═│─┌┐└┘|]/g)?.length ?? 0;
  const letters = compact.match(/[A-Za-z0-9\u4e00-\u9fff]/g)?.length ?? 0;
  return blockChars >= 8 && blockChars > compact.length * 0.35 && letters < blockChars;
}

function fallbackHistoryRole(frame: TerminalFrame): HistoryRole {
  if (frame.stream === 'stderr') return 'error';
  if ((frame.appId === 'antigravity' || frame.appId === 'opencode' || frame.appId === 'oh-my-pi') && frame.stream === 'stdout') return 'assistant';
  return 'system';
}

function historyItemsFromJson(value: Record<string, unknown>, frame: TerminalFrame): Array<{ role: HistoryRole; text: string }> {
  const type = String(value.type ?? '');
  if (type === 'history.message') {
    const role = normalizeHistoryRole(value.role, frame.stream === 'stderr' ? 'error' : 'system') ?? 'system';
    const text = textFromContent(value.text);
    return text ? [{ role, text }] : [];
  }

  if (type === 'stream_event' && value.event && typeof value.event === 'object') {
    return historyItemsFromClaudeStreamEvent(value.event as Record<string, unknown>);
  }

  if (type === 'result') {
    const resultText = textFromContent(value.output ?? value.text ?? value.content ?? value.summary ?? value.message);
    return resultText ? [{ role: 'assistant', text: resultText }] : [];
  }

  const message = value.message && typeof value.message === 'object' ? (value.message as Record<string, unknown>) : undefined;
  const role = normalizeHistoryRole(message?.role ?? value.role ?? type, frame.stream === 'stderr' ? 'error' : undefined);
  const text = textFromContent(message?.content ?? value.content ?? value.text ?? value.output ?? value.summary);
  if (role && text) return [{ role, text }];

  if (/tool|command/i.test(type)) {
    const toolText = textFromContent(value.input ?? value.result ?? value.output ?? value.summary ?? value);
    return toolText ? [{ role: 'tool', text: toolText }] : [];
  }
  if (/error/i.test(type) || frame.stream === 'stderr') {
    const errorText = errorTextFromJson(value) || textFromContent(value.error ?? value.message ?? value);
    return errorText ? [{ role: 'error', text: errorText }] : [];
  }
  return [];
}

function errorTextFromJson(value: Record<string, unknown>): string {
  const error = value.error && typeof value.error === 'object' ? (value.error as Record<string, unknown>) : undefined;
  const data = error?.data && typeof error.data === 'object' ? (error.data as Record<string, unknown>) : undefined;
  const message = textFromContent(data?.message ?? error?.message ?? value.message ?? value.text ?? value.output);
  const name = textFromContent(error?.name ?? value.name);
  if (name && message) return `${name}: ${message}`;
  return message || name;
}

function historyItemsFromClaudeStreamEvent(event: Record<string, unknown>): Array<{ role: HistoryRole; text: string }> {
  const type = String(event.type ?? '');
  const delta = event.delta && typeof event.delta === 'object' ? (event.delta as Record<string, unknown>) : undefined;
  const contentBlock = event.content_block && typeof event.content_block === 'object' ? (event.content_block as Record<string, unknown>) : undefined;
  const deltaType = String(delta?.type ?? contentBlock?.type ?? '');
  if (type === 'content_block_delta') {
    const text = textFromStreamDelta(delta?.text);
    if (text.length) return [{ role: 'assistant', text }];
  }
  if (type === 'content_block_start') {
    const text = textFromStreamDelta(contentBlock?.text);
    if (text.length) return [{ role: 'assistant', text }];
  }
  if (type === 'message_start') {
    const message = event.message && typeof event.message === 'object' ? (event.message as Record<string, unknown>) : undefined;
    const text = textFromContent(message?.content);
    if (text) return [{ role: 'assistant', text }];
  }
  if (/thinking|reasoning/i.test(type) || /thinking|reasoning/i.test(deltaType)) {
    const text = textFromContent(delta?.thinking ?? delta?.text ?? contentBlock?.thinking ?? contentBlock?.text);
    return text ? [{ role: 'system', text: `思考/推理：${text}` }] : [];
  }
  if (type === 'error') {
    const text = textFromContent(event.message ?? event.error);
    return [{ role: 'error', text: text || 'Claude stream error' }];
  }
  return [];
}

function textFromStreamDelta(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, '');
}

function normalizeHistoryRole(value: unknown, fallback?: HistoryRole): HistoryRole | undefined {
  const normalized = String(value ?? '').toLowerCase();
  if (normalized.includes('assistant') || normalized.includes('agent') || normalized.includes('model')) return 'assistant';
  if (normalized.includes('user') || normalized.includes('human')) return 'user';
  if (normalized.includes('tool') || normalized.includes('command') || normalized.includes('stdout')) return 'tool';
  if (normalized.includes('error') || normalized.includes('stderr')) return 'error';
  if (normalized.includes('system') || normalized.includes('event') || normalized.includes('token')) return 'system';
  return fallback;
}

function mergeHistoryFrames(sourceFrames: TerminalFrame[], eventFrames: TerminalFrame[]): TerminalFrame[] {
  if (!eventFrames.length) return sourceFrames;
  if (!sourceFrames.length) return eventFrames;
  const sorted = [...sourceFrames, ...eventFrames].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return compactHistoryFrames(dedupeSemanticHistoryFrames(sorted), 1200);
}

function dedupeSemanticHistoryFrames(frames: TerminalFrame[]): TerminalFrame[] {
  const result: TerminalFrame[] = [];
  for (const frame of frames) {
    const incoming = semanticPayloadFromFrame(frame);
    if (!incoming) {
      result.push(frame);
      continue;
    }
    const duplicateIndex = result.findIndex((item) => nearDuplicateSemanticPayload(semanticPayloadFromFrame(item), incoming));
    if (duplicateIndex >= 0) {
      const existing = semanticPayloadFromFrame(result[duplicateIndex]);
      if (existing && semanticReadabilityScore(incoming.text) > semanticReadabilityScore(existing.text)) result[duplicateIndex] = frame;
      continue;
    }
    result.push(frame);
  }
  return result;
}

function semanticPayloadFromFrame(frame: TerminalFrame): { role: string; text: string } | undefined {
  const parsed = parseJsonLine(frame.text);
  if (!parsed || typeof parsed !== 'object') return undefined;
  const value = parsed as Record<string, unknown>;
  if (value.type !== 'history.message' || typeof value.text !== 'string') return undefined;
  return { role: String(value.role ?? ''), text: value.text };
}

function nearDuplicateSemanticPayload(a: { role: string; text: string } | undefined, b: { role: string; text: string }): boolean {
  if (!a || a.role !== b.role) return false;
  const left = compactSemanticText(a.text);
  const right = compactSemanticText(b.text);
  if (left.length < 40 || right.length < 40) return false;
  return left.includes(right) || right.includes(left);
}

function compactSemanticText(text: string): string {
  return text.replace(/\s+/g, '');
}

function semanticReadabilityScore(text: string): number {
  return (text.match(/\s/g)?.length ?? 0) + (text.match(/\n/g)?.length ?? 0) * 4;
}

function mergeHistoryItemText(current: string, next: string, role: HistoryRole): string {
  if (role === 'system' && current.startsWith('思考/推理：') && next.startsWith('思考/推理：')) {
    return `${current}${next.replace(/^思考\/推理：/, '')}`;
  }
  if (current.endsWith(next)) return current;
  if (role === 'assistant') {
    const currentCompact = compactSemanticText(current);
    const nextCompact = compactSemanticText(next);
    if (currentCompact.length > 40 && nextCompact.length > 40) {
      if (currentCompact.includes(nextCompact)) return current;
      if (nextCompact.includes(currentCompact)) return semanticReadabilityScore(next) >= semanticReadabilityScore(current) ? next : current;
    }
    return `${current}${next}`;
  }
  return `${current}\n${next}`;
}

function taskFromSession(session: Session, title: string): Task {
  return {
    id: `task-${session.id}`,
    sessionId: session.id,
    appId: session.appId,
    title,
    cwd: session.cwd,
    status: session.status,
    billingMode: APP_META[session.appId].billingMode,
    startedAt: session.createdAt,
    updatedAt: session.updatedAt,
    durationMs: Math.max(60_000, Date.parse(session.updatedAt) - Date.parse(session.createdAt)),
    inputTokens: session.inputTokens,
    outputTokens: session.outputTokens,
    totalTokens: session.totalTokens
  };
}

function isActiveSession(session: Session): boolean {
  return session.live || session.status === 'running';
}

function mergeHistoricalSession(existing: Session, historical: Session): Session {
  return {
    ...historical,
    id: existing.id,
    nativeId: historical.nativeId ?? existing.nativeId,
    title: historical.title || existing.title,
    cwd: historical.cwd ?? existing.cwd,
    status: existing.status,
    model: historical.model ?? existing.model,
    createdAt: earlierIso(existing.createdAt, historical.createdAt),
    updatedAt: laterIso(existing.updatedAt, historical.updatedAt),
    inputTokens: Math.max(existing.inputTokens, historical.inputTokens),
    outputTokens: Math.max(existing.outputTokens, historical.outputTokens),
    totalTokens: Math.max(existing.totalTokens, historical.totalTokens),
    live: existing.live
  };
}

function launcherExitMessage(session: Session, info: LauncherExitInfo): string {
  if (info.reason === 'completed') return `${session.title} 已完成`;
  if (info.reason === 'stopped') return `${session.title} 已停止`;
  return `${session.title} 已中断${info.code == null ? '' : `（退出码 ${info.code}）`}`;
}

function earlierIso(a: string, b: string): string {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function laterIso(a: string, b: string): string {
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
