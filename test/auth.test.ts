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

    it("triggers new QR login when saved token is expired", async () => {
      await mkdir(stateDir, { recursive: true });
      const creds = { token: "EXPIREDTOKEN", expiresAt: Date.now() - 1000 };
      await writeFile(join(stateDir, "credentials.json"), JSON.stringify(creds));

      const fetchFn = mockFetchImmediate("FRESHTOKEN");
      const auth = new Auth(stateDir, BASE, fetchFn, 0);
      const token = await auth.getToken();
      expect(token).toBe("FRESHTOKEN");
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

    it("writes valid JSON to credentials.json", async () => {
      const fetchFn = mockFetchImmediate("T123");
      const auth = new Auth(stateDir, BASE, fetchFn, 0);
      await auth.getToken();

      const raw = await readFile(join(stateDir, "credentials.json"), "utf-8");
      const data = JSON.parse(raw);
      expect(data.token).toBe("T123");
      expect(data.expiresAt).toBeGreaterThan(Date.now());
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
    it("clears cached token so next getToken reloads from disk", async () => {
      await mkdir(stateDir, { recursive: true });
      const creds = { token: "VALID_TOKEN", expiresAt: Date.now() + 60_000 };
      await writeFile(join(stateDir, "credentials.json"), JSON.stringify(creds));

      // No fetchFn needed — loads from disk
      const auth = new Auth(stateDir, BASE, undefined, 0);
      const token1 = await auth.getToken();
      expect(token1).toBe("VALID_TOKEN");

      auth.invalidateToken();
      const creds2 = { token: "NEW_TOKEN", expiresAt: Date.now() + 60_000 };
      await writeFile(join(stateDir, "credentials.json"), JSON.stringify(creds2));

      const token2 = await auth.getToken();
      expect(token2).toBe("NEW_TOKEN");
    });
  });
});
