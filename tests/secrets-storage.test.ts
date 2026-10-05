import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pkceS256 } from "../src/secrets.js";
import { decryptString, encryptString } from "../src/secrets.js";
import { createFileStore } from "../src/storage.js";

describe("secrets and storage", () => {
  it("matches the RFC 7636 S256 vector", () => {
    expect(pkceS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("round-trips a refresh token and keeps the plaintext out of the file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rank-store-"));
    const path = join(dir, "store.json");
    const store = createFileStore(path);
    const plain = "1//refresh-token-value-not-for-disk";
    const key = "test-encryption-key";
    await store.put("users", "google-sub", {
      id: "google-sub",
      encryptedRefreshToken: encryptString(plain, key)
    });
    const onDisk = await readFile(path, "utf8");
    expect(onDisk).not.toContain(plain);
    const saved = await store.get("users", "google-sub");
    expect(decryptString(String(saved?.encryptedRefreshToken), key)).toBe(plain);
    expect(() => decryptString(String(saved?.encryptedRefreshToken), "other-key")).toThrow();
  });
});
