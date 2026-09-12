import { afterEach, describe, expect, it } from "bun:test";
import { cookieOwnerId } from "./cookies";

const ORIGINAL = process.env.SHARED_COOKIE_USER_ID;

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.SHARED_COOKIE_USER_ID;
  else process.env.SHARED_COOKIE_USER_ID = ORIGINAL;
});

describe("cookieOwnerId", () => {
  it("uses the requesting user when no shared session is configured", () => {
    delete process.env.SHARED_COOKIE_USER_ID;
    expect(cookieOwnerId("user_friend")).toBe("user_friend");
  });

  it("routes every user's download through the configured shared session", () => {
    process.env.SHARED_COOKIE_USER_ID = "user_server";
    expect(cookieOwnerId("user_friend")).toBe("user_server");
  });

  it("ignores a blank shared session rather than reading cookies for ''", () => {
    process.env.SHARED_COOKIE_USER_ID = "   ";
    expect(cookieOwnerId("user_friend")).toBe("user_friend");
  });
});
