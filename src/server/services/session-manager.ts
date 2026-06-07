import { randomUUID } from 'node:crypto';
import type { AdapterManager } from '../adapters/index.js';
import { now, Store } from '../db.js';
import { EventBus } from '../event-bus.js';
import { assessRisk } from '../../shared/safety.js';
import type { AppId, CommandRun, Confirmation, DeleteSessionLogsResult, DeleteSessionResult, RiskAssessment, Session, SessionHistory, StartSessionInput, Task } from '../../shared/types.js';

const APP_META = {
  codex: { label: 'Codex', color: '#0d8a72', billingMode: 'subscription' as const },
  claude: { label: 'Claude', color: '#bd5b2f', billingMode: 'usage' as const },
  antigravity: { label: 'Antigravity', color: '#4c6fff', billingMode: 'included' as const },
  'oh-my-pi': { label: 'Oh My Pi', color: '#7c3aed', billingMode: 'usage' as const },
  opencode: { label: 'OpenCode', color: '#0284c7', billingMode: 'usage' as const }
} satisfies Record<AppId, { label: string; color: string; billingMode: Task['billingMode'] }>;
const DEFAULT_HISTORY_PAGE_SIZE = 12;
const MAX_HISTORY_PAGE_SIZE = 40;

export class SessionManager {
  private store: Store;
  private adapters: AdapterManager;
  private bus: EventBus;

  constructor(store: Store, adapters: AdapterManager, bus: EventBus) {
    this.store = store;
    this.adapters = adapters;
    this.bus = bus;
  }

  async bootstrap(): Promise<void> {
    if (process.env.WORKBENCH_DEMO_DATA !== '1') {
      this.store.deleteDemoData();
      this.store.deleteWorkbenchTestData();
    }
    for (const adapter of this.adapters.all()) {
      const status = await adapter.detect();
      const meta = APP_META[adapter.appId];
      this.store.upsertApp({ ...status, color: meta.color, billingMode: meta.billingMode });
      const sessions = await adapter.parseHistoricalLogs();
      for (const session of sessions) {
        if (this.store.isSessionDeleted(session)) continue;
        this.store.upsertSession(session);
        this.store.upsertTask(taskFromSession(session, session.title));
      }
      this.store.syncAppCounts(adapter.appId);
    }
    if (process.env.WORKBENCH_DEMO_DATA === '1') this.seedDesignData();
  }

  async start(input: StartSessionInput): Promise<Session> {
    const adapter = this.adapters.get(input.appId);
    const startRisk = input.prompt ? assessRisk(input.prompt) : { risky: false, reasons: [] };
    const launchInput = startRisk.risky ? { ...input, prompt: undefined } : input;
    const session = await adapter.startSession(launchInput, `${input.appId}-${randomUUID()}`);
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
    if (risk.risky) {
      const confirmation = this.createConfirmation(session, run.id, risk, timestamp);
      return { run, confirmation };
    }
    try {
      await this.dispatchPrompt(session, prompt);
    } catch (error) {
      this.store.updateCommandRun(run.id, 'failed');
      throw error;
    }
    return { run };
  }

  async continue(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.adapters.get(session.appId).resumeSession(session);
    const running: Session = { ...session, status: 'running', live: true, updatedAt: now() };
    this.store.upsertSession(running);
    this.store.updateTaskStatusBySession(sessionId, 'running');
    this.bus.emit('session.updated', `${session.title} 已继续`, { appId: session.appId, sessionId });
  }

  async stop(sessionId: string): Promise<void> {
    const session = this.requireSession(sessionId);
    await this.adapters.get(session.appId).stopSession(session);
    const stopped: Session = { ...session, status: 'stopped', live: false, updatedAt: now() };
    this.store.upsertSession(stopped);
    this.store.updateTaskStatusBySession(sessionId, 'stopped');
    this.bus.emit('task.updated', `${session.title} 已停止`, { appId: session.appId, sessionId });
  }

  async delete(sessionId: string): Promise<DeleteSessionResult | undefined> {
    const session = this.store.getSession(sessionId);
    if (!session) return undefined;
    const adapter = this.adapters.get(session.appId);
    await adapter.stopSession(session);
    const sourceDelete = await adapter.deleteSessionLogs(session);
    if (!deletedAnySource(sourceDelete)) {
      throw new SessionSourceLogNotFoundError(`${session.title} 没有找到对应的 CLI 原始日志文件，未删除。`);
    }
    const deleted = this.store.deleteSession(sessionId);
    if (deleted) {
      this.bus.emit('session.updated', `${deleted.title} 的 CLI 原始日志已删除`, {
        appId: deleted.appId,
        payload: { deletedSessionId: deleted.id, ...sourceDelete }
      });
    }
    return deleted ? { ok: true, session: deleted, ...sourceDelete } : undefined;
  }

  async history(sessionId: string, options: { limit?: number; cursor?: number } = {}): Promise<SessionHistory> {
    const session = this.requireSession(sessionId);
    const frames = await this.adapters.get(session.appId).readSessionHistory(session);
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

  private async dispatchPrompt(session: Session, prompt: string): Promise<void> {
    const running: Session = { ...session, status: 'running', live: true, updatedAt: now() };
    this.store.upsertSession(running);
    this.store.updateTaskStatusBySession(session.id, 'running');
    try {
      await this.adapters.get(session.appId).sendPrompt(running, prompt);
    } catch (error) {
      const interrupted: Session = { ...running, status: 'interrupted', live: false, updatedAt: now() };
      this.store.upsertSession(interrupted);
      this.store.updateTaskStatusBySession(session.id, 'interrupted');
      this.bus.emit('task.updated', `${session.title} 指令发送失败：${errorMessage(error)}`, {
        appId: session.appId,
        sessionId: session.id
      });
      throw error;
    }
    this.bus.emit('session.updated', `Dashboard · 向 ${session.title} 发送指令`, {
      appId: session.appId,
      sessionId: session.id
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
