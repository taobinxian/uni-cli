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
  /**
   * Monotonic per-session sequence number assigned by EventBus when the
   * frame is published. Used as the SSE `id:` field so clients can
   * recover the missed tail with `Last-Event-ID` after a reconnect.
   * Optional on the wire so adapter-side code can keep constructing frames
   * without thinking about transport details.
   */
  seq?: number;
  /**
   * True when the server-side stream normaliser successfully derived one
   * or more `history.message` envelope frames from this raw frame. The
   * client uses it as a hint to skip its own raw-JSON conversion path so
   * the same chat turn is not rendered twice (once from raw stdout JSON,
   * once from the envelope). Always undefined on the envelope frames
   * themselves — the marker only ever annotates the raw source frame.
   */
  normalized?: boolean;
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
