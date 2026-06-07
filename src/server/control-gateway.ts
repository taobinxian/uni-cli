import type { AppId, PromptInput, StartSessionInput } from '../shared/types.js';
import { SessionManager } from './services/session-manager.js';

export class ControlGateway {
  private sessions: SessionManager;

  constructor(sessions: SessionManager) {
    this.sessions = sessions;
  }

  startSession(input: StartSessionInput) {
    return this.sessions.start(input);
  }

  sendPrompt(sessionId: string, input: PromptInput) {
    return this.sessions.sendPrompt(sessionId, input.prompt);
  }

  continueSession(sessionId: string) {
    return this.sessions.continue(sessionId);
  }

  stopSession(sessionId: string) {
    return this.sessions.stop(sessionId);
  }

  sessionHistory(sessionId: string, options?: { limit?: number; cursor?: number }) {
    return this.sessions.history(sessionId, options);
  }

  deleteSession(sessionId: string) {
    return this.sessions.delete(sessionId);
  }

  approveConfirmation(id: string) {
    return this.sessions.resolveConfirmation(id, 'approved');
  }

  rejectConfirmation(id: string) {
    return this.sessions.resolveConfirmation(id, 'rejected');
  }

  refreshHistoricalSessions(appId?: AppId) {
    return this.sessions.refreshHistoricalSessions(appId);
  }
}
