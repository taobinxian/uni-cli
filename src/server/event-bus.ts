import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type { FastifyInstance } from 'fastify';
import websocket from '@fastify/websocket';
import type { EventRecord, EventType, TerminalFrame } from '../shared/types.js';
import { extractUsageFromText } from '../shared/parsers.js';
import { now, Store } from './db.js';

type Unsubscribe = () => void;

export class EventBus {
  private emitter = new EventEmitter();
  private store: Store;
  private terminalHistory = new Map<string, TerminalFrame[]>();

  constructor(store: Store) {
    this.store = store;
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
      const unsubscribe = this.subscribeTerminal(id, (frame) => writeSse(reply.raw, frame));
      for (const frame of this.getTerminalHistory(id)) writeSse(reply.raw, frame);
      const heartbeat = heartbeatSse(reply.raw);
      request.raw.on('close', () => {
        clearInterval(heartbeat);
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
  }

  private rememberTerminalFrame(frame: TerminalFrame): void {
    const current = this.terminalHistory.get(frame.sessionId) ?? [];
    current.push(frame);
    if (current.length > 300) current.splice(0, current.length - 300);
    this.terminalHistory.set(frame.sessionId, current);
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
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
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
