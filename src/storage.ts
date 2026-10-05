import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pg from "pg";
import type { AppConfig } from "./config.js";

export type JsonRecord = Record<string, unknown>;

export interface KvStore {
  get(collection: string, id: string): Promise<JsonRecord | null>;
  put(collection: string, id: string, value: object): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  list(collection: string): Promise<Array<{ id: string; value: JsonRecord }>>;
}

type FileShape = Record<string, Record<string, JsonRecord>>;

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function createMemoryStore(): KvStore {
  const collections = new Map<string, Map<string, JsonRecord>>();
  const bucket = (collection: string) => {
    let map = collections.get(collection);
    if (!map) {
      map = new Map();
      collections.set(collection, map);
    }
    return map;
  };
  return {
    async get(collection, id) {
      const value = bucket(collection).get(id);
      return value ? clone(value) : null;
    },
    async put(collection, id, value) {
      bucket(collection).set(id, clone(value) as JsonRecord);
    },
    async delete(collection, id) {
      bucket(collection).delete(id);
    },
    async list(collection) {
      return [...bucket(collection).entries()].map(([id, value]) => ({ id, value: clone(value) }));
    }
  };
}

export function createFileStore(path: string): KvStore {
  if (!path) throw new Error("STORAGE_FILE is required when STORAGE_BACKEND=file");
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  const readAll = async (): Promise<FileShape> => {
    try {
      const text = await readFile(path, "utf8");
      const parsed = JSON.parse(text) as FileShape;
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  };
  const writeAll = async (data: FileShape) => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data));
    await rename(tmp, path);
  };
  return {
    get: (collection, id) => enqueue(async () => readAll().then((data) => {
      const value = data[collection]?.[id];
      return value ? clone(value) : null;
    })),
    put: (collection, id, value) => enqueue(async () => {
      const data = await readAll();
      data[collection] ??= {};
      data[collection][id] = clone(value) as JsonRecord;
      await writeAll(data);
    }),
    delete: (collection, id) => enqueue(async () => {
      const data = await readAll();
      if (data[collection]) delete data[collection][id];
      await writeAll(data);
    }),
    list: (collection) => enqueue(async () => {
      const data = await readAll();
      return Object.entries(data[collection] ?? {}).map(([id, value]) => ({ id, value: clone(value) }));
    })
  };
}

export function createPostgresStore(databaseUrl: string): KvStore {
  if (!databaseUrl) throw new Error("DATABASE_URL is required when STORAGE_BACKEND=postgres");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  let ready: Promise<void> | null = null;
  const ensure = () => {
    ready ??= pool.query(`
      CREATE TABLE IF NOT EXISTS rank_kv (
        collection text NOT NULL,
        id text NOT NULL,
        document jsonb NOT NULL,
        PRIMARY KEY (collection, id)
      )
    `).then(() => undefined);
    return ready;
  };
  return {
    async get(collection, id) {
      await ensure();
      const result = await pool.query<{ document: JsonRecord }>(
        "SELECT document FROM rank_kv WHERE collection = $1 AND id = $2",
        [collection, id]
      );
      return result.rows[0]?.document ?? null;
    },
    async put(collection, id, value) {
      await ensure();
      await pool.query(
        `INSERT INTO rank_kv (collection, id, document) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (collection, id) DO UPDATE SET document = EXCLUDED.document`,
        [collection, id, JSON.stringify(value)]
      );
    },
    async delete(collection, id) {
      await ensure();
      await pool.query("DELETE FROM rank_kv WHERE collection = $1 AND id = $2", [collection, id]);
    },
    async list(collection) {
      await ensure();
      const result = await pool.query<{ id: string; document: JsonRecord }>(
        "SELECT id, document FROM rank_kv WHERE collection = $1",
        [collection]
      );
      return result.rows.map((row) => ({ id: row.id, value: row.document }));
    }
  };
}

export function createStore(config: AppConfig): KvStore {
  if (config.storageBackend === "file") return createFileStore(config.storageFile);
  if (config.storageBackend === "postgres") return createPostgresStore(config.databaseUrl);
  return createMemoryStore();
}
