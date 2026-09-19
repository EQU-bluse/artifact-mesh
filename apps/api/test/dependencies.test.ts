import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';

async function makeApp(database = ':memory:'): Promise<FastifyInstance> {
  return buildApp({ database });
}

let sequence = 0;

async function registerArtifact(app: FastifyInstance, label: string) {
  sequence += 1;
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/artifacts',
    payload: {
      name: `pkg-${label}`,
      version: `1.0.${sequence}`,
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest: `sha256:${sequence.toString(16).padStart(64, '0')}`
    }
  });
  assert.equal(response.statusCode, 201, response.body);
  return response.json() as { id: string; name: string; version: string; digest: string; mediaType: string; createdAt: string };
}

function addDependency(app: FastifyInstance, id: string, artifactId: unknown) {
  if (artifactId === undefined) {
    return app.inject({ method: 'POST', url: `/api/v1/artifacts/${id}/dependencies`, payload: {} });
  }
  return app.inject({
    method: 'POST',
    url: `/api/v1/artifacts/${id}/dependencies`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ artifactId })
  });
}

test('creates a dependency and returns the persisted record', async () => {
  const app = await makeApp();
  const a = await registerArtifact(app, 'a');
  const b = await registerArtifact(app, 'b');

  const response = await addDependency(app, a.id, b.id);
  assert.equal(response.statusCode, 201, response.body);
  const record = response.json();
  assert.deepEqual(Object.keys(record).sort(), ['artifactId', 'createdAt', 'dependsOnId']);
  assert.equal(record.artifactId, a.id);
  assert.equal(record.dependsOnId, b.id);
  assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

  const listed = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${a.id}/dependencies` });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().items, [record]);
  await app.close();
});

test('queries dependencies in both directions', async () => {
  const app = await makeApp();
  const a = await registerArtifact(app, 'a');
  const b = await registerArtifact(app, 'b');

  const created = await addDependency(app, a.id, b.id);
  assert.equal(created.statusCode, 201);

  const dependencies = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${a.id}/dependencies` });
  assert.equal(dependencies.statusCode, 200);
  assert.deepEqual(dependencies.json().items, [created.json()]);

  const dependents = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${b.id}/dependents` });
  assert.equal(dependents.statusCode, 200);
  assert.deepEqual(dependents.json().items, [created.json()]);

  // The edge is directional: b has no dependencies and a has no dependents.
  const reverseDeps = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${b.id}/dependencies` });
  assert.deepEqual(reverseDeps.json().items, []);
  const reverseDependents = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${a.id}/dependents` });
  assert.deepEqual(reverseDependents.json().items, []);
  await app.close();
});

test('rejects a duplicate dependency with 409', async () => {
  const app = await makeApp();
  const a = await registerArtifact(app, 'a');
  const b = await registerArtifact(app, 'b');

  assert.equal((await addDependency(app, a.id, b.id)).statusCode, 201);
  const duplicate = await addDependency(app, a.id, b.id);
  assert.equal(duplicate.statusCode, 409);

  // Only one edge was stored.
  const listed = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${a.id}/dependencies` });
  assert.equal(listed.json().items.length, 1);
  await app.close();
});

test('rejects a self dependency with 400', async () => {
  const app = await makeApp();
  const a = await registerArtifact(app, 'a');

  const response = await addDependency(app, a.id, a.id);
  assert.equal(response.statusCode, 400);

  const listed = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${a.id}/dependencies` });
  assert.deepEqual(listed.json().items, []);
  await app.close();
});

test('rejects cycles spanning multiple edges with 400', async () => {
  const app = await makeApp();
  const a = await registerArtifact(app, 'a');
  const b = await registerArtifact(app, 'b');
  const c = await registerArtifact(app, 'c');
  const d = await registerArtifact(app, 'd');

  assert.equal((await addDependency(app, a.id, b.id)).statusCode, 201);
  assert.equal((await addDependency(app, b.id, c.id)).statusCode, 201);
  assert.equal((await addDependency(app, c.id, d.id)).statusCode, 201);

  // d -> a closes the a -> b -> c -> d chain into a cycle.
  assert.equal((await addDependency(app, d.id, a.id)).statusCode, 400);

  // The direct reverse edge is a cycle too.
  assert.equal((await addDependency(app, b.id, a.id)).statusCode, 400);

  // Non-cyclic transitive shortcuts remain allowed.
  assert.equal((await addDependency(app, a.id, d.id)).statusCode, 201);
  await app.close();
});

test('returns 404 when the path artifact or the target does not exist', async () => {
  const app = await makeApp();
  const a = await registerArtifact(app, 'a');

  const missingTarget = await addDependency(app, a.id, 'does-not-exist');
  assert.equal(missingTarget.statusCode, 404);

  const missingPath = await addDependency(app, 'does-not-exist', a.id);
  assert.equal(missingPath.statusCode, 404);

  for (const suffix of ['dependencies', 'dependents']) {
    const missing = await app.inject({ method: 'GET', url: `/api/v1/artifacts/missing/${suffix}` });
    assert.equal(missing.statusCode, 404);
  }
  await app.close();
});

test('rejects missing, empty or non-string artifactId with 400', async () => {
  const app = await makeApp();
  const a = await registerArtifact(app, 'a');

  assert.equal((await addDependency(app, a.id, undefined)).statusCode, 400);
  assert.equal((await addDependency(app, a.id, '')).statusCode, 400);
  assert.equal((await addDependency(app, a.id, 123)).statusCode, 400);
  assert.equal((await addDependency(app, a.id, null)).statusCode, 400);
  assert.equal((await addDependency(app, a.id, { id: a.id })).statusCode, 400);
  await app.close();
});

test('orders records by createdAt desc then target/source id desc', async () => {
  const app = await makeApp();
  const a = await registerArtifact(app, 'a');
  const t1 = await registerArtifact(app, 't1');
  const t2 = await registerArtifact(app, 't2');
  const t3 = await registerArtifact(app, 't3');

  assert.equal((await addDependency(app, a.id, t1.id)).statusCode, 201);
  assert.equal((await addDependency(app, a.id, t2.id)).statusCode, 201);
  assert.equal((await addDependency(app, a.id, t3.id)).statusCode, 201);

  const dependencies = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${a.id}/dependencies` });
  const items = dependencies.json().items as Array<{ dependsOnId: string; createdAt: string }>;
  assert.equal(items.length, 3);
  for (let i = 1; i < items.length; i += 1) {
    const previous = items[i - 1] as { dependsOnId: string; createdAt: string };
    const current = items[i] as { dependsOnId: string; createdAt: string };
    assert.ok(
      previous.createdAt > current.createdAt ||
      (previous.createdAt === current.createdAt && previous.dependsOnId >= current.dependsOnId),
      'dependencies must be ordered by createdAt desc then dependsOnId desc'
    );
  }

  // Reverse query over the same edges must order by createdAt desc then artifactId desc.
  const source1 = await registerArtifact(app, 's1');
  const source2 = await registerArtifact(app, 's2');
  assert.equal((await addDependency(app, source1.id, t1.id)).statusCode, 201);
  assert.equal((await addDependency(app, source2.id, t1.id)).statusCode, 201);
  const dependents = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${t1.id}/dependents` });
  const dependentItems = dependents.json().items as Array<{ artifactId: string; createdAt: string }>;
  assert.equal(dependentItems.length, 3);
  for (let i = 1; i < dependentItems.length; i += 1) {
    const previous = dependentItems[i - 1] as { artifactId: string; createdAt: string };
    const current = dependentItems[i] as { artifactId: string; createdAt: string };
    assert.ok(
      previous.createdAt > current.createdAt ||
      (previous.createdAt === current.createdAt && previous.artifactId >= current.artifactId),
      'dependents must be ordered by createdAt desc then artifactId desc'
    );
  }
  await app.close();
});

test('persists dependencies across restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artifact-mesh-'));
  const database = join(directory, 'artifact-mesh.sqlite');
  try {
    const first = await makeApp(database);
    const a = await registerArtifact(first, 'a');
    const b = await registerArtifact(first, 'b');
    const created = await addDependency(first, a.id, b.id);
    assert.equal(created.statusCode, 201);
    const record = created.json();
    await first.close();

    const second = await makeApp(database);
    const dependencies = await second.inject({ method: 'GET', url: `/api/v1/artifacts/${a.id}/dependencies` });
    assert.equal(dependencies.statusCode, 200);
    assert.deepEqual(dependencies.json().items, [record]);
    const dependents = await second.inject({ method: 'GET', url: `/api/v1/artifacts/${b.id}/dependents` });
    assert.deepEqual(dependents.json().items, [record]);
    // Cycle protection still works after reload.
    assert.equal((await addDependency(second, b.id, a.id)).statusCode, 400);
    await second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
