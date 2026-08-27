import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "bun:test";
import { deleteObjectStrict } from "./storage";

describe("deleteObjectStrict", () => {
  it("surfaces a real local deletion failure", async () => {
    const previousDataDir = process.env.DATA_DIR;
    const previousBlobToken = process.env.BLOB_READ_WRITE_TOKEN;
    process.env.DATA_DIR = path.join(
      os.tmpdir(),
      `thumper-storage-${crypto.randomUUID()}`,
    );
    delete process.env.BLOB_READ_WRITE_TOKEN;
    try {
      await expect(
        deleteObjectStrict("users/user-1/uploads/missing.wav"),
      ).rejects.toHaveProperty("code", "ENOENT");
    } finally {
      if (previousDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = previousDataDir;
      if (previousBlobToken === undefined) {
        delete process.env.BLOB_READ_WRITE_TOKEN;
      } else {
        process.env.BLOB_READ_WRITE_TOKEN = previousBlobToken;
      }
    }
  });
});
