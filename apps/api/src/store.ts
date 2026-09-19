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

export class DependencyError extends Error {
  constructor(public readonly code: 'not_found' | 'self_dependency' | 'duplicate' | 'cycle', message: string) {
    super(message);
    this.name = 'DependencyError';
  }
}

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
  db.exec(`
    CREATE TABLE IF NOT EXISTS dependencies (
      artifact_id TEXT NOT NULL,
      depends_on_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (artifact_id, depends_on_id),
      FOREIGN KEY (artifact_id) REFERENCES artifacts(id),
      FOREIGN KEY (depends_on_id) REFERENCES artifacts(id)
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
  const getById = db.prepare(`
    SELECT id, name, version, digest, media_type AS mediaType, created_at AS createdAt
    FROM artifacts WHERE id = ?
  `);
  const insertDependency = db.prepare(`
    INSERT INTO dependencies (artifact_id, depends_on_id, created_at)
    VALUES (?, ?, ?)
  `);
  const getDependency = db.prepare(`
    SELECT artifact_id AS artifactId, depends_on_id AS dependsOnId, created_at AS createdAt
    FROM dependencies WHERE artifact_id = ? AND depends_on_id = ?
  `);
  const outgoingEdges = db.prepare(`SELECT depends_on_id AS dependsOnId FROM dependencies WHERE artifact_id = ?`);
  const listDependencies = db.prepare(`
    SELECT artifact_id AS artifactId, depends_on_id AS dependsOnId, created_at AS createdAt
    FROM dependencies WHERE artifact_id = ?
    ORDER BY created_at DESC, depends_on_id DESC
  `);
  const listDependents = db.prepare(`
    SELECT artifact_id AS artifactId, depends_on_id AS dependsOnId, created_at AS createdAt
    FROM dependencies WHERE depends_on_id = ?
    ORDER BY created_at DESC, artifact_id DESC
  `);

  type EdgeRow = { dependsOnId: string };

  function artifactExists(id: string): boolean {
    return getById.get(id) !== undefined;
  }

  /**
   * Returns true when `candidate` is already reachable from `start` by
   * following dependency edges (i.e. `start` depends, directly or
   * transitively, on `candidate`).
   */
  function reaches(start: string, candidate: string): boolean {
    const seen = new Set<string>([start]);
    const pending = [start];
    while (pending.length > 0) {
      const current = pending.pop() as string;
      for (const edge of outgoingEdges.all(current) as unknown as EdgeRow[]) {
        if (edge.dependsOnId === candidate) return true;
        if (!seen.has(edge.dependsOnId)) {
          seen.add(edge.dependsOnId);
          pending.push(edge.dependsOnId);
        }
      }
    }
    return false;
  }

  return {
    list(): Artifact[] {
      return list.all() as unknown as Artifact[];
    },
    create(input: NewArtifact): Artifact {
      const artifact = { id: randomUUID(), ...input, createdAt: new Date().toISOString() };
      insert.run(artifact.id, artifact.name, artifact.version, artifact.digest, artifact.mediaType, artifact.createdAt);
      return artifact;
    },
    addDependency(artifactId: string, dependsOnId: string): Dependency {
      if (!artifactExists(artifactId) || !artifactExists(dependsOnId)) {
        throw new DependencyError('not_found', 'artifact does not exist');
      }
      if (artifactId === dependsOnId) {
        throw new DependencyError('self_dependency', 'an artifact cannot depend on itself');
      }
      if (getDependency.get(artifactId, dependsOnId) !== undefined) {
        throw new DependencyError('duplicate', 'dependency already exists');
      }
      // Adding artifactId -> dependsOnId closes a cycle when dependsOnId can
      // already reach artifactId through existing edges.
      if (reaches(dependsOnId, artifactId)) {
        throw new DependencyError('cycle', 'dependency would create a cycle');
      }
      const record = { artifactId, dependsOnId, createdAt: new Date().toISOString() };
      insertDependency.run(record.artifactId, record.dependsOnId, record.createdAt);
      return record;
    },
    dependenciesOf(artifactId: string): Dependency[] {
      return listDependencies.all(artifactId) as unknown as Dependency[];
    },
    dependentsOf(artifactId: string): Dependency[] {
      return listDependents.all(artifactId) as unknown as Dependency[];
    },
    exists(artifactId: string): boolean {
      return artifactExists(artifactId);
    },
    close(): void {
      db.close();
    }
  };
}

export type ArtifactStore = ReturnType<typeof createArtifactStore>;
