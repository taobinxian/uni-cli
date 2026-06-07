import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Fastify from 'fastify';
import staticPlugin from '@fastify/static';
import { AdapterManager } from './adapters/index.js';
import { ControlGateway } from './control-gateway.js';
import { Store } from './db.js';
import { EventBus } from './event-bus.js';
import { LauncherService } from './launcher-service.js';
import { registerRoutes } from './routes.js';
import { SessionManager } from './services/session-manager.js';
import { TokenAggregator } from './services/token-aggregator.js';

export async function buildServer() {
  const fastify = Fastify({ logger: true });
  const store = new Store(process.env.WORKBENCH_DB);
  const bus = new EventBus(store);
  const launcher = new LauncherService(bus);
  const adapters = new AdapterManager(launcher);
  const sessions = new SessionManager(store, adapters, bus);
  const control = new ControlGateway(sessions);
  const tokens = new TokenAggregator(store);

  await bus.register(fastify);
  await sessions.bootstrap();
  tokens.refresh();
  await registerRoutes(fastify, { store, control, tokens });

  const clientRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client');
  if (existsSync(join(clientRoot, 'index.html'))) {
    await fastify.register(staticPlugin, {
      root: clientRoot,
      prefix: '/',
      setHeaders(response, pathName) {
        if (pathName.endsWith('index.html')) {
          response.setHeader('Cache-Control', 'no-store');
        }
      }
    });
    fastify.setNotFoundHandler(async (_request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return reply.sendFile('index.html');
    });
  }

  return fastify;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8788);
  const host = process.env.HOST ?? '127.0.0.1';
  const server = await buildServer();
  await server.listen({ port, host });
}
