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

export type Dependency = {
  artifactId: string;
  dependsOnId: string;
  createdAt: string;
};

export type DependencyErrorCode =
  | 'ARTIFACT_NOT_FOUND'
  | 'SELF_DEPENDENCY'
  | 'DUPLICATE_RELATION'
  | 'CYCLE';

export class DependencyError extends Error {
  constructor(readonly code: DependencyErrorCode) {
    super(code);
    this.name = 'DependencyError';
  }
}

export function createArtifactStore(filename: string) {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec('PRAGMA foreign_keys = ON');
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_dependencies (
      artifact_id TEXT NOT NULL REFERENCES artifacts(id),
      depends_on_id TEXT NOT NULL REFERENCES artifacts(id),
      created_at TEXT NOT NULL,
      PRIMARY KEY (artifact_id, depends_on_id)
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
  const artifactExists = db.prepare(`SELECT 1 FROM artifacts WHERE id = ?`);
  const isKnown = (id: string): boolean => artifactExists.get(id) !== undefined;
  const edgeExists = db.prepare(`
    SELECT 1 FROM artifact_dependencies WHERE artifact_id = ? AND depends_on_id = ?
  `);
  // Walks outgoing edges from the first id; a row means it can reach the second id.
  const reaches = db.prepare(`
    WITH RECURSIVE reach(id) AS (
      SELECT ?
      UNION
      SELECT d.depends_on_id FROM artifact_dependencies d JOIN reach r ON d.artifact_id = r.id
    )
    SELECT 1 FROM reach WHERE id = ? LIMIT 1
  `);
  const insertEdge = db.prepare(`
    INSERT INTO artifact_dependencies (artifact_id, depends_on_id, created_at)
    VALUES (?, ?, ?)
  `);
  const listDependencies = db.prepare(`
    SELECT artifact_id AS artifactId, depends_on_id AS dependsOnId, created_at AS createdAt
    FROM artifact_dependencies WHERE artifact_id = ?
    ORDER BY created_at DESC, depends_on_id DESC
  `);
  const listDependents = db.prepare(`
    SELECT artifact_id AS artifactId, depends_on_id AS dependsOnId, created_at AS createdAt
    FROM artifact_dependencies WHERE depends_on_id = ?
    ORDER BY created_at DESC, artifact_id DESC
  `);

  return {
    list(): Artifact[] {
      return list.all() as unknown as Artifact[];
    },
    exists(id: string): boolean {
      return artifactExists.get(id) !== undefined;
    },
    create(input: NewArtifact): Artifact {
      const artifact = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
      insert.run(artifact.id, artifact.name, artifact.version, artifact.digest, artifact.mediaType, artifact.createdAt);
      return artifact;
    },
    addDependency(artifactId: string, dependsOnId: string): Dependency {
      if (artifactId === dependsOnId) throw new DependencyError('SELF_DEPENDENCY');
      if (!isKnown(artifactId) || !isKnown(dependsOnId)) {
        throw new DependencyError('ARTIFACT_NOT_FOUND');
      }
      if (edgeExists.get(artifactId, dependsOnId) !== undefined) {
        throw new DependencyError('DUPLICATE_RELATION');
      }
      // Adding artifactId -> dependsOnId closes a cycle iff dependsOnId already reaches artifactId.
      if (reaches.get(dependsOnId, artifactId) !== undefined) {
        throw new DependencyError('CYCLE');
      }
      const createdAt = new Date().toISOString();
      insertEdge.run(artifactId, dependsOnId, createdAt);
      return { artifactId, dependsOnId, createdAt };
    },
    dependencies(id: string): Dependency[] {
      return listDependencies.all(id) as unknown as Dependency[];
    },
    dependents(id: string): Dependency[] {
      return listDependents.all(id) as unknown as Dependency[];
    },
    close(): void {
      db.close();
    }
  };
}

export type ArtifactStore = ReturnType<typeof createArtifactStore>;
