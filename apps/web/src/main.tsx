import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Artifact = { id: string; name: string; version: string; digest: string; mediaType: string; createdAt: string };
type HealthStatus = 'Connecting' | 'Operational' | 'Degraded' | 'Unavailable';
type DependencyCounts = Record<string, number | null>;

function App() {
  const [items, setItems] = useState<Artifact[]>([]);
  const [status, setStatus] = useState<HealthStatus>('Connecting');
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [dependencyCounts, setDependencyCounts] = useState<DependencyCounts>({});

  useEffect(() => {
    let cancelled = false;

    fetch('/health')
      .then((response) => response.json())
      .then((health: { status?: string }) => {
        if (!cancelled) setStatus(health.status === 'ok' ? 'Operational' : 'Degraded');
      })
      .catch(() => { if (!cancelled) setStatus('Unavailable'); });

    fetch('/api/v1/artifacts')
      .then(async (response) => {
        if (!response.ok) throw new Error(`artifacts request failed with HTTP ${response.status}`);
        const data = (await response.json()) as { items?: Artifact[] };
        return Array.isArray(data.items) ? data.items : [];
      })
      .then((artifacts) => {
        if (!cancelled) setItems(artifacts);
        return Promise.all(artifacts.map(async (artifact): Promise<readonly [string, number | null]> => {
          try {
            const response = await fetch(`/api/v1/artifacts/${encodeURIComponent(artifact.id)}/dependencies`);
            if (!response.ok) return [artifact.id, null] as const;
            const data = (await response.json()) as { items?: unknown[] };
            return [artifact.id, Array.isArray(data.items) ? data.items.length : null] as const;
          } catch {
            return [artifact.id, null] as const;
          }
        }));
      })
      .then((counts) => { if (!cancelled) setDependencyCounts(Object.fromEntries(counts)); })
      .catch(() => {
        if (!cancelled) setLoadError('Unable to load artifacts right now. The console stays available while the API is unreachable.');
      })
      .finally(() => { if (!cancelled) setLoaded(true); });

    return () => { cancelled = true; };
  }, []);

  return <main>
    <nav><div className="brand"><span className="mark">AM</span> ArtifactMesh</div><span className="environment">LOCAL REGISTRY</span></nav>
    <header>
      <div><p className="eyebrow">SOFTWARE SUPPLY CHAIN</p><h1>Artifacts you can trust.</h1><p className="lede">Register build outputs by immutable digest and inspect the versions available to your delivery teams.</p></div>
      <div className="health"><span className={status === 'Operational' ? 'pulse' : 'pulse danger'} /> API {status}</div>
    </header>
    <section className="metrics">
      <article><span>Artifacts</span><strong>{items.length}</strong><small>registered outputs</small></article>
      <article><span>Unique packages</span><strong>{new Set(items.map((item) => item.name)).size}</strong><small>across the registry</small></article>
      <article><span>Integrity</span><strong>SHA-256</strong><small>required for every artifact</small></article>
    </section>
    <section className="panel">
      <div className="panel-title"><div><p className="eyebrow">REGISTRY INDEX</p><h2>Recent artifacts</h2></div><code>GET /api/v1/artifacts</code></div>
      {loadError !== null ? <div className="empty"><div className="mesh">!</div><h3>Artifacts unavailable</h3><p>{loadError}</p></div>
        : !loaded ? <div className="empty"><div className="mesh">◇</div><h3>Loading artifacts…</h3><p>Fetching the registry index.</p></div>
        : items.length === 0 ? <div className="empty"><div className="mesh">◇</div><h3>No artifacts registered</h3><p>Use the public API to register your first immutable build output.</p></div>
        : <div className="table">{items.map((item) => {
          const count = dependencyCounts[item.id];
          return <div className="row" key={item.id}>
            <div><b>{item.name}</b><span>{item.mediaType}</span></div>
            <code>{item.version}</code>
            <code>{item.digest.slice(0, 18)}…</code>
            <div className="deps" title={count === null ? 'Dependency count unavailable' : 'Direct dependencies'}><b>{count ?? '—'}</b><span>direct deps.</span></div>
            <time>{new Date(item.createdAt).toLocaleString()}</time>
          </div>;
        })}</div>}
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
