import { describe, expect, it } from "bun:test";
import os from "node:os";
import path from "node:path";
import {
  assertOwnedUploadKey,
  deleteObjectStrict,
  hasObjectStorage,
  storageKeyForUser,
  userStorageKey,
} from "./storage";

async function withoutR2<T>(run: () => T | Promise<T>): Promise<T> {
  const previous = {
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET: process.env.R2_BUCKET,
    R2_ENDPOINT: process.env.R2_ENDPOINT,
  };
  for (const key of Object.keys(previous)) delete process.env[key];
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

describe("hasObjectStorage", () => {
  it("is off unless every R2 credential is set", async () => {
    await withoutR2(() => {
      expect(hasObjectStorage()).toBe(false);
      process.env.R2_ACCOUNT_ID = "acct";
      process.env.R2_ACCESS_KEY_ID = "key";
      process.env.R2_SECRET_ACCESS_KEY = "secret";
      expect(hasObjectStorage()).toBe(false);
      process.env.R2_BUCKET = "thumper";
      expect(hasObjectStorage()).toBe(true);
    });
  });
});

describe("storage keys", () => {
  it("builds and resolves keys under the user prefix", () => {
    const key = userStorageKey("user_abc", "uploads", "a.wav");
    expect(key).toBe("users/user_abc/uploads/a.wav");
    expect(storageKeyForUser("user_abc", key)).toBe(key);
    expect(storageKeyForUser("user_abc", "downloads/track.flac")).toBe(
      "users/user_abc/downloads/track.flac",
    );
    expect(storageKeyForUser("user_abc", "track.flac")).toBe("users/user_abc/track.flac");
  });

  it("rejects upload keys outside the caller's prefix", () => {
    expect(() => assertOwnedUploadKey("user_abc", "users/user_abc/uploads/x.wav")).not.toThrow();
    expect(() => assertOwnedUploadKey("user_abc", "users/other/uploads/x.wav")).toThrow(
      /Invalid upload path/,
    );
    expect(() => assertOwnedUploadKey("user_abc", "users/user_abc/uploads/../cookies/x")).toThrow(
      /Invalid upload path/,
    );
  });
});

describe("deleteObjectStrict", () => {
  it("surfaces a real local deletion failure", async () => {
    const previousDataDir = process.env.DATA_DIR;
    await withoutR2(async () => {
      process.env.DATA_DIR = path.join(os.tmpdir(), `thumper-storage-${crypto.randomUUID()}`);
      await expect(deleteObjectStrict("users/user-1/uploads/missing.wav")).rejects.toHaveProperty(
        "code",
        "ENOENT",
      );
    });
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
  });
});
