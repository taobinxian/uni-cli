import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { EventRecord, EventType, TerminalFrame } from '../shared/types.js';
import { extractUsageFromText } from '../shared/parsers.js';
import { cleanInlineText, splitTextByGraphemes } from '../shared/chat-stream.js';
import { now, Store } from './db.js';
import { extractEnvelopeFrames } from './adapters/stream-normalizer.js';

type Unsubscribe = () => void;
type SessionTailProvider = (sessionId: string) => Promise<TerminalFrame[]>;

/** Maximum buffered frames retained per session for SSE replay. */
const SESSION_HISTORY_LIMIT = Math.max(300, readPositiveIntEnv('WORKBENCH_SSE_HISTORY_LIMIT', 1000));

/**
 * Read a positive-integer env variable, falling back to `fallback` when the
 * variable is unset, non-numeric, zero or negative. Exported so callers
 * (and tests) can share the same NaN-resilient parsing — a bare
 * `Number(env ?? default)` returns `NaN` for garbage strings and silently
 * disables limits like `WORKBENCH_SSE_HISTORY_LIMIT` (where `> NaN` is
 * always false, causing unbounded growth).
 */
export function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export class EventBus {
  private emitter = new EventEmitter();
  private store: Store;
  private terminalHistory = new Map<string, TerminalFrame[]>();
  private sessionTailProvider?: SessionTailProvider;
  private nextSeq = new Map<string, number>();

  constructor(store: Store) {
    this.store = store;
  }

  setSessionTailProvider(provider: SessionTailProvider): void {
    this.sessionTailProvider = provider;
  }

  async register(fastify: FastifyInstance): Promise<void> {
    await fastify.register(websocket);
    fastify.get('/ws/events', { websocket: true }, (socket) => {
      const handler = (event: EventRecord) => socket.send(JSON.stringify(event));
      const unsubscribe = this.subscribeEvents(handler);
      socket.on('close', unsubscribe);
    });

    fastify.get('/ws/sessions/:id', { websocket: true }, (socket, request) => {
      const { id } = request.params as { id: string };
      const unsubscribe = this.subscribeTerminal(id, (frame) => socket.send(JSON.stringify(frame)));
      socket.on('close', unsubscribe);
    });

    fastify.get('/sse/events', (request, reply) => {
      reply.hijack();
      prepareSse(reply.raw);
      const unsubscribe = this.subscribeEvents((event) => writeSse(reply.raw, event));
      const heartbeat = heartbeatSse(reply.raw);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
    });

    fastify.get('/sse/sessions/:id', (request, reply) => {
      const { id } = request.params as { id: string };
      reply.hijack();
      prepareSse(reply.raw);
      const terminalWriter = createTerminalSseWriter(reply.raw);
      const sinceSeq = this.lastEventIdFromHeaders(
        request.headers as unknown as Record<string, unknown>
      );
      const replay = sinceSeq !== undefined
        ? this.getTerminalHistorySince(id, sinceSeq)
        : this.getTerminalHistory(id);
      // Buffer any live frames that arrive while we are pushing the replay
      // backlog so they cannot be re-ordered ahead of the replay. We flip
      // `replaying` to false once the backlog is drained, then forward the
      // buffered frames to the writer in arrival order.
      const buffered: TerminalFrame[] = [];
      let replaying = true;
      const unsubscribe = this.subscribeTerminal(id, (frame) => {
        if (replaying) buffered.push(frame);
        else terminalWriter.write(frame);
      });
      for (const frame of replay) terminalWriter.write(frame);
      replaying = false;
      for (const frame of buffered) terminalWriter.write(frame);
      const stopTail = this.startSessionTail(id, terminalWriter);
      const heartbeat = heartbeatSse(reply.raw);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
        stopTail();
        terminalWriter.close();
        unsubscribe();
      });
    });
  }

  subscribeEvents(handler: (event: EventRecord) => void): Unsubscribe {
    this.emitter.on('event', handler);
    return () => this.emitter.off('event', handler);
  }

  subscribeTerminal(sessionId: string, handler: (frame: TerminalFrame) => void): Unsubscribe {
    const wrapped = (frame: TerminalFrame) => {
      if (frame.sessionId === sessionId) handler(frame);
    };
    this.emitter.on('terminal', wrapped);
    return () => this.emitter.off('terminal', wrapped);
  }

  getTerminalHistory(sessionId: string): TerminalFrame[] {
    return this.terminalHistory.get(sessionId) ?? [];
  }

  /**
   * Returns history frames with `seq > sinceSeq`. Used to resume SSE
   * streams after a reconnect by replaying everything the client missed
   * since the last `id:` it acknowledged.
   */
  getTerminalHistorySince(sessionId: string, sinceSeq: number): TerminalFrame[] {
    return this.getTerminalHistory(sessionId).filter((frame) => (frame.seq ?? 0) > sinceSeq);
  }

  /**
   * Stamp a seq and remember a frame coming from the adapter's history
   * tail provider. Returns the stamped frame so the caller can hand it to
   * a writer. Without this step tail-polled frames would reach the wire
   * without an `id:` line and could not be recovered via Last-Event-ID
   * on reconnect — see PR#3 codex review.
   */
  recordTailFrame(frame: TerminalFrame): TerminalFrame {
    const stamped = this.stampSeq(frame);
    this.rememberTerminalFrame(stamped);
    return stamped;
  }

  /**
   * Parses an SSE `Last-Event-ID` header from a Fastify request. Headers
   * arrive lower-cased from Fastify, but a defensive double lookup makes
   * the helper robust to upstream proxies that preserve casing.
   */
  lastEventIdFromHeaders(headers: Record<string, unknown> | undefined): number | undefined {
    if (!headers) return undefined;
    const raw = headers['last-event-id'] ?? headers['Last-Event-ID'];
    const text = Array.isArray(raw) ? raw[0] : raw;
    if (typeof text !== 'string' || text === '') return undefined;
    const value = Number(text);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }

  emit(type: EventType, message: string, partial: Partial<EventRecord> = {}): EventRecord {
    const event: EventRecord = {
      id: partial.id ?? randomUUID(),
      type,
      message,
      appId: partial.appId,
      sessionId: partial.sessionId,
      taskId: partial.taskId,
      tokenDelta: partial.tokenDelta,
      payload: partial.payload,
      createdAt: partial.createdAt ?? now()
    };
    this.store.insertEvent(event);
    this.emitter.emit('event', event);
    return event;
  }

  terminal(frame: TerminalFrame): void {
    // Side-effects on the *whole* raw frame, not on chunks: token extraction
    // (would double-count if split) and the `terminal.output` event message
    // (a single human-readable line per logical CLI write).
    const usage = extractUsageFromText(frame.text);
    const tokenDelta = usage.inputTokens + usage.outputTokens;
    if (tokenDelta > 0) {
      this.store.incrementSessionTokens(frame.sessionId, usage.inputTokens, usage.outputTokens);
      this.emit('token.updated', `Token 更新：+${tokenDelta} tokens`, {
        appId: frame.appId,
        sessionId: frame.sessionId,
        tokenDelta,
        payload: usage
      });
    }
    this.emit('terminal.output', terminalEventMessage(frame.text), {
      appId: frame.appId,
      sessionId: frame.sessionId,
      payload: frame
    });
    this.bindNativeSessionId(frame);
    // Derive normalised `history.message` envelope frames so every adapter
    // produces uniform user/agent message events without each client having
    // to re-parse the CLI-specific wire format.
    const envelopes = extractEnvelopeFrames(frame);
    // When at least one envelope was derived, mark the raw frame as
    // `normalized` so the client knows to skip its own raw-JSON conversion
    // path. Without this hint the client would also render the raw frame
    // via `displayFromJson` and the same chat turn would appear twice.
    const rawFrame: TerminalFrame = envelopes.length > 0 ? { ...frame, normalized: true } : frame;
    // Split & emit the raw frame as one or more chunks. Each chunk gets its
    // own seq so a client that disconnects mid-frame can reconnect with
    // `Last-Event-ID: <last-chunk-seq>` and recover only the missing tail.
    this.fanOutChunks(rawFrame);
    for (const envelope of envelopes) {
      this.fanOutChunks(envelope);
    }
  }

  private fanOutChunks(frame: TerminalFrame): void {
    const chunks = splitTerminalFrameForSse(frame);
    for (const chunk of chunks) {
      const stamped = this.stampSeq(chunk);
      this.rememberTerminalFrame(stamped);
      this.emitter.emit('terminal', stamped);
    }
  }

  private stampSeq(frame: TerminalFrame): TerminalFrame {
    if (typeof frame.seq === 'number') return frame;
    const next = (this.nextSeq.get(frame.sessionId) ?? 0) + 1;
    this.nextSeq.set(frame.sessionId, next);
    return { ...frame, seq: next };
  }

  private rememberTerminalFrame(frame: TerminalFrame): void {
    const current = this.terminalHistory.get(frame.sessionId) ?? [];
    current.push(frame);
    if (current.length > SESSION_HISTORY_LIMIT) current.splice(0, current.length - SESSION_HISTORY_LIMIT);
    this.terminalHistory.set(frame.sessionId, current);
  }

  private startSessionTail(
    sessionId: string,
    terminalWriter: { write(frame: TerminalFrame): void }
  ): Unsubscribe {
    if (!this.sessionTailProvider) return () => undefined;

    const seen = new Set(this.getTerminalHistory(sessionId).map(terminalFrameKey));
    const connectedAt = Date.now();
    const intervalMs = Number(process.env.WORKBENCH_SSE_HISTORY_INTERVAL_MS ?? 900);
    let polling = false;
    let stopped = false;

    const poll = async () => {
      if (stopped || polling || !this.sessionTailProvider) return;
      polling = true;
      try {
        const frames = await this.sessionTailProvider(sessionId);
        for (const frame of frames) {
          const key = terminalFrameKey(frame);
          if (seen.has(key)) continue;
          seen.add(key);
          const createdAt = Date.parse(frame.createdAt);
          if (Number.isFinite(createdAt) && createdAt < connectedAt - 500) continue;
          // Stamp + remember so the tailed frame joins the per-session seq
          // stream and can be recovered on reconnect via Last-Event-ID.
          // Without this, history-tail frames hit the wire without an
          // `id:` line and a reconnect could not replay them.
          terminalWriter.write(this.recordTailFrame(frame));
        }
      } catch {
        // Source history tailing is best-effort; launcher stdout/stderr remains authoritative.
      } finally {
        polling = false;
      }
    };

    const timer = setInterval(() => void poll(), Math.max(500, intervalMs));
    void poll();
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  private bindNativeSessionId(frame: TerminalFrame): void {
    if (frame.appId !== 'claude' && frame.appId !== 'opencode' && frame.appId !== 'oh-my-pi') return;
    const nativeId = nativeSessionIdFromText(frame.text);
    if (!nativeId) return;
    const updated = this.store.updateSessionNativeId(frame.sessionId, nativeId);
    if (updated) {
      this.emit('session.updated', `${updated.title} 已绑定原始日志 ${nativeId.slice(0, 8)}`, {
        appId: frame.appId,
        sessionId: frame.sessionId,
        payload: { nativeId }
      });
    }
  }
}

function terminalEventMessage(text: string): string {
  // Reuse the shared cleaner so server/client/event log strip the same
  // ANSI/control character set. Then collapse newlines (cleanInlineText
  // preserves them between non-empty lines) into single spaces because the
  // event message field is a single-line summary.
  const cleaned = cleanInlineText(text).replace(/\n+/g, ' ').trim();
  return cleaned.slice(0, 240) || 'terminal output';
}

function prepareSse(response: ServerResponse): void {
  response.socket?.setNoDelay(true);
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  response.flushHeaders?.();
  response.write(': connected\n\n');
}

function heartbeatSse(response: ServerResponse): NodeJS.Timeout {
  return setInterval(() => {
    if (!response.writableEnded) response.write(': heartbeat\n\n');
  }, 15_000);
}

function writeSse(response: ServerResponse, payload: EventRecord | TerminalFrame): boolean {
  if (response.writableEnded) return true;
  const idLine = sseIdLine(payload);
  const text = `${idLine}data: ${JSON.stringify(payload)}\n\n`;
  // response.write returns false when the internal buffer is full; the
  // caller can use this to apply back-pressure.
  return response.write(text);
}

function sseIdLine(payload: EventRecord | TerminalFrame): string {
  if (typeof (payload as TerminalFrame).seq === 'number') {
    return `id: ${(payload as TerminalFrame).seq}\n`;
  }
  return '';
}

export interface TerminalSseWriter {
  write(frame: TerminalFrame): void;
  close(): void;
  /** Number of frames waiting in the back-pressure queue (testing hook). */
  queueLength(): number;
}

/**
 * SSE writer for a single subscriber. The writer is *not* responsible for
 * splitting frames — chunking happens upstream in `EventBus.fanOutChunks`,
 * so each frame here has its own seq and is the unit of replay. The writer
 * is solely responsible for back-pressure: if `response.write` returns
 * false it stops pumping until `drain` fires; a bounded queue protects
 * against slow clients OOM-ing the server.
 */
export function createTerminalSseWriter(response: ServerResponse): TerminalSseWriter {
  const queue: TerminalFrame[] = [];
  const queueLimit = readIntEnv('WORKBENCH_SSE_QUEUE_LIMIT', 2000);
  let paused = false;
  let drainHandler: (() => void) | undefined;

  function enqueue(frame: TerminalFrame): void {
    queue.push(frame);
    if (queue.length > queueLimit) {
      // Drop the oldest pending frames to bound memory under slow clients.
      // Reconnect with `Last-Event-ID` can recover the gap because every
      // frame in the queue carries its own seq.
      queue.splice(0, queue.length - queueLimit);
    }
  }

  function flush(): void {
    while (!paused && queue.length) {
      if (response.writableEnded) {
        close();
        return;
      }
      const next = queue.shift()!;
      const ok = writeSse(response, next);
      if (!ok) {
        paused = true;
        installDrainHandler();
        return;
      }
    }
  }

  function installDrainHandler(): void {
    if (drainHandler) return;
    drainHandler = () => {
      paused = false;
      drainHandler = undefined;
      flush();
    };
    response.once('drain', drainHandler);
  }

  function close(): void {
    queue.length = 0;
    if (drainHandler) {
      response.off?.('drain', drainHandler);
      drainHandler = undefined;
    }
    paused = false;
  }

  return {
    write(frame) {
      if (paused) {
        enqueue(frame);
        return;
      }
      if (response.writableEnded) return;
      const ok = writeSse(response, frame);
      if (!ok) {
        paused = true;
        installDrainHandler();
      }
    },
    close,
    queueLength: () => queue.length
  };
}

function readIntEnv(name: string, fallback: number): number {
  return readPositiveIntEnv(name, fallback);
}

export function splitTerminalFrameForSse(frame: TerminalFrame): TerminalFrame[] {
  const semanticChunks = splitSemanticHistoryFrame(frame);
  if (semanticChunks) return semanticChunks;
  if (frame.stream === 'system' || frame.text.length <= 36) return [frame];
  const jsonLineChunks = splitJsonlFrame(frame);
  if (jsonLineChunks) return jsonLineChunks;
  return splitPlainTerminalFrame(frame);
}

function splitSemanticHistoryFrame(frame: TerminalFrame): TerminalFrame[] | undefined {
  const text = frame.text.trim();
  if (!text.startsWith('{') || text.length <= 80) return undefined;
  try {
    const value = JSON.parse(text) as Record<string, unknown>;
    if (value.type !== 'history.message') return undefined;
    const role = String(value.role ?? '');
    const message = typeof value.text === 'string' ? value.text : '';
    if (!message || message.length <= 36 || !/assistant|agent|model|output/i.test(role)) return undefined;
    const chunks = splitTextByGraphemes(message, 18);
    if (chunks.length <= 1) return undefined;
    const messageId = (typeof value.messageId === 'string' && value.messageId)
      ? value.messageId
      : semanticHistoryMessageId(frame, role);
    return chunks.map((chunk, index) => ({
      ...frame,
      text: JSON.stringify({
        ...value,
        text: chunk,
        live: true,
        messageId,
        chunkIndex: index,
        chunkCount: chunks.length
      }),
      partial: index > 0
    }));
  } catch {
    return undefined;
  }
}

function semanticHistoryMessageId(frame: TerminalFrame, role: string): string {
  return [frame.sessionId, frame.appId, frame.createdAt, role].join(':');
}

function splitJsonlFrame(frame: TerminalFrame): TerminalFrame[] | undefined {
  const lines = frame.text.split(/(\n)/);
  const chunks: string[] = [];
  let current = '';
  let sawJsonLine = false;

  for (const part of lines) {
    current += part;
    if (part !== '\n') continue;
    const trimmed = current.trim();
    if (trimmed) {
      if (!trimmed.startsWith('{')) return undefined;
      sawJsonLine = true;
      chunks.push(current);
    }
    current = '';
  }

  if (current.trim()) {
    if (!current.trim().startsWith('{')) return undefined;
    sawJsonLine = true;
    chunks.push(current);
  }

  if (!sawJsonLine || chunks.length <= 1) return undefined;
  return chunks.map((text) => ({ ...frame, text, partial: false }));
}

function splitPlainTerminalFrame(frame: TerminalFrame): TerminalFrame[] {
  // Split multi-line plain output by line rather than by character count.
  // Mid-line slicing would break the appearance of CLI rows; a line is the
  // smallest unit a human reasonably wants to see in one piece.
  //
  // Important: keep the trailing newline attached to its line chunk so the
  // wire-level concatenation is loss-less. The client's
  // `mergedConversationText` concatenates adjacent live assistant frames
  // with no extra separator — if we dropped the `\n`, `first\nsecond`
  // would arrive at the renderer as `firstsecond`.
  const segments = frame.text.split(/(\r?\n)/);
  if (segments.length <= 1) return [frame];
  const chunks: TerminalFrame[] = [];
  let pendingLine: string | undefined;
  for (const segment of segments) {
    if (!segment) continue;
    if (/^\r?\n$/.test(segment)) {
      if (pendingLine !== undefined) {
        // Attach the separator to the line we just finished.
        chunks.push({ ...frame, text: pendingLine + segment, partial: false });
        pendingLine = undefined;
      }
      // Else: leading or back-to-back separators — drop the empty line so
      // we don't emit a noise chunk with no text content.
      continue;
    }
    // Two content tokens in a row should not happen because `split(/(\r?\n)/)`
    // interleaves content and separators, but be defensive: flush any
    // dangling line before starting a new one.
    if (pendingLine !== undefined) {
      chunks.push({ ...frame, text: pendingLine, partial: false });
    }
    pendingLine = segment;
  }
  // Trailing line without a newline (e.g. raw stdout that hasn't flushed
  // its final `\n` yet) — emit it as a partial chunk so the client knows
  // the line is still in-flight.
  if (pendingLine !== undefined) {
    chunks.push({ ...frame, text: pendingLine, partial: true });
  }
  if (chunks.length <= 1) return [frame];
  return chunks;
}

function nativeSessionIdFromText(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const match = /"(?:session_id|sessionID)"\s*:\s*"([^"]{8,})"/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

function terminalFrameKey(frame: TerminalFrame): string {
  return [
    frame.sessionId,
    frame.appId,
    frame.stream,
    frame.createdAt,
    frame.partial ? 'partial' : 'full',
    frame.text
  ].join('\u001f');
}
