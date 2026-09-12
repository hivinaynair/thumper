import { describe, expect, it } from "bun:test";
import { deriveModalSiblingUrl } from "./wake-modal";

describe("deriveModalSiblingUrl", () => {
  it("rewrites the function name in the hostname, which is how Modal names endpoints", () => {
    expect(
      deriveModalSiblingUrl("https://acme--thumper-worker-wake.modal.run", "wake", "wake-stems"),
    ).toBe("https://acme--thumper-worker-wake-stems.modal.run");
  });

  it("leaves the workspace and app segments alone", () => {
    // "wake" also appears inside the workspace name here; only the trailing
    // function segment may be rewritten.
    expect(
      deriveModalSiblingUrl("https://wakeco--thumper-worker-wake.modal.run", "wake", "search"),
    ).toBe("https://wakeco--thumper-worker-search.modal.run");
  });

  it("still supports a path-shaped URL for a proxied deployment", () => {
    expect(deriveModalSiblingUrl("https://api.example.com/wake", "wake", "wake-stems")).toBe(
      "https://api.example.com/wake-stems",
    );
    expect(deriveModalSiblingUrl("https://api.example.com/wake/", "wake", "wake-stems")).toBe(
      "https://api.example.com/wake-stems",
    );
  });

  it("returns null when neither shape matches, so the caller can demand an explicit URL", () => {
    expect(deriveModalSiblingUrl("https://example.com/", "wake", "wake-stems")).toBeNull();
    expect(
      deriveModalSiblingUrl("https://acme--other-app.modal.run", "wake", "wake-stems"),
    ).toBeNull();
  });
});
