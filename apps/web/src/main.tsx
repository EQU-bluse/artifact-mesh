import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Artifact = { id: string; name: string; version: string; digest: string; mediaType: string; createdAt: string };
type DependencyRecord = { artifactId: string; dependsOnId: string; createdAt: string };

function App() {
  const [items, setItems] = useState<Artifact[]>([]);
  const [dependencyCounts, setDependencyCounts] = useState<Record<string, number>>({});
  const [countsUnavailable, setCountsUnavailable] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState('Connecting');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [healthResult, artifactsResult] = await Promise.allSettled([
        fetch('/health').then((response) => response.json()),
        fetch('/api/v1/artifacts').then((response) => response.json())
      ]);
      if (cancelled) return;
      if (healthResult.status === 'fulfilled') {
        setStatus(healthResult.value?.status === 'ok' ? 'Operational' : 'Degraded');
      } else {
        setStatus('Unavailable');
      }
      if (artifactsResult.status !== 'fulfilled' || !Array.isArray(artifactsResult.value?.items)) {
        setLoadError(true);
        return;
      }
      const artifacts = artifactsResult.value.items as Artifact[];
      setItems(artifacts);

      const countResults = await Promise.allSettled(artifacts.map((item) =>
        fetch(`/api/v1/artifacts/${encodeURIComponent(item.id)}/dependencies`).then(async (response) => {
          if (!response.ok) throw new Error(`dependencies request failed: ${response.status}`);
          const payload: { items?: DependencyRecord[] } = await response.json();
          return Array.isArray(payload.items) ? payload.items.length : 0;
        })
      ));
      if (cancelled) return;
      const nextCounts: Record<string, number> = {};
      let anyFailed = false;
      countResults.forEach((result, index) => {
        const id = artifacts[index]?.id;
        if (result.status === 'fulfilled' && id !== undefined) nextCounts[id] = result.value;
        else anyFailed = true;
      });
      setDependencyCounts(nextCounts);
      setCountsUnavailable(anyFailed);
    })();
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
      {loadError ? <div className="empty"><div className="mesh">!</div><h3>Could not load artifacts</h3><p>The registry is not responding right now. Health status is still shown above.</p></div>
        : items.length === 0 ? <div className="empty"><div className="mesh">◇</div><h3>No artifacts registered</h3><p>Use the public API to register your first immutable build output.</p></div> :
        <div className="table">{items.map((item) => {
          const count = dependencyCounts[item.id];
          return <div className="row" key={item.id}>
            <div><b>{item.name}</b><span>{item.mediaType}</span></div>
            <code>{item.version}</code>
            <code>{item.digest.slice(0, 18)}…</code>
            <div className="deps" title={count === undefined ? 'Dependency data unavailable' : `Direct dependencies of ${item.name} ${item.version}`}>
              {count === undefined ? <span className="deps-unknown">—</span> : <><b>{count}</b><small>dependencies</small></>}
            </div>
            <time>{new Date(item.createdAt).toLocaleString()}</time>
          </div>;
        })}</div>}
      {countsUnavailable && !loadError && items.length > 0 ? <p className="deps-warning">Dependency counts are partially unavailable.</p> : null}
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
