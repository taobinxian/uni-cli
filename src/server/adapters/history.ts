import type { Session, TerminalFrame } from '../../shared/types.js';

export type HistoryRole = 'user' | 'assistant' | 'tool' | 'system' | 'error';

export function historyFrame(session: Session, role: HistoryRole, text: string, createdAt?: string): TerminalFrame | undefined {
  const cleaned = cleanHistoryText(text);
  if (!cleaned) return undefined;
  return {
    sessionId: session.id,
    appId: session.appId,
    stream: 'system',
    text: JSON.stringify({ type: 'history.message', role, text: cleaned }),
    createdAt: validHistoryIso(createdAt) ?? session.updatedAt
  };
}

export function compactHistoryFrames(frames: Array<TerminalFrame | undefined>, limit = 160): TerminalFrame[] {
  const result: TerminalFrame[] = [];
  for (const frame of frames) {
    if (!frame) continue;
    const previous = result[result.length - 1];
    if (previous?.text === frame.text) continue;
    result.push(frame);
  }
  return result.slice(-limit);
}

export function textFromContent(value: unknown): string {
  return textFromContentInner(value, 0);
}

export function cleanHistoryText(text: string): string {
  return text
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/g, ' ')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]+/g, ' ')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, 6000);
}

function textFromContentInner(value: unknown, depth: number): string {
  if (depth > 4 || value == null) return '';
  if (typeof value === 'string') return cleanHistoryText(value);
  if (typeof value === 'number' || typeof value === 'boolean') return '';
  if (Array.isArray(value)) {
    return value
      .map((item) => textFromContentInner(item, depth + 1))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value !== 'object') return '';

  const record = value as Record<string, unknown>;
  for (const key of ['text', 'content', 'message', 'input', 'output', 'result', 'summary']) {
    const text = textFromContentInner(record[key], depth + 1);
    if (text) return text;
  }
  return '';
}

function validHistoryIso(value?: string): string | undefined {
  if (!value || Number.isNaN(Date.parse(value))) return undefined;
  return new Date(value).toISOString();
}
