import { readFileSync } from "node:fs";
import { BlobNotFoundError, BlobPreconditionFailedError } from "@vercel/blob";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { BlobStaleReadError, createBlobStore, type BlobStoreClient } from "../src/storage.js";

type Stored = { body: string | null; etag: string };

function jsonStream(body: string) {
  return new Blob([body]).stream();
}

const BLOB_URL = "https://store.private.blob.vercel-storage.com/rank/store.json";

function mockBlob(initial?: Stored) {
  const state: Stored = initial ?? { body: null, etag: "" };
  // Simulates what a GET returns: by default the current bytes and etag, or a stale CDN copy, or a quoted ETag header.
  let served: ((pathname: string) => Stored) | null = null;
  const gets: Array<{ pathname: string; options: { access: string; useCache: boolean } }> = [];
  const puts: Array<{ pathname: string; body: string; options: { access: string; allowOverwrite: boolean; addRandomSuffix: boolean; contentType: string; ifMatch?: string } }> = [];
  let failPuts = 0;
  let onFailedPut: (() => void) | null = null;
  const client: BlobStoreClient = {
    async head() {
      return state.body === null ? null : { etag: state.etag, url: BLOB_URL };
    },
    async get(pathname, options) {
      gets.push({ pathname, options });
      if (state.body === null) return null;
      const view = served ? served(pathname) : state;
      return { stream: jsonStream(view.body ?? ""), blob: { etag: view.etag } };
    },
    async put(pathname, body, options) {
      puts.push({ pathname, body, options });
      if (failPuts > 0) {
        failPuts -= 1;
        onFailedPut?.();
        throw new BlobPreconditionFailedError();
      }
      if (state.body !== null && options.ifMatch !== state.etag) throw new BlobPreconditionFailedError();
      state.body = body;
      state.etag = `etag-${puts.length}`;
      return { etag: state.etag };
    }
  };
  return {
    state,
    gets,
    puts,
    client,
    serve(fn: (pathname: string) => Stored) {
      served = fn;
    },
    failNext(count: number, effect?: () => void) {
      failPuts = count;
      onFailedPut = effect ?? null;
    }
  };
}

describe("blob storage", () => {
  it("reads a missing blob as empty and writes the file-store document", async () => {
    const blob = mockBlob();
    const store = createBlobStore("rank/store.json", blob.client);
    expect(await store.get("users", "owner")).toBeNull();
    await store.put("users", "owner", { id: "owner", email: "owner@example.com" });
    await store.put("auth_codes", "code-hash", { userId: "owner", expiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(blob.gets[0]?.options).toEqual({ access: "private", useCache: false });
    expect(blob.puts[0]?.options).toMatchObject({
      access: "private",
      allowOverwrite: true,
      addRandomSuffix: false,
      contentType: "application/json"
    });
    expect(blob.puts[0]?.options.ifMatch).toBeUndefined();
    expect(blob.puts[1]?.options.ifMatch).toBe("etag-1");
    const document = JSON.parse(blob.state.body ?? "{}") as { users: { owner: { email: string } }; auth_codes: { "code-hash": { userId: string } } };
    expect(document.users.owner.email).toBe("owner@example.com");
    expect(document.auth_codes["code-hash"].userId).toBe("owner");
    expect(await store.list("users")).toEqual([{ id: "owner", value: { id: "owner", email: "owner@example.com" } }]);
    await store.delete("users", "owner");
    expect(await store.get("users", "owner")).toBeNull();
  });

  it("treats BlobNotFoundError as an empty document", async () => {
    const client: BlobStoreClient = {
      async head() {
        return null;
      },
      async get() {
        throw new BlobNotFoundError();
      },
      async put() {
        return { etag: "etag-1" };
      }
    };
    const store = createBlobStore("rank/store.json", client);
    expect(await store.get("pending_auth", "signin")).toBeNull();
  });

  it("keeps oauth codes and pending Google sign-in across store instances", async () => {
    const blob = mockBlob();
    const future = new Date(Date.now() + 60_000).toISOString();
    const writer = createBlobStore("rank/store.json", blob.client);
    await writer.put("auth_codes", "code-hash", { userId: "owner", redirectUri: "http://127.0.0.1/callback", expiresAt: future });
    await writer.put("pending_auth", "signin", { kind: "account", returnTo: "/account", expiresAt: future });
    const reader = createBlobStore("rank/store.json", blob.client);
    expect(await reader.get("auth_codes", "code-hash")).toMatchObject({ userId: "owner" });
    expect(await reader.get("pending_auth", "signin")).toMatchObject({ kind: "account", returnTo: "/account" });
  });

  it("drops expired auth codes, sign-in sessions, and tokens on write", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    const future = new Date(Date.now() + 60_000).toISOString();
    const blob = mockBlob({
      etag: "etag-seed",
      body: JSON.stringify({
        auth_codes: { old: { expiresAt: past, userId: "a" }, live: { expiresAt: future, userId: "b" } },
        access_tokens: { old: { expiresAt: past, userId: "a" } },
        refresh_tokens: { old: { expiresAt: past, userId: "a" } },
        pending_auth: { old: { expiresAt: past, kind: "account" }, live: { expiresAt: future, kind: "mcp" } },
        users: { owner: { id: "owner" } }
      })
    });
    const store = createBlobStore("rank/store.json", blob.client);
    await store.put("users", "owner", { id: "owner", email: "owner@example.com" });
    const saved = JSON.parse(blob.state.body ?? "{}") as Record<string, Record<string, { userId?: string; kind?: string; email?: string }>>;
    expect(saved.auth_codes?.old).toBeUndefined();
    expect(saved.auth_codes?.live?.userId).toBe("b");
    expect(saved.access_tokens?.old).toBeUndefined();
    expect(saved.refresh_tokens?.old).toBeUndefined();
    expect(saved.pending_auth?.old).toBeUndefined();
    expect(saved.pending_auth?.live?.kind).toBe("mcp");
    expect(saved.users?.owner?.email).toBe("owner@example.com");
    expect(blob.puts[0]?.options.ifMatch).toBe("etag-seed");
  });

  it("re-reads and retries when the blob etag changed", async () => {
    const blob = mockBlob();
    blob.failNext(1, () => {
      blob.state.body = JSON.stringify({ users: { other: { id: "other" } } });
      blob.state.etag = "etag-other";
    });
    const store = createBlobStore("rank/store.json", blob.client);
    await store.put("users", "me", { id: "me" });
    const saved = JSON.parse(blob.state.body ?? "{}") as { users: Record<string, { id: string }> };
    expect(saved.users.other?.id).toBe("other");
    expect(saved.users.me?.id).toBe("me");
    expect(blob.puts).toHaveLength(2);
    expect(blob.puts[1]?.options.ifMatch).toBe("etag-other");
  });

  it("stops after a few precondition failures", async () => {
    const blob = mockBlob({ body: "{}", etag: "etag-seed" });
    blob.failNext(5);
    const store = createBlobStore("rank/store.json", blob.client);
    await expect(store.put("users", "me", { id: "me" })).rejects.toBeInstanceOf(BlobPreconditionFailedError);
    expect(blob.puts).toHaveLength(5);
  });

  it("writes with the API etag when the GET ETag header is quoted", async () => {
    const blob = mockBlob({ body: JSON.stringify({ users: { other: { id: "other" } } }), etag: "etag-seed" });
    blob.serve(() => ({ body: blob.state.body, etag: `"${blob.state.etag}"` }));
    const store = createBlobStore("rank/store.json", blob.client);
    await store.put("pending_auth", "signin", { kind: "account" });
    expect(blob.puts).toHaveLength(1);
    expect(blob.puts[0]?.options.ifMatch).toBe("etag-seed");
    const saved = JSON.parse(blob.state.body ?? "{}") as Record<string, Record<string, unknown>>;
    expect(saved.users?.other).toEqual({ id: "other" });
    expect(saved.pending_auth?.signin).toEqual({ kind: "account" });
  });

  it("re-reads a versioned URL when the plain GET is a stale cached copy", async () => {
    const stale: Stored = { body: JSON.stringify({ users: {} }), etag: "etag-old" };
    const blob = mockBlob({ body: JSON.stringify({ users: { other: { id: "other" } } }), etag: "etag-new" });
    blob.serve((pathname) => (pathname.includes("?v=") ? blob.state : stale));
    const store = createBlobStore("rank/store.json", blob.client);
    await store.put("users", "me", { id: "me" });
    expect(blob.gets[1]?.pathname).toBe(`${BLOB_URL}?v=etag-new`);
    expect(blob.puts).toHaveLength(1);
    expect(blob.puts[0]?.options.ifMatch).toBe("etag-new");
    const saved = JSON.parse(blob.state.body ?? "{}") as { users: Record<string, { id: string }> };
    expect(saved.users.other?.id).toBe("other");
    expect(saved.users.me?.id).toBe("me");
  });

  it("refuses to write when every read is stale", async () => {
    const blob = mockBlob({ body: "{}", etag: "etag-new" });
    blob.serve(() => ({ body: "{}", etag: "etag-old" }));
    const store = createBlobStore("rank/store.json", blob.client);
    await expect(store.put("users", "me", { id: "me" })).rejects.toBeInstanceOf(BlobStaleReadError);
    expect(blob.puts).toHaveLength(0);
  });

  it("accepts the blob backend and the default pathname", () => {
    expect(loadConfig({ STORAGE_BACKEND: "blob" }).storageBlobPath).toBe("rank/store.json");
    expect(loadConfig({ STORAGE_BACKEND: "blob", STORAGE_BLOB_PATH: "custom/store.json" }).storageBlobPath).toBe("custom/store.json");
    expect(() => loadConfig({ STORAGE_BACKEND: "redis" })).toThrow(/blob/);
    expect(() => createBlobStore("")).toThrow(/STORAGE_BLOB_PATH/);
  });
});

describe("vercel routing", () => {
  it("sends every path to the function and bundles the logo", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as {
      rewrites?: unknown;
      routes: Array<{ handle?: string; src?: string; dest?: string }>;
      functions: { "api/index.ts": { includeFiles: string } };
    };
    expect(config.rewrites).toBeUndefined();
    expect(config.routes.some((route) => route.handle === "filesystem")).toBe(false);
    expect(config.routes).toEqual([{ src: "/(.*)", dest: "/api" }]);
    expect(config.functions["api/index.ts"].includeFiles).toBe("logo.jpg");
  });
});
