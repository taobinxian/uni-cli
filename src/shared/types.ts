export const APP_ORDER = ['codex', 'claude', 'antigravity', 'oh-my-pi', 'opencode'] as const;

export type AppId = (typeof APP_ORDER)[number];

export type AppStatus = 'connected' | 'not_configured' | 'missing' | 'error';

export type TaskStatus = 'running' | 'completed' | 'stopped' | 'interrupted' | 'pending';

export type BillingMode = 'subscription' | 'usage' | 'included';

export type TimeScope = 'day' | 'week' | 'month';

export type EventType =
  | 'task.updated'
  | 'session.updated'
  | 'token.updated'
  | 'terminal.output'
  | 'confirmation.required'
  | 'confirmation.resolved';

export interface AdapterStatus {
  appId: AppId;
  label: string;
  command?: string;
  status: AppStatus;
  message: string;
  sessions: number;
  tasks: number;
}

export interface AppInfo extends AdapterStatus {
  color: string;
  billingMode: BillingMode;
}

export interface Session {
  id: string;
  appId: AppId;
  nativeId?: string;
  title: string;
  cwd?: string;
  status: TaskStatus;
  model?: string;
  createdAt: string;
  updatedAt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  live: boolean;
}

export interface Task {
  id: string;
  sessionId: string;
  appId: AppId;
  title: string;
  cwd?: string;
  status: TaskStatus;
  billingMode: BillingMode;
  startedAt: string;
  updatedAt: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenUsage {
  appId: AppId;
  scope: TimeScope;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export type UsagePoint = {
  label: string;
} & Record<AppId, number>;

export interface CommandRun {
  id: string;
  sessionId: string;
  appId: AppId;
  prompt: string;
  status: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'stopped';
  createdAt: string;
  updatedAt: string;
  risk?: RiskAssessment;
}

export interface Confirmation {
  id: string;
  sessionId: string;
  appId: AppId;
  commandRunId?: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  createdAt: string;
  resolvedAt?: string;
}

export interface EventRecord {
  id: string;
  type: EventType;
  appId?: AppId;
  sessionId?: string;
  taskId?: string;
  message: string;
  tokenDelta?: number;
  createdAt: string;
  payload?: unknown;
}

export interface TerminalFrame {
  sessionId: string;
  appId: AppId;
  stream: 'stdout' | 'stderr' | 'system';
  text: string;
  createdAt: string;
  partial?: boolean;
}

export interface SessionHistory {
  sessionId: string;
  frames: TerminalFrame[];
  hasMore: boolean;
  nextCursor?: number;
  totalFrames: number;
}

export interface DeleteSessionLogsResult {
  deletedFiles: string[];
  modifiedFiles: string[];
  skippedFiles: string[];
}

export interface DeleteSessionResult extends DeleteSessionLogsResult {
  ok: true;
  session: Session;
}

export interface RiskAssessment {
  risky: boolean;
  reasons: string[];
}

export interface DashboardSnapshot {
  apps: AppInfo[];
  sessions: Session[];
  tasks: Task[];
  tokenUsage: TokenUsage[];
  usageSeries: UsagePoint[];
  events: EventRecord[];
  confirmations: Confirmation[];
}

export interface StartSessionInput {
  appId: AppId;
  prompt?: string;
  cwd?: string;
  title?: string;
}

export interface PromptInput {
  prompt: string;
}
