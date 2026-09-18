import { buildApp } from './app.js';

const port = Number(process.env.PORT ?? 4300);
const host = process.env.HOST ?? '127.0.0.1';
const app = await buildApp({ database: process.env.ARTIFACT_MESH_DB });

await app.listen({ port, host });
console.log(`ArtifactMesh API listening on http://${host}:${port}`);
