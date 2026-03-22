import { mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getQrCode, pollQrStatus, WechatApiError } from "./wechat.js";

interface Credentials {
  token: string;
  botId?: string;
  expiresAt: number; // unix ms
}

const TOKEN_TTL_MS = 6 * 60 * 60 * 1000; // 6h conservative TTL

export class Auth {
  private readonly credFile: string;
  private readonly syncBufFile: string;
  private readonly qrcodePng: string;
  private cached: Credentials | null = null;

  constructor(
    private readonly stateDir: string,
    private readonly apiBase: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly pollIntervalMs: number = 2000,
  ) {
    this.credFile = resolve(stateDir, "credentials.json");
    this.syncBufFile = resolve(stateDir, "sync-buf.txt");
    this.qrcodePng = resolve(stateDir, "qrcode.png");
  }

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt > Date.now()) {
      return this.cached.token;
    }
    const saved = await this.loadCredentials();
    if (saved && saved.expiresAt > Date.now()) {
      this.cached = saved;
      return saved.token;
    }
    return this.startQrLogin();
  }

  async startQrLogin(): Promise<string> {
    const { qrcode: qrcodeStr } = await getQrCode(this.apiBase, this.fetchFn);

    await this.ensureStateDir();

    // Render QR URL to PNG file (lazy import to keep module graph light)
    const QRCode = (await import("qrcode")).default;
    await QRCode.toFile(this.qrcodePng, qrcodeStr, { type: "png", width: 300 });

    // Signal to agent: PNG is ready at this path
    process.stdout.write(`QRCODE_READY:${this.qrcodePng}\n`);

    // Long-poll until confirmed or expired
    const deadline = Date.now() + 3 * 60 * 1000;
    while (Date.now() < deadline) {
      await sleep(this.pollIntervalMs);
      let result: { status: string; token?: string; botId?: string };
      try {
        result = await pollQrStatus(this.apiBase, qrcodeStr, this.fetchFn);
      } catch (err) {
        if (err instanceof WechatApiError && err.errcode === -14) {
          await this.cleanupQrPng();
          return this.startQrLogin();
        }
        throw err;
      }

      if (result.status === "confirmed" && result.token) {
        const creds: Credentials = {
          token: result.token,
          botId: result.botId,
          expiresAt: Date.now() + TOKEN_TTL_MS,
        };
        await this.saveCredentials(creds);
        this.cached = creds;

        // Signal to agent: WeChat is connected
        const botId = result.botId ?? "unknown";
        process.stdout.write(`WECHAT_CONNECTED:${botId}\n`);

        await this.cleanupQrPng();
        return creds.token;
      }
      if (result.status === "expired") {
        await this.cleanupQrPng();
        return this.startQrLogin();
      }
      // waiting or scanned — keep polling
    }
    await this.cleanupQrPng();
    throw new Error("QR login timed out after 3 minutes");
  }

  async getSyncBuf(): Promise<string> {
    try {
      const data = await readFile(this.syncBufFile, "utf-8");
      return data.trim();
    } catch {
      return "";
    }
  }

  async saveSyncBuf(syncBuf: string): Promise<void> {
    await this.ensureStateDir();
    await writeFile(this.syncBufFile, syncBuf, "utf-8");
  }

  invalidateToken(): void {
    this.cached = null;
  }

  private async loadCredentials(): Promise<Credentials | null> {
    try {
      const raw = await readFile(this.credFile, "utf-8");
      return JSON.parse(raw) as Credentials;
    } catch {
      return null;
    }
  }

  private async saveCredentials(creds: Credentials): Promise<void> {
    await this.ensureStateDir();
    await writeFile(this.credFile, JSON.stringify(creds), "utf-8");
    await chmod(this.credFile, 0o600);
  }

  private async cleanupQrPng(): Promise<void> {
    try {
      await unlink(this.qrcodePng);
    } catch {
      // ignore if already gone
    }
  }

  private async ensureStateDir(): Promise<void> {
    if (!existsSync(this.stateDir)) {
      await mkdir(this.stateDir, { recursive: true });
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
