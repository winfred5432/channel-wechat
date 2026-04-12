import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "../src/index.js";

function makeStateDir(): string {
  return join(tmpdir(), `index-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

describe("runCli", () => {
  const savedEnv = { ...process.env };
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    process.env = { ...savedEnv };
    vi.restoreAllMocks();
    await Promise.all(cleanupDirs.map((dir) => import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }))));
    cleanupDirs.length = 0;
  });

  it("handles the qrcode-terminal subcommand", async () => {
    const stateDir = makeStateDir();
    cleanupDirs.push(stateDir);
    await mkdir(stateDir, { recursive: true });
    await writeFile(join(stateDir, "qrcode.txt"), "QR789", "utf8");
    process.env.WECHAT_STATE_DIR = stateDir;

    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await runCli(["qrcode-terminal"]);

    expect(stdoutSpy).toHaveBeenCalled();
  });
});
