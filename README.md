# ArtifactMesh

ArtifactMesh is a small software-artifact registry for development teams. It exposes an HTTP API and a browser console for registering and inspecting build outputs.

## Run

Requires Node.js 24 or newer.

```bash
npm install
npm run dev
```

The web console runs at `http://localhost:5173` and the API at `http://localhost:4300`.

## Checks

```bash
npm test
npm run typecheck
npm run build
```

## Public API

- `GET /health`
- `GET /api/v1/artifacts`
- `POST /api/v1/artifacts`
- `POST /api/v1/artifacts/:id/dependencies` — body `{ "artifactId": "<target>" }`, records that the path artifact depends on the target; `201` with `{ artifactId, dependsOnId, createdAt }`
- `GET /api/v1/artifacts/:id/dependencies` — outgoing relations (`{ items: [...] }`, newest first)
- `GET /api/v1/artifacts/:id/dependents` — incoming relations (`{ items: [...] }`, newest first)

Dependency edges are persisted in SQLite. Unknown artifacts return `404`; a missing/non-string `artifactId`, self-dependency, or any edge that would close a cycle returns `400`; a duplicate edge returns `409`.
