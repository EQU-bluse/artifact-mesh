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
