import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppId, PromptInput, StartSessionInput, TaskStatus, TimeScope } from '../shared/types.js';
import { Store } from './db.js';
import { ControlGateway } from './control-gateway.js';
import { TokenAggregator } from './services/token-aggregator.js';
import { SessionSourceLogNotFoundError } from './services/session-manager.js';

export async function registerRoutes(
  fastify: FastifyInstance,
  deps: { store: Store; control: ControlGateway; tokens: TokenAggregator }
): Promise<void> {
  const { store, control, tokens } = deps;

  fastify.get('/api/health', async () => ({ ok: true, timestamp: new Date().toISOString() }));

  fastify.get('/api/assets/image', async (request, reply) => {
    const query = request.query as { path?: string; cwd?: string };
    const filePath = resolveAssetPath(query.path, query.cwd);
    if (!filePath) return reply.code(400).send({ error: 'Image path is required' });

    const mimeType = imageMimeType(filePath);
    if (!mimeType) return reply.code(400).send({ error: 'Unsupported image type' });

    try {
      const info = await stat(filePath);
      if (!info.isFile()) return reply.code(404).send({ error: 'Image not found' });
      return reply
        .type(mimeType)
        .header('Cache-Control', 'private, max-age=60')
        .send(createReadStream(filePath));
    } catch {
      return reply.code(404).send({ error: 'Image not found' });
    }
  });

  fastify.get('/api/dashboard', async () => {
    const tokenSnapshot = tokens.get('day');
    return {
      apps: store.listApps(),
      sessions: store.listSessions(),
      tasks: store.listTasks(),
      tokenUsage: tokenSnapshot.usage,
      usageSeries: tokenSnapshot.series,
      events: store.listEvents(),
      confirmations: store.listConfirmations()
    };
  });

  fastify.get('/api/apps', async () => store.listApps());

  fastify.get('/api/sessions', async (request) => {
    const query = request.query as { appId?: AppId };
    return store.listSessions(query.appId);
  });

  fastify.get('/api/tasks', async (request) => {
    const query = request.query as { appId?: AppId; status?: TaskStatus };
    return store.listTasks({ appId: query.appId, status: query.status });
  });

  fastify.get('/api/token-usage', async (request) => {
    const query = request.query as { scope?: TimeScope };
    return tokens.get(query.scope ?? 'day');
  });

  fastify.get('/api/events', async () => store.listEvents());

  fastify.get('/api/confirmations', async () => store.listConfirmations());

  fastify.post('/api/sessions', async (request, reply) => {
    const body = request.body as StartSessionInput;
    const session = await control.startSession(body);
    return reply.code(201).send(session);
  });

  fastify.post('/api/sessions/:id/prompt', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as PromptInput;
    const result = await control.sendPrompt(id, body);
    return reply.code(result.confirmation ? 202 : 200).send(result);
  });

  fastify.post('/api/sessions/:id/continue', async (request) => {
    const { id } = request.params as { id: string };
    await control.continueSession(id);
    return { ok: true };
  });

  fastify.get('/api/sessions/:id/history', async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { limit?: string; cursor?: string };
    return control.sessionHistory(id, {
      limit: query.limit ? Number(query.limit) : undefined,
      cursor: query.cursor ? Number(query.cursor) : undefined
    });
  });

  fastify.post('/api/sessions/:id/stop', async (request) => {
    const { id } = request.params as { id: string };
    await control.stopSession(id);
    return { ok: true };
  });

  fastify.delete('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const result = await control.deleteSession(id);
      if (!result) return reply.code(404).send({ error: 'Session not found' });
      tokens.refresh();
      return result;
    } catch (error) {
      if (error instanceof SessionSourceLogNotFoundError) return reply.code(error.statusCode).send({ error: error.message });
      throw error;
    }
  });

  fastify.post('/api/confirmations/:id/approve', async (request) => {
    const { id } = request.params as { id: string };
    return control.approveConfirmation(id);
  });

  fastify.post('/api/confirmations/:id/reject', async (request) => {
    const { id } = request.params as { id: string };
    return control.rejectConfirmation(id);
  });
}

function resolveAssetPath(rawPath?: string, cwd?: string): string | undefined {
  const cleaned = normalizeAssetPath(rawPath);
  if (!cleaned) return undefined;
  if (isAbsolute(cleaned)) return cleaned;
  const base = cwd && isAbsolute(cwd) ? cwd : process.cwd();
  return resolve(base, cleaned);
}

function normalizeAssetPath(rawPath?: string): string {
  if (!rawPath) return '';
  const trimmed = rawPath.trim().replace(/^["'`]+|["'`]+$/g, '');
  if (!trimmed) return '';
  if (/^file:\/\//i.test(trimmed)) {
    try {
      return decodeURIComponent(new URL(trimmed).pathname);
    } catch {
      return trimmed.replace(/^file:\/\//i, '');
    }
  }
  return trimmed;
}

function imageMimeType(pathName: string): string | undefined {
  const ext = extname(pathName).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  if (ext === '.svg') return 'image/svg+xml';
  return undefined;
}
