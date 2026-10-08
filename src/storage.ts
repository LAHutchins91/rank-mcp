import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BlobNotFoundError, BlobPreconditionFailedError, get, put } from "@vercel/blob";
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

/** Auth codes, Google sign-in sessions, and issued MCP tokens. Users are kept. */
const EXPIRING_COLLECTIONS = ["auth_codes", "pending_auth", "access_tokens", "refresh_tokens"] as const;
const BLOB_WRITE_ATTEMPTS = 5;

export interface BlobStoreClient {
  get(pathname: string, options: { access: "private"; useCache: false }): Promise<{
    stream: ReadableStream<Uint8Array> | null;
    blob: { etag: string };
  } | null>;
  put(pathname: string, body: string, options: {
    access: "private";
    allowOverwrite: true;
    addRandomSuffix: false;
    contentType: "application/json";
    ifMatch?: string;
  }): Promise<{ etag: string }>;
}

const defaultBlobClient: BlobStoreClient = {
  get: (pathname, options) => get(pathname, options),
  put: (pathname, body, options) => put(pathname, body, options)
};

function isNotFound(error: unknown) {
  return error instanceof BlobNotFoundError || (error instanceof Error && error.name === "BlobNotFoundError");
}

function isPreconditionFailed(error: unknown) {
  return error instanceof BlobPreconditionFailedError || (error instanceof Error && error.name === "BlobPreconditionFailedError");
}

function removeExpiredDocuments(data: FileShape, nowMs: number) {
  for (const collection of EXPIRING_COLLECTIONS) {
    const bucket = data[collection];
    if (!bucket) continue;
    for (const [id, value] of Object.entries(bucket)) {
      const expiresAt = value?.expiresAt;
      if (typeof expiresAt !== "string") continue;
      const time = Date.parse(expiresAt);
      if (Number.isFinite(time) && time <= nowMs) delete bucket[id];
    }
  }
}

export function createBlobStore(path: string, client: BlobStoreClient = defaultBlobClient): KvStore {
  if (!path) throw new Error("STORAGE_BLOB_PATH is required when STORAGE_BACKEND=blob");
  let chain: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(fn: () => Promise<T>) => {
    const run = chain.then(fn, fn);
    chain = run.then(() => undefined, () => undefined);
    return run;
  };
  const readAll = async (): Promise<{ data: FileShape; etag?: string }> => {
    let result: Awaited<ReturnType<BlobStoreClient["get"]>>;
    try {
      result = await client.get(path, { access: "private", useCache: false });
    } catch (error) {
      if (isNotFound(error)) return { data: {} };
      throw error;
    }
    if (!result) return { data: {} };
    if (!result.stream) return { data: {}, etag: result.blob.etag };
    const text = await new Response(result.stream).text();
    const etag = result.blob.etag;
    if (!text) return { data: {}, etag };
    const parsed = JSON.parse(text) as FileShape;
    const data = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    return { data, etag };
  };
  const writeAll = async (data: FileShape, etag?: string) => {
    await client.put(path, JSON.stringify(data), {
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json",
      ...(etag ? { ifMatch: etag } : {})
    });
  };
  const commit = async (change: (data: FileShape) => void) => {
    let lastError: unknown;
    for (let attempt = 0; attempt < BLOB_WRITE_ATTEMPTS; attempt++) {
      const { data, etag } = await readAll();
      change(data);
      removeExpiredDocuments(data, Date.now());
      try {
        await writeAll(data, etag);
        return;
      } catch (error) {
        lastError = error;
        const name = error instanceof Error ? (error.constructor?.name && error.constructor.name !== "Error" ? error.constructor.name : error.name) : typeof error;
        const message = error instanceof Error ? error.message.slice(0, 300) : "";
        console.error(JSON.stringify({ event: "storage_write_failed", attempt, name, message }));
        if (!isPreconditionFailed(error) || attempt === BLOB_WRITE_ATTEMPTS - 1) throw error;
      }
    }
    throw lastError;
  };
  return {
    get: (collection, id) => enqueue(async () => {
      const { data } = await readAll();
      const value = data[collection]?.[id];
      return value ? clone(value) : null;
    }),
    put: (collection, id, value) => enqueue(() => commit((data) => {
      data[collection] ??= {};
      data[collection][id] = clone(value) as JsonRecord;
    })),
    delete: (collection, id) => enqueue(() => commit((data) => {
      if (data[collection]) delete data[collection][id];
    })),
    list: (collection) => enqueue(async () => {
      const { data } = await readAll();
      return Object.entries(data[collection] ?? {}).map(([id, value]) => ({ id, value: clone(value) }));
    })
  };
}

export function createStore(config: AppConfig): KvStore {
  if (config.storageBackend === "file") return createFileStore(config.storageFile);
  if (config.storageBackend === "postgres") return createPostgresStore(config.databaseUrl);
  if (config.storageBackend === "blob") return createBlobStore(config.storageBlobPath);
  return createMemoryStore();
}
