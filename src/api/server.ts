// Owner API — Fastify server + static panel serving. Auth: Bearer token for all /api/*.
// Pino is handled globally (src/config/logger.ts) — fastify's own logger stays off.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from '../config/index.js';
import type { WhatsAppProvider } from '../domain/whatsapp-provider.js';
import type { SendQueue } from '../queue/index.js';
import { registerRoutes, type ApiDeps } from './routes.js';

export type { ApiDeps };

export function buildServer(deps: ApiDeps): FastifyInstance {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', async (req, reply) => {
    const url = req.url ?? '';
    if (!url.startsWith('/api/')) return; // panel static is public; it sends Bearer via fetch
    if (req.headers.authorization !== `Bearer ${config.api.token}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
  });

  // Panel lives at src/panel/index.html; from src/api/server.ts the relative root is ../panel.
  const panelRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../panel');
  app.register(fastifyStatic, { root: panelRoot, prefix: '/' });

  registerRoutes(app, deps);
  return app;
}

export async function startApiServer(
  deps: ApiDeps,
  onReady?: (url: string) => void,
): Promise<FastifyInstance> {
  const app = buildServer(deps);
  await app.listen({ host: config.api.host, port: config.api.port });
  const url = `http://${config.api.host}:${config.api.port}`;
  if (onReady) onReady(url);
  return app;
}
