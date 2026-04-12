import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { Auth } from "../src/auth.js";

const BASE = "https://ilinkai.weixin.qq.com";

function makeStateDir(): string {
  return join(tmpdir(), `auth-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

// Mock qrcode to prevent real PNG file I/O during tests
vi.mock("qrcode", () => ({
  default: {
    toFile: vi.fn().mockResolvedValue(undefined),
    toString: vi.fn().mockResolvedValue("ASCII QR\n"),
  },
}));

// Helper: QR login mock using real ilink API response shapes
function mockFetchImmediate(token = "REALTOKEN"): typeof fetch {
  return vi.fn().mockImplementation(async (url: string) => {
    if (url.includes("get_bot_qrcode")) {
      return {
        ok: true,
        json: async () => ({ qrcode: "QR123", qrcode_img_content: "https://img.example.com/qr.png" }),
      };
    }
    if (url.includes("get_qrcode_status")) {
      return {
        ok: true,
        json: async () => ({ status: "confirmed", bot_token: token, ilink_bot_id: "BOT1" }),
      };
    }
    return { ok: true, json: async () => ({}) };
  }) as unknown as typeof fetch;
}

describe("Auth", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = makeStateDir();
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  describe("getToken", () => {
    it("triggers QR login on first call and returns token", async () => {
      const fetchFn = mockFetchImmediate("MYTOKEN");
      // pollIntervalMs=0 to skip sleep delays in QR polling loop
      const auth = new Auth(stateDir, BASE, fetchFn, 0);
      const token = await auth.getToken();
      expect(token).toBe("MYTOKEN");
    });

    it("returns cached token on second call without re-fetching QR", async () => {
      const fetchFn = mockFetchImmediate("MYTOKEN");
      const auth = new Auth(stateDir, BASE, fetchFn, 0);
      await auth.getToken();

      const callsBefore = (fetchFn as ReturnType<typeof vi.fn>).mock.calls.length;
      const token2 = await auth.getToken();
      expect(token2).toBe("MYTOKEN");
      expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore);
    });

    it("reloads valid token from disk", async () => {
      await mkdir(stateDir, { recursive: true });
      const creds = { token: "SAVEDTOKEN", expiresAt: Date.now() + 60 * 60 * 1000 };
      await writeFile(join(stateDir, "credentials.json"), JSON.stringify(creds));

      const fetchFn = vi.fn() as unknown as typeof fetch;
      const auth = new Auth(stateDir, BASE, fetchFn, 0);
      const token = await auth.getToken();
      expect(token).toBe("SAVEDTOKEN");
      expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it("reuses a token that has a legacy expiresAt field (TTL no longer enforced)", async () => {
      // ilink bot tokens have an unknown but long TTL; we rely on -14 for expiry detection.
      // Old credentials.json files may carry an expiresAt field — it must be ignored.
      await mkdir(stateDir, { recursive: true });
      const creds = { token: "LEGACYTOKEN", expiresAt: Date.now() - 1000 };
      await writeFile(join(stateDir, "credentials.json"), JSON.stringify(creds));

      const fetchFn = vi.fn() as unknown as typeof fetch;  // should not be called
      const auth = new Auth(stateDir, BASE, fetchFn, 0);
      const token = await auth.getToken();
      expect(token).toBe("LEGACYTOKEN");
      expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it("clears stale qr artifacts when booting from saved credentials", async () => {
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, "credentials.json"), JSON.stringify({ token: "SAVEDTOKEN" }));
      await writeFile(join(stateDir, "qrcode.png"), "stale-png");
      await writeFile(join(stateDir, "qrcode.txt"), "stale-qr");

      const fetchFn = vi.fn() as unknown as typeof fetch;
      const auth = new Auth(stateDir, BASE, fetchFn, 0);

      await expect(auth.getToken()).resolves.toBe("SAVEDTOKEN");
      await expect(readFile(join(stateDir, "qrcode.png"), "utf8")).rejects.toThrow();
      await expect(readFile(join(stateDir, "qrcode.txt"), "utf8")).rejects.toThrow();
    });
  });

  describe("token persistence", () => {
    it("saves credentials.json with mode 0o600", async () => {
      const fetchFn = mockFetchImmediate();
      const auth = new Auth(stateDir, BASE, fetchFn, 0);
      await auth.getToken();

      const credFile = join(stateDir, "credentials.json");
      const fileStat = await stat(credFile);
      expect(fileStat.mode & 0o777).toBe(0o600);
    });

    it("writes valid JSON to credentials.json (no expiresAt field)", async () => {
      const fetchFn = mockFetchImmediate("T123");
      const auth = new Auth(stateDir, BASE, fetchFn, 0);
      await auth.getToken();

      const raw = await readFile(join(stateDir, "credentials.json"), "utf-8");
      const data = JSON.parse(raw);
      expect(data.token).toBe("T123");
      // No TTL — ilink bot token lifetime is server-controlled, detected via -14 error
      expect(data.expiresAt).toBeUndefined();
    });
  });

  describe("QR output signals", () => {
    it("emits both PNG path and terminal QR markers during login", async () => {
      const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
      const fetchFn = mockFetchImmediate("QRTOKEN");
      const auth = new Auth(stateDir, BASE, fetchFn, 0);

      await expect(auth.startQrLogin()).resolves.toBe("QRTOKEN");

      const writes = stdoutSpy.mock.calls.map((call) => String(call[0]));
      expect(writes.some((line) => line.startsWith("QRCODE_READY:"))).toBe(true);
      expect(writes).toContain("QRCODE_TERMINAL_BEGIN\n");
      expect(writes).toContain("ASCII QR\n");
      expect(writes).toContain("QRCODE_TERMINAL_END\n");

      stdoutSpy.mockRestore();
    });

    it("uses the same scannable payload for png and terminal qr", async () => {
      const fetchFn = mockFetchImmediate("QRTOKEN");
      const auth = new Auth(stateDir, BASE, fetchFn, 0);
      const QRCode = (await import("qrcode")).default;

      await expect(auth.startQrLogin()).resolves.toBe("QRTOKEN");

      expect(QRCode.toFile).toHaveBeenCalledWith(
        expect.stringContaining("qrcode.png"),
        "https://img.example.com/qr.png",
        expect.any(Object),
      );
      expect(QRCode.toString).toHaveBeenCalledWith(
        "https://img.example.com/qr.png",
        expect.objectContaining({ type: "terminal" }),
      );
    });
  });

  describe("syncBuf persistence", () => {
    it("returns empty string when no sync-buf file", async () => {
      const auth = new Auth(stateDir, BASE);
      const buf = await auth.getSyncBuf();
      expect(buf).toBe("");
    });

    it("saves and loads syncBuf", async () => {
      const fetchFn = mockFetchImmediate();
      const auth = new Auth(stateDir, BASE, fetchFn, 0);
      await auth.getToken();
      await auth.saveSyncBuf("SYNCVAL");
      const buf = await auth.getSyncBuf();
      expect(buf).toBe("SYNCVAL");
    });
  });

  describe("invalidateToken", () => {
    it("clears cached token so next getToken re-authenticates", async () => {
      await mkdir(stateDir, { recursive: true });
      const creds = { token: "VALID_TOKEN", expiresAt: Date.now() + 60_000 };
      await writeFile(join(stateDir, "credentials.json"), JSON.stringify(creds));

      // Load initial token from disk; provide fetchFn for the re-auth after invalidation
      const auth = new Auth(stateDir, BASE, mockFetchImmediate("NEW_TOKEN"), 0);
      const token1 = await auth.getToken();
      expect(token1).toBe("VALID_TOKEN");

      // Delete creds file first so invalidateToken's async unlink is a no-op (file already gone)
      await rm(join(stateDir, "credentials.json"), { force: true });
      auth.invalidateToken();

      // Next getToken finds no file → triggers QR login → fetchFn returns NEW_TOKEN
      const token2 = await auth.getToken();
      expect(token2).toBe("NEW_TOKEN");
    });
  });
});
