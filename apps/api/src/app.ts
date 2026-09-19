import Fastify from 'fastify';
import cors from '@fastify/cors';
import { resolve } from 'node:path';
import {
  createArtifactStore,
  DependencyError,
  type ArtifactStore,
  type NewArtifact
} from './store.js';

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

  app.post<{ Params: { id: string }; Body: unknown }>(
    '/api/v1/artifacts/:id/dependencies',
    async (request, reply) => {
      const { id } = request.params;
      const targetId = (request.body as { artifactId?: unknown } | null | undefined)?.artifactId;
      if (typeof targetId !== 'string' || targetId.length === 0) {
        return reply.code(400).send({ error: 'artifactId must be a non-empty string' });
      }
      try {
        const dependency = store.addDependency(id, targetId);
        return reply.code(201).send(dependency);
      } catch (error) {
        if (error instanceof DependencyError) {
          const status = error.code === 'not_found' ? 404 : error.code === 'duplicate' ? 409 : 400;
          return reply.code(status).send({ error: error.message });
        }
        throw error;
      }
    }
  );

  app.get<{ Params: { id: string } }>('/api/v1/artifacts/:id/dependencies', async (request, reply) => {
    const { id } = request.params;
    if (!store.exists(id)) return reply.code(404).send({ error: 'artifact does not exist' });
    return { items: store.dependenciesOf(id) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/artifacts/:id/dependents', async (request, reply) => {
    const { id } = request.params;
    if (!store.exists(id)) return reply.code(404).send({ error: 'artifact does not exist' });
    return { items: store.dependentsOf(id) };
  });

  return app;
}
