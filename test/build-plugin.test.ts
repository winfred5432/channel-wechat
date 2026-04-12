import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testDir);

describe("build plugin", () => {
  it("emits a single shebang in dist/plugin.js", async () => {
    await execFileAsync(process.execPath, [join(repoRoot, "scripts/build-plugin.mjs")], {
      cwd: repoRoot,
    });

    const built = await readFile(join(repoRoot, "dist/plugin.js"), "utf8");
    const lines = built.split("\n");

    expect(lines[0]).toBe("#!/usr/bin/env node");
    expect(lines[1]).not.toBe("#!/usr/bin/env node");
  });
});
