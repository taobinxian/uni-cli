import type {
  AppId,
  AppInfo,
  CommandRun,
  Confirmation,
  DashboardSnapshot,
  DeleteSessionResult,
  EventRecord,
  PromptInput,
  StartSessionInput,
  Session,
  SessionHistory,
  TerminalFrame,
  TimeScope,
  TokenUsage,
  UsagePoint
} from '../shared/types.js';

export async function getDashboard(): Promise<DashboardSnapshot> {
  return request('/api/dashboard');
}

export async function getTokenUsage(scope: TimeScope): Promise<{ usage: TokenUsage[]; series: UsagePoint[] }> {
  return request(`/api/token-usage?scope=${scope}`);
}

export async function getSessions(appId?: AppId): Promise<Session[]> {
  return request(appId ? `/api/sessions?appId=${appId}` : '/api/sessions');
}

export async function startSession(input: StartSessionInput): Promise<Session> {
  return request('/api/sessions', {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function sendPrompt(sessionId: string, input: PromptInput): Promise<{ run: CommandRun; confirmation?: Confirmation }> {
  return request(`/api/sessions/${sessionId}/prompt`, {
    method: 'POST',
    body: JSON.stringify(input)
  });
}

export async function continueSession(sessionId: string): Promise<{ ok: true }> {
  return request(`/api/sessions/${sessionId}/continue`, { method: 'POST' });
}

export async function getSessionHistory(sessionId: string, options: { limit?: number; cursor?: number } = {}): Promise<SessionHistory> {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (typeof options.cursor === 'number') params.set('cursor', String(options.cursor));
  const query = params.toString();
  return request(`/api/sessions/${encodeURIComponent(sessionId)}/history${query ? `?${query}` : ''}`);
}

export async function stopSession(sessionId: string): Promise<{ ok: true }> {
  return request(`/api/sessions/${sessionId}/stop`, { method: 'POST' });
}

export async function deleteSession(sessionId: string): Promise<DeleteSessionResult> {
  return request(`/api/sessions/${sessionId}`, { method: 'DELETE' });
}

export async function resolveConfirmation(id: string, approved: boolean): Promise<Confirmation> {
  return request(`/api/confirmations/${id}/${approved ? 'approve' : 'reject'}`, { method: 'POST' });
}

export function eventsStream(onEvent: (event: EventRecord) => void): EventSource {
  return openSse('/sse/events', onEvent);
}

export function sessionStream(sessionId: string, onFrame: (frame: TerminalFrame) => void): EventSource {
  return openSse(`/sse/sessions/${encodeURIComponent(sessionId)}`, onFrame);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = {
    ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
    ...init?.headers
  };
  const response = await fetch(path, {
    ...init,
    headers
  });
  if (!response.ok) {
    const text = await response.text();
    const payload = parseErrorPayload(text);
    throw new Error(payload?.error ?? (text || response.statusText));
  }
  return response.json() as Promise<T>;
}

function parseErrorPayload(text: string): { error?: string } | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string') return parsed as { error: string };
  } catch {
    return undefined;
  }
  return undefined;
}

function openSse<T>(path: string, onMessage: (payload: T) => void): EventSource {
  const source = new EventSource(path);
  source.addEventListener('message', (message) => {
    onMessage(JSON.parse(message.data) as T);
  });
  return source;
}

export function appLabel(appId: AppId): string {
  if (appId === 'codex') return 'Codex';
  if (appId === 'claude') return 'Claude';
  return 'Antigravity';
}

export function appInitials(appId: AppId): string {
  if (appId === 'codex') return 'CX';
  if (appId === 'claude') return 'CL';
  return 'AG';
}

export function appClass(appId: AppId): string {
  return appId;
}
