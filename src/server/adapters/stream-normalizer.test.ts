import { describe, expect, it } from 'vitest';
import { extractEnvelopeFrames } from './stream-normalizer.js';
import { parseChatEnvelope } from '../../shared/chat-stream.js';
import type { TerminalFrame } from '../../shared/types.js';

function frame(partial: Partial<TerminalFrame>): TerminalFrame {
  return {
    sessionId: 'sess',
    appId: 'codex',
    stream: 'stdout',
    text: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...partial
  };
}

describe('extractEnvelopeFrames', () => {
  it('returns empty for system stream — already an envelope', () => {
    expect(extractEnvelopeFrames(frame({ stream: 'system', text: 'anything' }))).toEqual([]);
  });

  it('returns empty for plain non-JSON stdout', () => {
    expect(extractEnvelopeFrames(frame({ text: 'just terminal noise' }))).toEqual([]);
  });

  describe('codex', () => {
    it('extracts user_message events', () => {
      const out = extractEnvelopeFrames(
        frame({ appId: 'codex', text: JSON.stringify({ type: 'user_message', message: 'q' }) + '\n' })
      );
      expect(out).toHaveLength(1);
      expect(out[0].stream).toBe('system');
      expect(parseChatEnvelope(out[0].text)).toMatchObject({ role: 'user', text: 'q', live: true });
    });

    it('extracts agent_message events', () => {
      const out = extractEnvelopeFrames(
        frame({ appId: 'codex', text: JSON.stringify({ type: 'agent_message', message: 'hi' }) + '\n' })
      );
      expect(out).toHaveLength(1);
      expect(parseChatEnvelope(out[0].text)).toMatchObject({ role: 'assistant', text: 'hi' });
    });

    it('extracts response_item wrappers', () => {
      const out = extractEnvelopeFrames(
        frame({
          appId: 'codex',
          text:
            JSON.stringify({ type: 'response_item', item: { type: 'agent_message', message: 'wrapped' } }) + '\n'
        })
      );
      expect(parseChatEnvelope(out[0].text)).toMatchObject({ role: 'assistant', text: 'wrapped' });
    });

    it('extracts item.completed agent_message — the real `codex exec --json` shape', () => {
      // Live `codex exec --json` writes
      //   {"type":"item.completed","item":{"type":"agent_message","text":"OK"}}
      // Without unwrapping `item.*`, agent replies never reach the envelope
      // pipeline and the unified chat protocol regresses to raw JSON.
      const out = extractEnvelopeFrames(
        frame({
          appId: 'codex',
          text:
            JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }) + '\n'
        })
      );
      expect(parseChatEnvelope(out[0].text)).toMatchObject({ role: 'assistant', text: 'OK' });
    });

    it('extracts item.completed user_message', () => {
      const out = extractEnvelopeFrames(
        frame({
          appId: 'codex',
          text:
            JSON.stringify({ type: 'item.completed', item: { type: 'user_message', text: 'hi' } }) + '\n'
        })
      );
      expect(parseChatEnvelope(out[0].text)).toMatchObject({ role: 'user', text: 'hi' });
    });

    it('extracts item.completed function_call as tool role', () => {
      const out = extractEnvelopeFrames(
        frame({
          appId: 'codex',
          text:
            JSON.stringify({
              type: 'item.completed',
              item: { type: 'function_call', name: 'shell', arguments: '{"cmd":"ls"}' }
            }) + '\n'
        })
      );
      const env = parseChatEnvelope(out[0].text);
      expect(env?.role).toBe('tool');
      expect(env?.text).toContain('shell');
      expect(env?.text).toContain('"cmd"');
    });

    it('supports the `text` field on user_message (live format) in addition to `message` (legacy)', () => {
      const liveOut = extractEnvelopeFrames(
        frame({ appId: 'codex', text: JSON.stringify({ type: 'user_message', text: 'live-q' }) + '\n' })
      );
      expect(parseChatEnvelope(liveOut[0].text)).toMatchObject({ role: 'user', text: 'live-q' });

      const legacyOut = extractEnvelopeFrames(
        frame({ appId: 'codex', text: JSON.stringify({ type: 'user_message', message: 'legacy-q' }) + '\n' })
      );
      expect(parseChatEnvelope(legacyOut[0].text)).toMatchObject({ role: 'user', text: 'legacy-q' });
    });

    it('extracts tool calls as the tool role', () => {
      const out = extractEnvelopeFrames(
        frame({
          appId: 'codex',
          text: JSON.stringify({ type: 'function_call', name: 'shell', arguments: 'ls -la' }) + '\n'
        })
      );
      expect(parseChatEnvelope(out[0].text)).toMatchObject({ role: 'tool' });
      expect(parseChatEnvelope(out[0].text)!.text).toContain('shell');
      expect(parseChatEnvelope(out[0].text)!.text).toContain('ls -la');
    });

    it('pretty-prints JSON-string arguments on function_call', () => {
      const out = extractEnvelopeFrames(
        frame({
          appId: 'codex',
          text:
            JSON.stringify({
              type: 'function_call',
              name: 'read_file',
              arguments: JSON.stringify({ path: '/tmp/notes.md', max_bytes: 4096 })
            }) + '\n'
        })
      );
      const env = parseChatEnvelope(out[0].text);
      expect(env?.role).toBe('tool');
      expect(env?.text).toContain('read_file');
      expect(env?.text).toContain('"path"');
      expect(env?.text).toContain('/tmp/notes.md');
      expect(env?.text).toContain('4096');
    });

    it('extracts structured function_call_output content arrays', () => {
      const out = extractEnvelopeFrames(
        frame({
          appId: 'codex',
          text:
            JSON.stringify({
              type: 'function_call_output',
              output: { content: [{ type: 'output_text', text: 'tool result here' }] }
            }) + '\n'
        })
      );
      expect(parseChatEnvelope(out[0].text)?.text).toContain('tool result here');
    });

    it('returns empty for unrelated codex events (task_started)', () => {
      expect(
        extractEnvelopeFrames(
          frame({ appId: 'codex', text: JSON.stringify({ type: 'task_started' }) + '\n' })
        )
      ).toEqual([]);
    });

    it('splits multiple JSON-L lines into separate envelopes', () => {
      const text =
        JSON.stringify({ type: 'user_message', message: 'q' }) +
        '\n' +
        JSON.stringify({ type: 'agent_message', message: 'a' }) +
        '\n';
      const out = extractEnvelopeFrames(frame({ appId: 'codex', text }));
      expect(out).toHaveLength(2);
      expect(parseChatEnvelope(out[0].text)?.role).toBe('user');
      expect(parseChatEnvelope(out[1].text)?.role).toBe('assistant');
    });
  });

  describe('claude — client owns the entire normalisation path', () => {
    // The client renderer already converts every Claude JSON shape
    // (`result`, `assistant` with content arrays, `stream_event` deltas,
    // internal hook frames…) via `normalizeClaudeStreamFrame`. If the
    // server ALSO emits a `history.message` envelope, the resulting two
    // envelopes carry different messageIds — `mergeLiveSemanticHistoryFrame`
    // does not merge them, and `framesToConversationTurns` then treats
    // them as two consecutive live assistant turns and concatenates the
    // text, surfacing Claude's final answer twice. So we skip Claude in
    // the server-side normaliser entirely.

    it('does not envelope result frames', () => {
      const out = extractEnvelopeFrames(
        frame({ appId: 'claude', text: JSON.stringify({ type: 'result', result: 'final answer' }) + '\n' })
      );
      expect(out).toEqual([]);
    });

    it('does not envelope assistant message frames with content arrays', () => {
      const out = extractEnvelopeFrames(
        frame({
          appId: 'claude',
          text:
            JSON.stringify({
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'hello there' }] }
            }) + '\n'
        })
      );
      expect(out).toEqual([]);
    });

    it('does not envelope hook-style internal events', () => {
      const out = extractEnvelopeFrames(
        frame({
          appId: 'claude',
          text: JSON.stringify({ type: 'system', subtype: 'hook_pre_tool_use' }) + '\n'
        })
      );
      expect(out).toEqual([]);
    });

    it('does not envelope stream_event partial deltas', () => {
      const out = extractEnvelopeFrames(
        frame({
          appId: 'claude',
          text:
            JSON.stringify({
              type: 'stream_event',
              event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'streaming…' } }
            }) + '\n'
        })
      );
      expect(out).toEqual([]);
    });
  });

  describe('opencode / oh-my-pi (json shapes)', () => {
    it('extracts assistant text from opencode role+text payload', () => {
      const out = extractEnvelopeFrames(
        frame({
          appId: 'opencode',
          text: JSON.stringify({ role: 'assistant', content: 'hi from oc' }) + '\n'
        })
      );
      expect(parseChatEnvelope(out[0].text)).toMatchObject({ role: 'assistant', text: 'hi from oc' });
    });

    it('extracts user text from oh-my-pi message payload', () => {
      const out = extractEnvelopeFrames(
        frame({
          appId: 'oh-my-pi',
          text: JSON.stringify({ message: { role: 'user', content: 'question?' } }) + '\n'
        })
      );
      expect(parseChatEnvelope(out[0].text)).toMatchObject({ role: 'user', text: 'question?' });
    });
  });

  it('strips ANSI escapes from extracted text', () => {
    const inner = '[31mhello[0m';
    const out = extractEnvelopeFrames(
      frame({ appId: 'codex', text: JSON.stringify({ type: 'agent_message', message: inner }) + '\n' })
    );
    expect(parseChatEnvelope(out[0].text)?.text).toBe('hello');
  });

  it('derives a stable messageId from session/app/createdAt/role', () => {
    const a = extractEnvelopeFrames(
      frame({ appId: 'codex', text: JSON.stringify({ type: 'agent_message', message: 'x' }) + '\n' })
    )[0];
    const b = extractEnvelopeFrames(
      frame({ appId: 'codex', text: JSON.stringify({ type: 'agent_message', message: 'x' }) + '\n' })
    )[0];
    expect(parseChatEnvelope(a.text)?.messageId).toBe(parseChatEnvelope(b.text)?.messageId);
    expect(parseChatEnvelope(a.text)?.messageId).toContain('sess');
    expect(parseChatEnvelope(a.text)?.messageId).toContain('codex');
  });

  it('marks extracted envelopes as live (vs. historical replay)', () => {
    const out = extractEnvelopeFrames(
      frame({ appId: 'codex', text: JSON.stringify({ type: 'agent_message', message: 'x' }) + '\n' })
    );
    expect(parseChatEnvelope(out[0].text)?.live).toBe(true);
  });
});
