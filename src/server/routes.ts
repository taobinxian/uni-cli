import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
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
    const filePath = await resolveAssetPath(query.path, query.cwd);
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
    await control.refreshHistoricalSessions();
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
    await control.refreshHistoricalSessions(query.appId);
    return store.listSessions(query.appId);
  });

  fastify.get('/api/tasks', async (request) => {
    const query = request.query as { appId?: AppId; status?: TaskStatus };
    await control.refreshHistoricalSessions(query.appId);
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
    const cwd = await validateSessionCwd(body.cwd, reply);
    if (!cwd) return;
    const session = await control.startSession({ ...body, cwd });
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

async function validateSessionCwd(rawCwd: string | undefined, reply: { code(statusCode: number): { send(payload: unknown): unknown } }): Promise<string | undefined> {
  const cwd = expandHomePath(rawCwd?.trim() ?? '');
  if (!cwd) {
    reply.code(400).send({ error: '请选择工作目录' });
    return undefined;
  }
  if (!isAbsolute(cwd)) {
    reply.code(400).send({ error: '工作目录必须是绝对路径' });
    return undefined;
  }
  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) {
      reply.code(400).send({ error: '工作目录不是文件夹' });
      return undefined;
    }
  } catch {
    reply.code(400).send({ error: '工作目录不存在或不可访问' });
    return undefined;
  }
  return cwd;
}

function expandHomePath(pathName: string): string {
  if (pathName === '~') return homedir();
  if (pathName.startsWith('~/')) return join(homedir(), pathName.slice(2));
  return pathName;
}

async function resolveAssetPath(rawPath?: string, cwd?: string): Promise<string | undefined> {
  const cleaned = normalizeAssetPath(rawPath);
  if (!cleaned) return undefined;
  const base = cwd && isAbsolute(cwd) ? cwd : process.cwd();
  const direct = isAbsolute(cleaned) ? cleaned : resolve(base, cleaned);
  if (await isReadableImageFile(direct)) return direct;

  const sameDirectoryFallback = await findClosestImage(dirname(direct), basename(cleaned));
  if (sameDirectoryFallback) return sameDirectoryFallback;

  if (!isAbsolute(cleaned)) {
    const cwdFallback = await findClosestImage(base, basename(cleaned));
    if (cwdFallback) return cwdFallback;
  }
  return direct;
}

function normalizeAssetPath(rawPath?: string): string {
  if (!rawPath) return '';
  const trimmed = rawPath
    .trim()
    .replace(/^!\[\[|\]\]$/g, '')
    .replace(/^["'`<]+|["'`>\],，。；;:：]+$/g, '')
    .split('|')[0]
    .trim();
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

async function isReadableImageFile(pathName: string): Promise<boolean> {
  if (!imageMimeType(pathName)) return false;
  try {
    const info = await stat(pathName);
    return info.isFile();
  } catch {
    return false;
  }
}

async function findClosestImage(root: string, requestedName: string): Promise<string | undefined> {
  if (!root || !(await isDirectory(root))) return undefined;
  const requestedExt = extname(requestedName).toLowerCase();
  if (!requestedExt) return undefined;
  const requestedKey = fuzzyImageKey(requestedName);
  if (!requestedKey) return undefined;

  let best: { path: string; score: number } | undefined;
  const maxFiles = 6000;
  let visitedFiles = 0;

  async function visit(dir: string, depth: number): Promise<void> {
    if (depth > 5 || visitedFiles >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visitedFiles >= maxFiles) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!shouldSkipImageSearchDir(entry.name)) await visit(path, depth + 1);
        continue;
      }
      if (!entry.isFile() || extname(entry.name).toLowerCase() !== requestedExt) continue;
      visitedFiles += 1;
      const score = imageNameScore(requestedKey, fuzzyImageKey(entry.name));
      if (score > (best?.score ?? 0)) best = { path, score };
    }
  }

  await visit(root, 0);
  return best && best.score >= 36 ? best.path : undefined;
}

async function isDirectory(pathName: string): Promise<boolean> {
  try {
    return (await stat(pathName)).isDirectory();
  } catch {
    return false;
  }
}

function shouldSkipImageSearchDir(name: string): boolean {
  return name === 'node_modules' || name === '.git' || name === '.obsidian' || name === 'dist' || name === 'build';
}

function fuzzyImageKey(name: string): string {
  return basename(name, extname(name))
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_\-—–~·.,，。:：;；()[\]{}【】"'`!！?？]+/g, '');
}

function imageNameScore(requested: string, candidate: string): number {
  if (!requested || !candidate) return 0;
  if (requested === candidate) return 1000;
  if (candidate.includes(requested)) return 700 + requested.length;
  if (requested.includes(candidate)) return 420 + candidate.length;
  let prefix = 0;
  while (prefix < requested.length && prefix < candidate.length && requested[prefix] === candidate[prefix]) prefix += 1;
  const requestedChars = new Set([...requested]);
  let overlap = 0;
  for (const char of candidate) if (requestedChars.has(char)) overlap += 1;
  return prefix * 12 + overlap;
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
