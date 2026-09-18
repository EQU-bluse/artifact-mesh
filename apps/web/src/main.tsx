import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Artifact = { id: string; name: string; version: string; digest: string; mediaType: string; createdAt: string };

function App() {
  const [items, setItems] = useState<Artifact[]>([]);
  const [status, setStatus] = useState('Connecting');

  useEffect(() => {
    Promise.all([
      fetch('/health').then((response) => response.json()),
      fetch('/api/v1/artifacts').then((response) => response.json())
    ]).then(([health, artifacts]) => {
      setStatus(health.status === 'ok' ? 'Operational' : 'Degraded');
      setItems(artifacts.items);
    }).catch(() => setStatus('Unavailable'));
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
      {items.length === 0 ? <div className="empty"><div className="mesh">◇</div><h3>No artifacts registered</h3><p>Use the public API to register your first immutable build output.</p></div> :
        <div className="table">{items.map((item) => <div className="row" key={item.id}><div><b>{item.name}</b><span>{item.mediaType}</span></div><code>{item.version}</code><code>{item.digest.slice(0, 18)}…</code><time>{new Date(item.createdAt).toLocaleString()}</time></div>)}</div>}
    </section>
  </main>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
