import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "bun:test";

const repoRoot = path.resolve(import.meta.dir, "../../..");

describe("Hypeddit worker-only browser boundary", () => {
  it("keeps puppeteer-core out of the provider-neutral Hypeddit module", async () => {
    const source = await fs.readFile(
      path.join(repoRoot, "packages/pipeline/src/hypeddit.ts"),
      "utf8",
    );

    expect(source).not.toContain("import puppeteer");
    expect(source).toContain(
      "import type { BrowserContext, HTTPResponse, Page }",
    );
    expect(source).toContain('import("./hypeddit-browser")');
  });

  it("keeps unrelated web routes off the pipeline barrel", async () => {
    const routes = [
      "apps/web/app/api/retag/upload/route.ts",
      "apps/web/app/api/retag/search/route.ts",
      "apps/web/app/api/retag/convert/route.ts",
      "apps/web/app/api/jobs/route.ts",
      "apps/web/app/api/files/zip/route.ts",
      "apps/web/app/api/files/[id]/route.ts",
      "apps/web/app/api/cookies/route.ts",
    ];
    const sources = await Promise.all(
      routes.map((route) => fs.readFile(path.join(repoRoot, route), "utf8")),
    );

    for (const source of sources) {
      expect(source).not.toContain('from "@thumper/pipeline"');
    }
  });

  it("configures a dedicated Chromium wrapper on the Modal worker image", async () => {
    const [dockerfile, modalWorker, browserWorker, wrapper, smokeExists] =
      await Promise.all([
        fs.readFile(path.join(repoRoot, "Dockerfile"), "utf8"),
        fs.readFile(
          path.join(repoRoot, "apps/modal/thumper_worker.py"),
          "utf8",
        ),
        fs.readFile(
          path.join(repoRoot, "packages/pipeline/src/hypeddit-browser.ts"),
          "utf8",
        ),
        fs.readFile(path.join(repoRoot, "scripts/chromium-worker"), "utf8"),
        fs
          .access(path.join(repoRoot, "scripts/smoke-chromium-isolation.sh"))
          .then(
            () => true,
            () => false,
          ),
      ]);

    expect(modalWorker).toContain("chromium-worker");
    expect(modalWorker).toContain("PUPPETEER_RUN_UID");
    expect(modalWorker).toContain("PUPPETEER_EXECUTABLE_PATH");
    expect(modalWorker).toContain("useradd");
    expect(modalWorker).toContain("os.umask(0o077)");
    expect(modalWorker).toContain("def smoke_chromium");
    expect(modalWorker).toContain(
      '.add_local_python_source("chromium_isolation")',
    );
    expect(browserWorker).toContain("fs.chown(profileDir, runUid, runGid)");
    expect(wrapper).not.toContain("setpriv");
    expect(wrapper).not.toContain("bounding-set");
    expect(wrapper).toContain("setgid");
    expect(wrapper).toContain("setgroups");
    expect(wrapper).toContain("setuid");
    expect(wrapper).toContain("/var/lib/chromium");
    expect(wrapper).toContain('"/usr/bin/chromium"');
    expect(wrapper).toContain("--no-sandbox");
    expect(wrapper).not.toContain("PUPPETEER_RUN_UID");
    expect(dockerfile).not.toContain("FROM base AS chromium-smoke");
    expect(dockerfile).not.toContain("USER chromium-worker");
    expect(smokeExists).toBe(false);
  });
});
