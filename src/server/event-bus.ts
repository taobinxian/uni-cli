import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { EventRecord, EventType, TerminalFrame } from '../shared/types.js';
import { extractUsageFromText } from '../shared/parsers.js';
import { now, Store } from './db.js';

type Unsubscribe = () => void;
type SessionTailProvider = (sessionId: string) => Promise<TerminalFrame[]>;

export class EventBus {
  private emitter = new EventEmitter();
  private store: Store;
  private terminalHistory = new Map<string, TerminalFrame[]>();
  private sessionTailProvider?: SessionTailProvider;

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
      const unsubscribe = this.subscribeTerminal(id, (frame) => terminalWriter.write(frame));
      for (const frame of this.getTerminalHistory(id)) writeSse(reply.raw, frame);
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
    this.rememberTerminalFrame(frame);
    this.emitter.emit('terminal', frame);
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
  }

  private rememberTerminalFrame(frame: TerminalFrame): void {
    const current = this.terminalHistory.get(frame.sessionId) ?? [];
    current.push(frame);
    if (current.length > 300) current.splice(0, current.length - 300);
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
          terminalWriter.write(frame);
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
  const cleaned = text
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, ' ')
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, ' ')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function writeSse(response: ServerResponse, payload: EventRecord | TerminalFrame): void {
  if (response.writableEnded) return;
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function createTerminalSseWriter(response: ServerResponse): { write(frame: TerminalFrame): void; close(): void } {
  const queue: TerminalFrame[] = [];
  const intervalMs = Number(process.env.WORKBENCH_SSE_TYPE_INTERVAL_MS ?? 14);
  let timer: NodeJS.Timeout | undefined;

  function pump(): void {
    if (response.writableEnded) {
      close();
      return;
    }
    const next = queue.shift();
    if (next) writeSse(response, next);
    if (!queue.length && timer) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  function ensureTimer(): void {
    if (!timer) timer = setInterval(pump, Math.max(4, intervalMs));
  }

  function close(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
    queue.length = 0;
  }

  return {
    write(frame) {
      const chunks = splitTerminalFrameForSse(frame);
      if (chunks.length <= 1) {
        writeSse(response, chunks[0] ?? frame);
        return;
      }
      writeSse(response, chunks[0]);
      queue.push(...chunks.slice(1));
      ensureTimer();
    },
    close
  };
}

function splitTerminalFrameForSse(frame: TerminalFrame): TerminalFrame[] {
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
    const chunks = chunkText(message, 18);
    if (chunks.length <= 1) return undefined;
    const messageId = semanticHistoryMessageId(frame, role);
    return chunks.map((chunk, index) => ({
      ...frame,
      text: JSON.stringify({ ...value, text: chunk, live: true, messageId, chunkIndex: index, chunkCount: chunks.length }),
      partial: index > 0
    }));
  } catch {
    return undefined;
  }
}

function semanticHistoryMessageId(frame: TerminalFrame, role: string): string {
  return [frame.sessionId, frame.appId, frame.createdAt, role].join(':');
}

function chunkText(value: string, size: number): string[] {
  const chunks: string[] = [];
  const chars = Array.from(value);
  for (let index = 0; index < chars.length; index += size) {
    chunks.push(chars.slice(index, index + size).join(''));
  }
  return chunks;
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
  const chunks: TerminalFrame[] = [];
  let atLineStart = true;
  for (const segment of frame.text.split(/(\r?\n)/)) {
    if (!segment) continue;
    if (/^\r?\n$/.test(segment)) {
      atLineStart = true;
      continue;
    }
    const chars = Array.from(segment);
    const targetSize = frame.stream === 'stderr' ? 48 : 24;
    for (let index = 0; index < chars.length; index += targetSize) {
      chunks.push({
        ...frame,
        text: chars.slice(index, index + targetSize).join(''),
        partial: !atLineStart || index > 0
      });
      atLineStart = false;
    }
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
