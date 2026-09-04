import { expect, test } from "bun:test";
import net from "node:net";

import { CONNECT_ATTEMPT_TIMEOUT_MS, createDb } from "./client";

// Bun gives each resolved address only 250ms to finish its TCP handshake. A
// cold Modal container reaching Neon misses that window on every address, so
// the socket fails with an aggregated ETIMEDOUT before postgres.js's
// connect_timeout is ever consulted.
test("createDb widens the per-address connect budget past Bun's default", () => {
  createDb("postgres://user:pass@localhost:5432/thumper");

  expect(CONNECT_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(5_000);
  expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(
    CONNECT_ATTEMPT_TIMEOUT_MS,
  );
});
