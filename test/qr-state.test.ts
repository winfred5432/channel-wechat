import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearPendingQrCode,
  printPendingQrCodeTerminal,
  savePendingQrCode,
  type OutputWriter,
} from "../src/qr-state.js";

function makeStateDir(): string {
  return join(tmpdir(), `qr-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

vi.mock("qrcode", () => ({
  default: {
    toString: vi.fn().mockResolvedValue("ASCII QR\n"),
  },
}));

describe("qr state", () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanupDirs.map((dir) => import("node:fs/promises").then(({ rm }) => rm(dir, { recursive: true, force: true }))));
    cleanupDirs.length = 0;
  });

  it("prints the pending qr code as terminal output", async () => {
    const stateDir = makeStateDir();
    cleanupDirs.push(stateDir);
    await mkdir(stateDir, { recursive: true });
    await savePendingQrCode(stateDir, "QR123");

    const writes: string[] = [];
    const writer: OutputWriter = (chunk) => {
      writes.push(String(chunk));
      return true;
    };

    await printPendingQrCodeTerminal(stateDir, writer);

    expect(writes).toEqual(["ASCII QR\n"]);
  });

  it("stores and clears the raw pending qr payload", async () => {
    const stateDir = makeStateDir();
    cleanupDirs.push(stateDir);
    await mkdir(stateDir, { recursive: true });

    await savePendingQrCode(stateDir, "QR456");
    expect(await readFile(join(stateDir, "qrcode.txt"), "utf8")).toBe("QR456");

    await clearPendingQrCode(stateDir);
    await expect(readFile(join(stateDir, "qrcode.txt"), "utf8")).rejects.toThrow();
  });
});
