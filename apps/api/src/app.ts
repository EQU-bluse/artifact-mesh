import Fastify from 'fastify';
import cors from '@fastify/cors';
import { resolve } from 'node:path';
import { createArtifactStore, type ArtifactStore, type NewArtifact } from './store.js';

const digestPattern = /^sha256:[a-f0-9]{64}$/u;

export async function buildApp(options: { database?: string; store?: ArtifactStore } = {}) {
  const app = Fastify({ logger: false });
  const store = options.store ?? createArtifactStore(options.database ?? resolve('.data/artifact-mesh.sqlite'));

  await app.register(cors, { origin: true });
  app.addHook('onClose', async () => store.close());

  app.get('/health', async () => ({ status: 'ok', service: 'artifact-mesh-api' }));
  app.get('/api/v1/artifacts', async () => ({ items: store.list() }));
  app.post<{ Body: NewArtifact }>('/api/v1/artifacts', async (request, reply) => {
    const body = request.body;
    if (!body || !body.name?.trim() || !body.version?.trim() || !body.mediaType?.trim() || !digestPattern.test(body.digest ?? '')) {
      return reply.code(400).send({ error: 'name, version, mediaType and a sha256 digest are required' });
    }
    try {
      const artifact = store.create({
        name: body.name.trim(), version: body.version.trim(), digest: body.digest, mediaType: body.mediaType.trim()
      });
      return reply.code(201).send(artifact);
    } catch (error) {
      if (String(error).includes('UNIQUE constraint failed')) return reply.code(409).send({ error: 'artifact version or digest already exists' });
      throw error;
    }
  });

  return app;
}
