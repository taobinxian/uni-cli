import type { AdapterStatus, AppId, DeleteSessionLogsResult, Session, StartSessionInput, TerminalFrame, TimeScope, TokenUsage } from '../../shared/types.js';

export interface Adapter {
  appId: AppId;
  label: string;
  color: string;
  defaultModel: string;
  detect(): Promise<AdapterStatus>;
  listSessions(): Promise<Session[]>;
  startSession(input: StartSessionInput, sessionId: string): Promise<Session>;
  resumeSession(session: Session): Promise<void>;
  sendPrompt(session: Session, prompt: string): Promise<void>;
  stopSession(session: Session): Promise<void>;
  parseHistoricalLogs(): Promise<Session[]>;
  readSessionHistory(session: Session): Promise<TerminalFrame[]>;
  getTokenUsage(scope: TimeScope): Promise<TokenUsage[]>;
  deleteSessionLogs(session: Session): Promise<DeleteSessionLogsResult>;
}

export interface AdapterDeps {
  launcher: import('../launcher-service.js').LauncherService;
}
