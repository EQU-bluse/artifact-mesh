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
      const body = request.body as { artifactId?: unknown } | null | undefined;
      const dependsOnId = body?.artifactId;
      if (typeof dependsOnId !== 'string') {
        return reply.code(400).send({ error: 'artifactId string is required' });
      }
      const artifactId = request.params.id;
      if (!store.exists(artifactId) || !store.exists(dependsOnId)) {
        return reply.code(404).send({ error: 'artifact not found' });
      }
      try {
        const dependency = store.addDependency(artifactId, dependsOnId);
        return reply.code(201).send(dependency);
      } catch (error) {
        if (error instanceof DependencyError) {
          if (error.code === 'DUPLICATE_RELATION') return reply.code(409).send({ error: 'dependency already exists' });
          return reply.code(400).send({ error: error.code === 'SELF_DEPENDENCY' ? 'artifact cannot depend on itself' : 'dependency would create a cycle' });
        }
        throw error;
      }
    }
  );

  app.get<{ Params: { id: string } }>('/api/v1/artifacts/:id/dependencies', async (request, reply) => {
    if (!store.exists(request.params.id)) return reply.code(404).send({ error: 'artifact not found' });
    return { items: store.dependencies(request.params.id) };
  });

  app.get<{ Params: { id: string } }>('/api/v1/artifacts/:id/dependents', async (request, reply) => {
    if (!store.exists(request.params.id)) return reply.code(404).send({ error: 'artifact not found' });
    return { items: store.dependents(request.params.id) };
  });

  return app;
}
