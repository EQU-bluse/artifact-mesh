import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Artifact = {
  id: string;
  name: string;
  version: string;
  digest: string;
  mediaType: string;
  createdAt: string;
};

export type NewArtifact = Pick<Artifact, 'name' | 'version' | 'digest' | 'mediaType'>;

export function createArtifactStore(filename: string) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      digest TEXT NOT NULL UNIQUE,
      media_type TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(name, version)
    ) STRICT;
  `);

  const list = db.prepare(`
    SELECT id, name, version, digest, media_type AS mediaType, created_at AS createdAt
    FROM artifacts ORDER BY created_at DESC, id DESC
  `);
  const insert = db.prepare(`
    INSERT INTO artifacts (id, name, version, digest, media_type, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  return {
    list(): Artifact[] {
      return list.all() as unknown as Artifact[];
    },
    create(input: NewArtifact): Artifact {
      const artifact = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
      insert.run(artifact.id, artifact.name, artifact.version, artifact.digest, artifact.mediaType, artifact.createdAt);
      return artifact;
    },
    close(): void {
      db.close();
    }
  };
}

export type ArtifactStore = ReturnType<typeof createArtifactStore>;
