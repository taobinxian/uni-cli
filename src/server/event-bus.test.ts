import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Store } from './db.js';
import { EventBus, splitTerminalFrameForSse, createTerminalSseWriter, readPositiveIntEnv } from './event-bus.js';
import { parseChatEnvelope } from '../shared/chat-stream.js';
import type { TerminalFrame } from '../shared/types.js';

function makeBus(): { bus: EventBus; store: Store } {
  const store = new Store(':memory:');
  const bus = new EventBus(store);
  return { bus, store };
}

describe('EventBus.terminal — envelope derivation', () => {
  it('forwards the raw frame plus a derived history.message envelope for codex JSON', () => {
    const { bus } = makeBus();
    const received: TerminalFrame[] = [];
    bus.subscribeTerminal('s1', (frame) => received.push(frame));

    bus.terminal({
      sessionId: 's1',
      appId: 'codex',
      stream: 'stdout',
      text: JSON.stringify({ type: 'agent_message', message: 'hello stream' }) + '\n',
      createdAt: '2026-01-01T00:00:00.000Z'
    });

    expect(received).toHaveLength(2);
    expect(received[0].stream).toBe('stdout');
    expect(received[1].stream).toBe('system');
    expect(parseChatEnvelope(received[1].text)).toMatchObject({ role: 'assistant', text: 'hello stream', live: true });
  });

  it('does not emit envelope frames for plain non-JSON output', () => {
    const { bus } = makeBus();
    const received: TerminalFrame[] = [];
    bus.subscribeTerminal('s2', (frame) => received.push(frame));

    bus.terminal({
      sessionId: 's2',
      appId: 'antigravity',
      stream: 'stdout',
      text: 'plain text only\n',
      createdAt: '2026-01-01T00:00:00.000Z'
    });

    expect(received).toHaveLength(1);
    expect(received[0].stream).toBe('stdout');
  });

  it('marks the raw frame as `normalized` when a chat envelope is derived', () => {
    // The client uses `normalized` as a hint to skip its own raw-JSON
    // conversation path; otherwise the same agent_message would be rendered
    // twice — once from the raw stdout JSON and once from the envelope.
    const { bus } = makeBus();
    const received: TerminalFrame[] = [];
    bus.subscribeTerminal('s-norm', (frame) => received.push(frame));
    bus.terminal({
      sessionId: 's-norm',
      appId: 'codex',
      stream: 'stdout',
      text: JSON.stringify({ type: 'agent_message', message: 'hi' }) + '\n',
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    const raw = received.find((frame) => frame.stream === 'stdout');
    const envelope = received.find((frame) => frame.stream === 'system');
    expect(raw?.normalized).toBe(true);
    expect(envelope?.normalized).toBeUndefined();
  });

  it('does not mark frames that produce no envelope (plain text / claude raw)', () => {
    const { bus } = makeBus();
    const received: TerminalFrame[] = [];
    bus.subscribeTerminal('s-plain', (frame) => received.push(frame));
    bus.terminal({
      sessionId: 's-plain',
      appId: 'claude',
      stream: 'stdout',
      text: 'plain text\n',
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    expect(received).toHaveLength(1);
    expect(received[0].normalized).toBeUndefined();
  });

  it('does not re-emit envelopes when the input is itself a system envelope', () => {
    const { bus } = makeBus();
    const received: TerminalFrame[] = [];
    bus.subscribeTerminal('s3', (frame) => received.push(frame));

    bus.terminal({
      sessionId: 's3',
      appId: 'codex',
      stream: 'system',
      text: JSON.stringify({ type: 'history.message', role: 'user', text: 'hi', live: true }),
      createdAt: '2026-01-01T00:00:00.000Z'
    });

    expect(received).toHaveLength(1);
    expect(received[0].stream).toBe('system');
  });

  it('remembers raw and envelope frames so reconnecting clients see both', () => {
    const { bus } = makeBus();
    bus.terminal({
      sessionId: 's4',
      appId: 'codex',
      stream: 'stdout',
      text: JSON.stringify({ type: 'agent_message', message: 'hi' }) + '\n',
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    const history = bus.getTerminalHistory('s4');
    expect(history).toHaveLength(2);
    expect(history.map((f) => f.stream)).toEqual(['stdout', 'system']);
  });
});

describe('EventBus.terminal — monotonic seq for SSE reconnect', () => {
  it('attaches a monotonically increasing seq to every emitted frame', () => {
    const { bus } = makeBus();
    const received: TerminalFrame[] = [];
    bus.subscribeTerminal('s5', (frame) => received.push(frame));

    bus.terminal({
      sessionId: 's5',
      appId: 'antigravity',
      stream: 'stdout',
      text: 'one\n',
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    bus.terminal({
      sessionId: 's5',
      appId: 'antigravity',
      stream: 'stdout',
      text: 'two\n',
      createdAt: '2026-01-01T00:00:01.000Z'
    });

    const seqs = received.map((frame) => frame.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(seqs[0]).toBeLessThan(seqs[1]!);
  });

  it('exposes the remembered history with seqs intact for replay', () => {
    const { bus } = makeBus();
    bus.terminal({
      sessionId: 's6',
      appId: 'antigravity',
      stream: 'stdout',
      text: 'a',
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    bus.terminal({
      sessionId: 's6',
      appId: 'antigravity',
      stream: 'stdout',
      text: 'b',
      createdAt: '2026-01-01T00:00:01.000Z'
    });
    const history = bus.getTerminalHistory('s6');
    expect(history.every((frame) => typeof frame.seq === 'number')).toBe(true);
    expect(history[0].seq).toBeLessThan(history[1].seq!);
  });

  it('assigns each split chunk its own seq so mid-frame reconnect can recover the tail', () => {
    const { bus } = makeBus();
    const received: TerminalFrame[] = [];
    bus.subscribeTerminal('s9', (frame) => received.push(frame));
    // Use a long multi-line frame so it forces the splitter past the
    // fast-path (text.length > 36).
    bus.terminal({
      sessionId: 's9',
      appId: 'antigravity',
      stream: 'stdout',
      text: 'line one — a longer first row\nline two — a longer second row\nline three — a longer third row\n',
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    // The frame splits into three line chunks — each must carry a unique seq
    // so a client that died after chunk 0 can request seq > seq[0] and get
    // chunks 1 and 2 on reconnect.
    expect(received.length).toBeGreaterThanOrEqual(3);
    const seqs = received.map((frame) => frame.seq!);
    expect(new Set(seqs).size).toBe(seqs.length);
    const recovered = bus.getTerminalHistorySince('s9', seqs[0]);
    const recoveredTexts = recovered.map((frame) => frame.text).join('|');
    expect(recoveredTexts).toContain('line two');
    expect(recoveredTexts).toContain('line three');
    expect(recoveredTexts).not.toContain('line one');
  });

  it('returns history slices after a given seq for Last-Event-ID replay', () => {
    const { bus } = makeBus();
    bus.terminal({
      sessionId: 's7',
      appId: 'antigravity',
      stream: 'stdout',
      text: 'a',
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    bus.terminal({
      sessionId: 's7',
      appId: 'antigravity',
      stream: 'stdout',
      text: 'b',
      createdAt: '2026-01-01T00:00:01.000Z'
    });
    bus.terminal({
      sessionId: 's7',
      appId: 'antigravity',
      stream: 'stdout',
      text: 'c',
      createdAt: '2026-01-01T00:00:02.000Z'
    });
    const history = bus.getTerminalHistory('s7');
    const after = bus.getTerminalHistorySince('s7', history[0].seq!);
    expect(after.map((frame) => frame.text)).toEqual(['b', 'c']);
  });
});

describe('EventBus.recordTailFrame — adapter-tail frames join the seq stream', () => {
  it('stamps a seq, remembers the frame for replay, and returns it for the writer', () => {
    const { bus } = makeBus();
    const incoming: TerminalFrame = {
      sessionId: 's10',
      appId: 'codex',
      stream: 'system',
      text: JSON.stringify({ type: 'history.message', role: 'assistant', text: 'tailed' }),
      createdAt: '2026-01-01T00:00:00.000Z'
    };
    const stamped = bus.recordTailFrame(incoming);
    expect(typeof stamped.seq).toBe('number');
    const history = bus.getTerminalHistory('s10');
    expect(history.map((frame) => frame.seq)).toEqual([stamped.seq]);
  });

  it('keeps tail seqs monotonic and replayable via Last-Event-ID', () => {
    const { bus } = makeBus();
    const a = bus.recordTailFrame({
      sessionId: 's11',
      appId: 'codex',
      stream: 'system',
      text: 'frame-a',
      createdAt: '2026-01-01T00:00:00.000Z'
    });
    const b = bus.recordTailFrame({
      sessionId: 's11',
      appId: 'codex',
      stream: 'system',
      text: 'frame-b',
      createdAt: '2026-01-01T00:00:01.000Z'
    });
    expect(a.seq! < b.seq!).toBe(true);
    const recovered = bus.getTerminalHistorySince('s11', a.seq!);
    expect(recovered).toEqual([b]);
  });
});

describe('readPositiveIntEnv — guard against invalid env values', () => {
  it('returns the value when env is a positive integer', () => {
    process.env.WB_TEST_ENV_INT = '42';
    expect(readPositiveIntEnv('WB_TEST_ENV_INT', 999)).toBe(42);
    delete process.env.WB_TEST_ENV_INT;
  });

  it('falls back when env is unset', () => {
    delete process.env.WB_TEST_ENV_INT;
    expect(readPositiveIntEnv('WB_TEST_ENV_INT', 777)).toBe(777);
  });

  it('falls back when env is non-numeric', () => {
    process.env.WB_TEST_ENV_INT = 'not-a-number';
    expect(readPositiveIntEnv('WB_TEST_ENV_INT', 777)).toBe(777);
    delete process.env.WB_TEST_ENV_INT;
  });

  it('falls back when env is zero or negative', () => {
    process.env.WB_TEST_ENV_INT = '0';
    expect(readPositiveIntEnv('WB_TEST_ENV_INT', 777)).toBe(777);
    process.env.WB_TEST_ENV_INT = '-5';
    expect(readPositiveIntEnv('WB_TEST_ENV_INT', 777)).toBe(777);
    delete process.env.WB_TEST_ENV_INT;
  });
});

describe('EventBus.terminal — Last-Event-ID parsing', () => {
  it('reads numeric last-event-id headers from a Fastify request', () => {
    const { bus } = makeBus();
    expect(bus.lastEventIdFromHeaders({ 'last-event-id': '42' })).toBe(42);
    expect(bus.lastEventIdFromHeaders({ 'Last-Event-ID': '7' })).toBe(7);
    expect(bus.lastEventIdFromHeaders({})).toBeUndefined();
    expect(bus.lastEventIdFromHeaders({ 'last-event-id': 'nope' })).toBeUndefined();
    expect(bus.lastEventIdFromHeaders({ 'last-event-id': '0' })).toBe(0);
  });
});

describe('splitTerminalFrameForSse — grapheme-safe chunking', () => {
  const baseFrame: TerminalFrame = {
    sessionId: 'sess',
    appId: 'codex',
    stream: 'stdout',
    text: '',
    createdAt: '2026-01-01T00:00:00.000Z'
  };

  it('returns the frame unchanged when shorter than the split threshold', () => {
    expect(splitTerminalFrameForSse({ ...baseFrame, text: 'hi' })).toHaveLength(1);
  });

  it('does not split a multi-byte CJK character across chunks', () => {
    const longCjk = '你好'.repeat(40); // > 36 chars to trigger plain split
    const chunks = splitTerminalFrameForSse({ ...baseFrame, text: longCjk });
    for (const chunk of chunks) {
      // U+FFFD should not appear — that would mean we sliced inside a code unit
      expect(chunk.text.includes('�')).toBe(false);
      // Recombined chunks must round-trip the original
    }
    expect(chunks.map((c) => c.text).join('')).toBe(longCjk);
  });

  it('keeps ZWJ emoji as a single grapheme even when splitting', () => {
    const family = '👨‍👩‍👧';
    const text = `${family}${'X'.repeat(60)}`;
    const chunks = splitTerminalFrameForSse({ ...baseFrame, text });
    // First chunk should contain the full emoji
    expect(chunks[0].text.startsWith(family)).toBe(true);
  });

  it('preserves trailing newline delimiters on each plain-text chunk so the client can rejoin lines', () => {
    // Without the newline, the client's `mergedConversationText` concats
    // adjacent live assistant frames with no separator, so `first\nsecond`
    // would render as `firstsecond`. Each line-chunk keeps its `\n`.
    const chunks = splitTerminalFrameForSse({
      ...baseFrame,
      text: 'first line of text\nsecond line of text\n'
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text.endsWith('\n')).toBe(true);
    // Joining all chunks must round-trip the original text exactly.
    expect(chunks.map((c) => c.text).join('')).toBe('first line of text\nsecond line of text\n');
  });

  it('omits the trailing newline only on the last chunk when the input has none', () => {
    const chunks = splitTerminalFrameForSse({
      ...baseFrame,
      text: 'first line of text\nsecond line of text'
    });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].text.endsWith('\n')).toBe(true);
    expect(chunks[chunks.length - 1].text.endsWith('\n')).toBe(false);
    expect(chunks.map((c) => c.text).join('')).toBe('first line of text\nsecond line of text');
  });

  it('does not split a single-line system frame at all', () => {
    expect(
      splitTerminalFrameForSse({ ...baseFrame, stream: 'system', text: 'x'.repeat(200) })
    ).toHaveLength(1);
  });

  it('preserves chunk message-id and chunkCount metadata for semantic envelopes', () => {
    const longText = '一'.repeat(80);
    const envelope = {
      type: 'history.message',
      role: 'assistant',
      text: longText,
      live: true
    };
    const chunks = splitTerminalFrameForSse({
      ...baseFrame,
      stream: 'system',
      text: JSON.stringify(envelope)
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const parsed = parseChatEnvelope(chunk.text);
      expect(parsed?.messageId).toBeTruthy();
      expect(parsed?.chunkCount).toBe(chunks.length);
    }
    const reassembled = chunks
      .map((c) => parseChatEnvelope(c.text)?.text ?? '')
      .join('');
    expect(reassembled).toBe(longText);
  });
});

class FakeResponse extends EventEmitter {
  writableEnded = false;
  writes: string[] = [];
  /** When `false`, `write` returns false to simulate a full buffer. */
  allowWrites = true;

  write(chunk: string): boolean {
    this.writes.push(chunk);
    return this.allowWrites;
  }
}

describe('createTerminalSseWriter — back-pressure', () => {
  function frameWithText(text: string, seq: number): TerminalFrame {
    return {
      sessionId: 'sess',
      appId: 'codex',
      stream: 'stdout',
      text,
      createdAt: '2026-01-01T00:00:00.000Z',
      seq
    };
  }

  it('writes the first frame chunk immediately', () => {
    const response = new FakeResponse();
    const writer = createTerminalSseWriter(response as unknown as import('node:http').ServerResponse);
    writer.write(frameWithText('hi', 1));
    expect(response.writes.length).toBe(1);
    expect(response.writes[0]).toContain('hi');
    expect(response.writes[0]).toContain('id: 1');
    writer.close();
  });

  it('pauses pumping when response.write returns false', async () => {
    const response = new FakeResponse();
    response.allowWrites = false;
    const writer = createTerminalSseWriter(response as unknown as import('node:http').ServerResponse);
    // First write returns false → subsequent writes should queue, not flush.
    writer.write(frameWithText('first', 1));
    expect(response.writes.length).toBe(1);
    writer.write(frameWithText('second', 2));
    writer.write(frameWithText('third', 3));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(response.writes.length).toBe(1);
    expect(writer.queueLength()).toBe(2);
    writer.close();
  });

  it('resumes pumping after `drain` fires', async () => {
    const response = new FakeResponse();
    response.allowWrites = false;
    const writer = createTerminalSseWriter(response as unknown as import('node:http').ServerResponse);
    writer.write(frameWithText('first', 1));
    writer.write(frameWithText('second', 2));
    writer.write(frameWithText('third', 3));
    const before = response.writes.length;
    response.allowWrites = true;
    response.emit('drain');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(response.writes.length).toBeGreaterThan(before);
    expect(writer.queueLength()).toBe(0);
    writer.close();
  });

  it('drops oldest queued frames when the queue exceeds the limit', async () => {
    process.env.WORKBENCH_SSE_QUEUE_LIMIT = '4';
    const response = new FakeResponse();
    response.allowWrites = false;
    const writer = createTerminalSseWriter(response as unknown as import('node:http').ServerResponse);
    for (let index = 0; index < 10; index += 1) {
      writer.write(frameWithText(`frame ${index}`, index + 1));
    }
    expect(writer.queueLength()).toBeLessThanOrEqual(4);
    writer.close();
    delete process.env.WORKBENCH_SSE_QUEUE_LIMIT;
  });
});
