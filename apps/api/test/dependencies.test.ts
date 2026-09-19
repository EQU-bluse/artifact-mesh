import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildApp } from '../src/app.js';
import { createArtifactStore } from '../src/store.js';

type App = Awaited<ReturnType<typeof buildApp>>;

let digestCounter = 0;
const uniqueDigest = () => `sha256:${(++digestCounter).toString(16).padStart(64, '0')}`;

async function registerArtifact(app: App, name: string, version = '1.0.0') {
  const response = await app.inject({
    method: 'POST', url: '/api/v1/artifacts',
    payload: { name, version, mediaType: 'application/json', digest: uniqueDigest() }
  });
  assert.equal(response.statusCode, 201);
  return response.json() as { id: string; name: string; createdAt: string };
}

const addEdge = (app: App, id: string, body: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/v1/artifacts/${id}/dependencies`, payload: body });

const addRawEdge = (app: App, id: string, payload: string) =>
  app.inject({ method: 'POST', url: `/api/v1/artifacts/${id}/dependencies`, payload, headers: { 'content-type': 'application/json' } });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('creates a dependency edge and reads it back', async () => {
  const app = await buildApp({ database: ':memory:' });
  const gateway = await registerArtifact(app, 'gateway');
  const runtime = await registerArtifact(app, 'runtime');

  const created = await addEdge(app, gateway.id, { artifactId: runtime.id });
  assert.equal(created.statusCode, 201);
  const record = created.json();
  assert.deepEqual(Object.keys(record).sort(), ['artifactId', 'createdAt', 'dependsOnId']);
  assert.equal(record.artifactId, gateway.id);
  assert.equal(record.dependsOnId, runtime.id);
  assert.match(record.createdAt, /^\d{4}-\d{2}-\d{2}T/);

  const dependencies = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${gateway.id}/dependencies` });
  assert.equal(dependencies.statusCode, 200);
  assert.deepEqual(dependencies.json().items, [record]);

  const dependents = await app.inject({ method: 'GET', url: `/api/v1/artifacts/${runtime.id}/dependents` });
  assert.equal(dependents.statusCode, 200);
  assert.deepEqual(dependents.json().items, [record]);
  await app.close();
});

test('queries are ordered by createdAt descending', async () => {
  const app = await buildApp({ database: ':memory:' });
  const base = await registerArtifact(app, 'base');
  const a = await registerArtifact(app, 'package-a');
  const b = await registerArtifact(app, 'package-b');

  const first = (await addEdge(app, a.id, { artifactId: base.id })).json();
  await sleep(5);
  const second = (await addEdge(app, b.id, { artifactId: base.id })).json();
  assert.notEqual(first.createdAt, second.createdAt);

  const dependents = (await app.inject({ method: 'GET', url: `/api/v1/artifacts/${base.id}/dependents` })).json();
  assert.deepEqual(dependents.items.map((item: { artifactId: string }) => item.artifactId), [b.id, a.id]);
  await app.close();
});

test('ties on createdAt fall back to the other endpoint id descending', () => {
  const directory = mkdtempSync(join(tmpdir(), 'artifact-mesh-order-'));
  try {
    const database = join(directory, 'mesh.sqlite');
    const store = createArtifactStore(database);
    const center = store.create({ name: 'center', version: '1.0.0', digest: uniqueDigest(), mediaType: 'application/json' });
    const x = store.create({ name: 'x', version: '1.0.0', digest: uniqueDigest(), mediaType: 'application/json' });
    const y = store.create({ name: 'y', version: '1.0.0', digest: uniqueDigest(), mediaType: 'application/json' });
    const stamped = new Date('2026-01-01T00:00:00.000Z').toISOString();

    // Insert same-timestamp edges directly so ordering relies on the id tie-break.
    const raw = new DatabaseSync(database);
    raw.exec('PRAGMA foreign_keys = ON');
    const insert = raw.prepare('INSERT INTO artifact_dependencies (artifact_id, depends_on_id, created_at) VALUES (?, ?, ?)');
    insert.run(center.id, x.id, stamped);
    insert.run(center.id, y.id, stamped);
    insert.run(x.id, center.id, stamped);
    insert.run(y.id, center.id, stamped);

    const expectedTargetOrder = [x.id, y.id].sort().reverse();
    assert.deepEqual(store.dependencies(center.id).map((item) => item.dependsOnId), expectedTargetOrder);
    const expectedSourceOrder = [x.id, y.id].sort().reverse();
    assert.deepEqual(store.dependents(center.id).map((item) => item.artifactId), expectedSourceOrder);

    raw.close();
    store.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('rejects a duplicate relation with 409', async () => {
  const app = await buildApp({ database: ':memory:' });
  const gateway = await registerArtifact(app, 'gateway2');
  const runtime = await registerArtifact(app, 'runtime2');

  assert.equal((await addEdge(app, gateway.id, { artifactId: runtime.id })).statusCode, 201);
  const duplicate = await addEdge(app, gateway.id, { artifactId: runtime.id });
  assert.equal(duplicate.statusCode, 409);

  // Only one edge exists despite the rejected attempt.
  const dependencies = (await app.inject({ method: 'GET', url: `/api/v1/artifacts/${gateway.id}/dependencies` })).json();
  assert.equal(dependencies.items.length, 1);
  await app.close();
});

test('rejects a self dependency with 400', async () => {
  const app = await buildApp({ database: ':memory:' });
  const solo = await registerArtifact(app, 'solo');
  const response = await addEdge(app, solo.id, { artifactId: solo.id });
  assert.equal(response.statusCode, 400);
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/v1/artifacts/${solo.id}/dependencies` })).json().items, []);
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/v1/artifacts/${solo.id}/dependents` })).json().items, []);
  await app.close();
});

test('rejects a cycle spanning multiple edges with 400', async () => {
  const app = await buildApp({ database: ':memory:' });
  const a = await registerArtifact(app, 'cyc-a');
  const b = await registerArtifact(app, 'cyc-b');
  const c = await registerArtifact(app, 'cyc-c');

  assert.equal((await addEdge(app, a.id, { artifactId: b.id })).statusCode, 201);
  assert.equal((await addEdge(app, b.id, { artifactId: c.id })).statusCode, 201);
  const closing = await addEdge(app, c.id, { artifactId: a.id });
  assert.equal(closing.statusCode, 400);

  // The rejected edge was not stored; existing edges remain.
  assert.deepEqual((await app.inject({ method: 'GET', url: `/api/v1/artifacts/${c.id}/dependencies` })).json().items, []);
  assert.equal((await app.inject({ method: 'GET', url: `/api/v1/artifacts/${b.id}/dependencies` })).json().items.length, 1);

  // An unrelated edge on the same graph is accepted, and closing the shorter path still fails.
  assert.equal((await addEdge(app, a.id, { artifactId: c.id })).statusCode, 201);
  assert.equal((await addEdge(app, c.id, { artifactId: a.id })).statusCode, 400);

  // Reverse direction of an existing edge would also create the same cycle.
  assert.equal((await addEdge(app, b.id, { artifactId: a.id })).statusCode, 400);
  await app.close();
});

test('returns 404 when the path or target artifact does not exist', async () => {
  const app = await buildApp({ database: ':memory:' });
  const real = await registerArtifact(app, 'lone');

  assert.equal((await addEdge(app, 'does-not-exist', { artifactId: real.id })).statusCode, 404);
  assert.equal((await addEdge(app, real.id, { artifactId: 'does-not-exist' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/artifacts/does-not-exist/dependencies' })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/api/v1/artifacts/does-not-exist/dependents' })).statusCode, 404);
  await app.close();
});

test('returns 400 when artifactId is missing or not a string', async () => {
  const app = await buildApp({ database: ':memory:' });
  const a = await registerArtifact(app, 'valid-a');
  const b = await registerArtifact(app, 'valid-b');

  assert.equal((await addEdge(app, a.id, {})).statusCode, 400);
  assert.equal((await addEdge(app, a.id, { artifactId: 123 })).statusCode, 400);
  assert.equal((await addEdge(app, a.id, { artifactId: [b.id] })).statusCode, 400);
  assert.equal((await addEdge(app, a.id, { artifactId: null })).statusCode, 400);
  assert.equal((await addRawEdge(app, a.id, 'null')).statusCode, 400);
  await app.close();
});

test('persists relations across restarts', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'artifact-mesh-persist-'));
  try {
    const database = join(directory, 'mesh.sqlite');
    const first = await buildApp({ database });
    const a = await registerArtifact(first, 'persist-a');
    const b = await registerArtifact(first, 'persist-b');
    const record = (await addEdge(first, a.id, { artifactId: b.id })).json();
    await first.close();

    const second = await buildApp({ database });
    const dependencies = (await second.inject({ method: 'GET', url: `/api/v1/artifacts/${a.id}/dependencies` })).json();
    assert.deepEqual(dependencies.items, [record]);
    const dependents = (await second.inject({ method: 'GET', url: `/api/v1/artifacts/${b.id}/dependents` })).json();
    assert.deepEqual(dependents.items, [record]);
    // The cycle guard still works with data loaded from disk.
    assert.equal((await addEdge(second, b.id, { artifactId: a.id })).statusCode, 400);
    await second.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
