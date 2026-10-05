import { readFileSync } from "node:fs";
import { BlobNotFoundError, BlobPreconditionFailedError } from "@vercel/blob";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createBlobStore, type BlobStoreClient } from "../src/storage.js";

type Stored = { body: string | null; etag: string };

function jsonStream(body: string) {
  return new Blob([body]).stream();
}

function mockBlob(initial?: Stored) {
  const state: Stored = initial ?? { body: null, etag: "" };
  const gets: Array<{ pathname: string; options: { access: string; useCache: boolean } }> = [];
  const puts: Array<{ pathname: string; body: string; options: { access: string; allowOverwrite: boolean; addRandomSuffix: boolean; contentType: string; ifMatch?: string } }> = [];
  let failPuts = 0;
  let onFailedPut: (() => void) | null = null;
  const client: BlobStoreClient = {
    async get(pathname, options) {
      gets.push({ pathname, options });
      if (state.body === null) return null;
      return { stream: jsonStream(state.body), blob: { etag: state.etag } };
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
