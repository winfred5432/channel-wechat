import { mkdir, readFile, writeFile, chmod, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { getQrCode, pollQrStatus, WechatApiError } from "./wechat.js";

interface Credentials {
  token: string;
  botId?: string;
  // No expiresAt — ilink bot tokens have an unknown TTL (potentially days).
  // Token expiry is detected via -14 error responses, not a proactive timer.
}

export class Auth {
  private readonly credFile: string;
  private readonly syncBufFile: string;
  private readonly qrcodePng: string;
  private cached: Credentials | null = null;

  /** Timestamp when current token was obtained. 0 = never. */
  tokenObtainedAt = 0;

  private static readonly PROACTIVE_REFRESH_MS = 12 * 60 * 60 * 1000; // 12h
  private silentRefreshInProgress = false;

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
    if (this.cached) {
      // 超过 12h 且没有刷新进行中 → 后台静默刷新
      if (
        this.tokenObtainedAt > 0 &&
        Date.now() - this.tokenObtainedAt > Auth.PROACTIVE_REFRESH_MS &&
        !this.silentRefreshInProgress
      ) {
        void this.silentRefresh();
      }
      return this.cached.token;
    }
    const saved = await this.loadCredentials();
    if (saved) {
      this.cached = saved;
      if (this.tokenObtainedAt === 0) this.tokenObtainedAt = Date.now();
      return saved.token;
    }
    return this.startQrLogin();
  }

  async startQrLogin(): Promise<string> {
    // qrcode: used for polling status; qrcodeImgUrl: the actual QR image URL
    const { qrcode: qrcodeStr, qrcodeImgUrl } = await getQrCode(this.apiBase, this.fetchFn);

    await this.ensureStateDir();

    // Render QR image URL to PNG file so agent can send it via Feishu attachment
    const QRCode = (await import("qrcode")).default;
    await QRCode.toFile(this.qrcodePng, qrcodeImgUrl, { type: "png", width: 300 });

    // Signal to agent: PNG is ready at this path
    process.stdout.write(`QRCODE_READY:${this.qrcodePng}\n`);

    // Long-poll until confirmed or expired
    const deadline = Date.now() + 8 * 60 * 1000; // 8 min (matches reference impl)
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
        };
        await this.saveCredentials(creds);
        this.cached = creds;
        this.tokenObtainedAt = Date.now();

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
      // wait / scanned — keep polling
    }
    await this.cleanupQrPng();
    throw new Error("QR login timed out after 8 minutes");
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
    // Clear in-memory cache AND delete the credentials file so that the next
    // getToken() call falls through to startQrLogin() instead of reloading the
    // same expired token from disk in an infinite -14 loop.
    this.cached = null;
    this.tokenObtainedAt = 0;
    unlink(this.credFile).catch(() => { /* ignore if already gone */ });
  }

  private async silentRefresh(): Promise<void> {
    this.silentRefreshInProgress = true;
    try {
      // iLink currently has no interactive-free token refresh API.
      // Reset the timer to prevent repeated triggering on every getToken() call.
      // Real refresh still happens via -14 error path in gateway.
      // TODO: call a no-QR refresh API here when iLink provides one.
      this.tokenObtainedAt = Date.now();
    } finally {
      this.silentRefreshInProgress = false;
    }
  }

  /** Force a fresh QR login, overwriting any saved credentials. */
  async relogin(): Promise<string> {
    this.cached = null;
    return this.startQrLogin();
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
