import assert from 'node:assert/strict';
import test from 'node:test';
import { buildApp } from '../src/app.js';

test('registers and lists an artifact', async () => {
  const app = await buildApp({ database: ':memory:' });
  const input = {
    name: 'gateway', version: '1.0.0', mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest: `sha256:${'a'.repeat(64)}`
  };
  const created = await app.inject({ method: 'POST', url: '/api/v1/artifacts', payload: input });
  assert.equal(created.statusCode, 201);
  const listed = await app.inject({ method: 'GET', url: '/api/v1/artifacts' });
  assert.equal(listed.statusCode, 200);
  assert.deepEqual(listed.json().items[0], { ...input, id: created.json().id, createdAt: created.json().createdAt });
  await app.close();
});

test('rejects malformed digests', async () => {
  const app = await buildApp({ database: ':memory:' });
  const response = await app.inject({ method: 'POST', url: '/api/v1/artifacts', payload: {
    name: 'gateway', version: '1.0.0', mediaType: 'application/json', digest: 'latest'
  } });
  assert.equal(response.statusCode, 400);
  await app.close();
});
