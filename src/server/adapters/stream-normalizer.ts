/**
 * Server-side stream normalisation.
 *
 * Each connected CLI adapter speaks a different live wire format
 * (Claude stream-json, Codex `exec --json`, OpenCode/Oh-My-Pi JSON,
 * Antigravity plain text...). The `extractEnvelopeFrames` helper inspects
 * a raw `TerminalFrame` and, when possible, emits one or more
 * `history.message` envelope frames that the client can render uniformly
 * — without each adapter having to grow its own client-side parser.
 *
 * Behaviour rules:
 *   - The original raw frame is *not* mutated and is still re-emitted by
 *     the caller. We only return *extra* envelope frames.
 *   - System-stream frames are skipped (they already are envelopes, see
 *     {@link SessionManager.emitUserPrompt} / {@link historyFrame}).
 *   - Internal/log lines (Claude hooks, Codex token_count, etc.) yield no
 *     envelope, so the renderer suppresses them.
 *   - The envelope text is cleaned via {@link cleanInlineText} so that
 *     ANSI escapes from the CLI never reach the chat UI.
 */
import { buildChatEnvelope, cleanInlineText, type ChatRole } from '../../shared/chat-stream.js';
import type { AppId, TerminalFrame } from '../../shared/types.js';

interface EnvelopeFragment {
  role: ChatRole;
  text: string;
  partial?: boolean;
}

type Extractor = (payload: Record<string, unknown>) => EnvelopeFragment | EnvelopeFragment[] | undefined;

const EXTRACTORS: Partial<Record<AppId, Extractor>> = {
  codex: codexExtractor,
  // NOTE: Claude is intentionally absent. The client renderer already turns
  // every Claude stream-json shape (`result`, `assistant` with content
  // arrays, `stream_event` deltas, internal hook frames) into a
  // `history.message` envelope inside `normalizeClaudeStreamFrame`. Adding
  // a server-side envelope on top produces a second envelope with a
  // different `messageId`, which `mergeLiveSemanticHistoryFrame` does not
  // merge — `framesToConversationTurns` then treats them as two consecutive
  // live assistant turns and concatenates the text, surfacing the final
  // answer twice. We leave Claude entirely to the client until/unless the
  // client-side normaliser is retired.
  opencode: genericRoleContentExtractor,
  'oh-my-pi': genericRoleContentExtractor,
  antigravity: genericRoleContentExtractor
};

export function extractEnvelopeFrames(frame: TerminalFrame): TerminalFrame[] {
  if (frame.stream === 'system') return [];
  if (!frame.text) return [];
  const extractor = EXTRACTORS[frame.appId];
  if (!extractor) return [];
  const lines = frame.text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.length) return [];
  const fragments: EnvelopeFragment[] = [];
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== 'object') continue;
      payload = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const result = extractor(payload);
    if (!result) continue;
    if (Array.isArray(result)) fragments.push(...result);
    else fragments.push(result);
  }
  if (!fragments.length) return [];
  return fragments
    .map((fragment) => buildFrame(frame, fragment))
    .filter((value): value is TerminalFrame => value !== undefined);
}

function buildFrame(source: TerminalFrame, fragment: EnvelopeFragment): TerminalFrame | undefined {
  const cleaned = cleanInlineText(fragment.text);
  if (!cleaned) return undefined;
  const messageId = envelopeMessageId(source, fragment.role);
  return {
    sessionId: source.sessionId,
    appId: source.appId,
    stream: 'system',
    text: buildChatEnvelope({
      role: fragment.role,
      text: cleaned,
      messageId,
      live: true,
      partial: fragment.partial
    }),
    createdAt: source.createdAt
  };
}

function envelopeMessageId(frame: TerminalFrame, role: ChatRole): string {
  return [frame.sessionId, frame.appId, frame.createdAt, role].join(':');
}

// ---- Codex (`codex exec --json`) ---------------------------------------------------

function codexExtractor(payload: Record<string, unknown>): EnvelopeFragment | EnvelopeFragment[] | undefined {
  const type = String(payload.type ?? '');
  if (!type) return undefined;
  // Live `codex exec --json` wraps every payload as
  //   {"type":"item.completed","item":{...}} (also `item.started`,
  //   `item.updated`, ...). The legacy `response_item` wrapper still
  //   appears in some replays. Unwrap both and recurse so each `item.type`
  //   reaches its dedicated branch below.
  if ((type === 'response_item' || type.startsWith('item.')) && payload.item && typeof payload.item === 'object') {
    return codexExtractor(payload.item as Record<string, unknown>);
  }
  if (type === 'user_message') {
    // Live shape uses `text`; some older transcripts use `message`.
    const text = String(payload.text ?? payload.message ?? '');
    return text ? { role: 'user', text } : undefined;
  }
  if (type === 'agent_message') {
    const text = textFromCodexMessage(payload.message ?? payload.text ?? payload.content);
    return text ? { role: 'assistant', text } : undefined;
  }
  if (type === 'message') {
    const role = String(payload.role ?? '').toLowerCase();
    const text = textFromCodexMessage(payload.content ?? payload.message);
    if (!text) return undefined;
    if (role.includes('user') || role.includes('human')) return { role: 'user', text };
    return { role: 'assistant', text };
  }
  if (type === 'function_call' || type === 'tool_call') {
    const name = String(payload.name ?? payload.command ?? payload.call_id ?? '工具调用');
    const input = textFromCodexArguments(payload.arguments ?? payload.input);
    const text = input ? `${name}\n${input}` : name;
    return { role: 'tool', text };
  }
  if (type === 'function_call_output' || type === 'tool_result') {
    const text = textFromCodexArguments(payload.output ?? payload.content);
    return text ? { role: 'tool', text } : undefined;
  }
  if (type === 'exec_command') {
    const text = textFromCodexMessage(payload.command ?? payload.cmd);
    return text ? { role: 'tool', text } : undefined;
  }
  return undefined;
}

function textFromCodexMessage(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => (item && typeof item === 'object' && typeof (item as Record<string, unknown>).text === 'string'
        ? String((item as Record<string, unknown>).text)
        : ''))
      .filter(Boolean)
      .join('\n');
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (typeof record.text === 'string') return record.text;
    if (typeof record.content === 'string') return record.content;
    if (Array.isArray(record.content)) return textFromCodexMessage(record.content);
  }
  return '';
}

/**
 * Codex `function_call.arguments` is typically a JSON string (e.g.
 * `'{"path":"/tmp"}'`). Try to pretty-print it so tool calls render with
 * readable, indented arguments; fall back to the raw string / message
 * extraction for anything that isn't valid JSON.
 */
function textFromCodexArguments(value: unknown): string {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return textFromCodexMessage(value);
    }
  }
  return textFromCodexMessage(value);
}

// ---- Generic `{ role, content }` / `{ message: { role, content } }` ----------------

function genericRoleContentExtractor(payload: Record<string, unknown>): EnvelopeFragment | undefined {
  const direct = roleAndContent(payload);
  if (direct) return direct;
  const message = payload.message && typeof payload.message === 'object' ? (payload.message as Record<string, unknown>) : undefined;
  if (message) return roleAndContent(message);
  return undefined;
}

function roleAndContent(value: Record<string, unknown>): EnvelopeFragment | undefined {
  const role = String(value.role ?? '').toLowerCase();
  if (!role) return undefined;
  const text = firstTextFromContent(value.content ?? value.text ?? value.message);
  if (!text) return undefined;
  if (role.includes('user') || role.includes('human')) return { role: 'user', text };
  if (role.includes('assistant') || role.includes('agent') || role.includes('model')) return { role: 'assistant', text };
  if (role.includes('tool')) return { role: 'tool', text };
  if (role.includes('system')) return { role: 'system', text };
  return undefined;
}

// ---- Shared helpers ----------------------------------------------------------------

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function firstTextFromContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }
      if (!item || typeof item !== 'object') continue;
      const record = item as Record<string, unknown>;
      const text = firstString(record.text, record.content, record.input, record.message);
      if (text) parts.push(text);
    }
    return parts.filter(Boolean).join('\n');
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return firstString(record.text, record.content, record.input, record.message);
  }
  return '';
}
