import type { Config } from "./config.js";
import type { Auth } from "./auth.js";
import { getUpdates, sendMessage, WechatApiError, type WechatMsg } from "./wechat.js";
import { ingress, pull, ack } from "./daemon.js";

const CONSUMER_ID = "channel-wechat";
const PULL_WAIT_MS = 5000;
const PULL_LIMIT = 10;
const MAX_CONSECUTIVE_ERRORS = 5;
const BACKOFF_MS = 30_000;

function log(level: string, msg: string, cfg?: Config) {
  const levels = ["error", "warn", "info", "debug"];
  const cfgLevel = cfg?.logLevel ?? "info";
  if (levels.indexOf(level) <= levels.indexOf(cfgLevel)) {
    console.log(`[${level.toUpperCase()}] [wechat-channel] ${msg}`);
  }
}

export class Gateway {
  private running = false;
  private activeSessions = new Map<string, { cursor: string; pulling: boolean }>();

  constructor(
    private readonly config: Config,
    private readonly auth: Auth,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  start(): void {
    this.running = true;
    void this.ingressLoop();
  }

  stop(): void {
    this.running = false;
  }

  private async ingressLoop(): Promise<void> {
    let consecutiveErrors = 0;

    while (this.running) {
      try {
        const token = await this.auth.getToken();
        const syncBuf = await this.auth.getSyncBuf();

        const { msgs, syncBuf: newSyncBuf } = await getUpdates(
          this.config.apiBase,
          token,
          syncBuf,
          this.fetchFn,
        );

        await this.auth.saveSyncBuf(newSyncBuf);
        consecutiveErrors = 0;

        for (const msg of msgs) {
          await this.handleIncomingMessage(msg, token);
        }
      } catch (err) {
        consecutiveErrors++;
        if (err instanceof WechatApiError && err.errcode === -14) {
          log("warn", "Token invalid (-14), triggering re-login", this.config);
          this.auth.invalidateToken();
          consecutiveErrors = 0;
          continue;
        }
        log("error", `ingressLoop error (${consecutiveErrors}): ${String(err)}`, this.config);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log("warn", `${MAX_CONSECUTIVE_ERRORS} consecutive errors, backing off ${BACKOFF_MS}ms`, this.config);
          await sleep(BACKOFF_MS);
          consecutiveErrors = 0;
        }
      }
    }
  }

  private async handleIncomingMessage(msg: WechatMsg, token: string): Promise<void> {
    if (!this.isAllowed(msg.from)) {
      log("debug", `Message from ${msg.from} blocked by allowlist`, this.config);
      return;
    }

    const sessionKey = `wechat:${msg.from}`;
    log("info", `Ingress from ${msg.from} session=${sessionKey}`, this.config);

    try {
      await ingress(
        this.config.daemonUrl,
        {
          session_key: sessionKey,
          text: msg.content,
          idempotency_key: msg.msgid,
          source_kind: "wechat",
          channel_id: `wechat-${msg.from}`,
        },
        this.fetchFn,
      );
    } catch (err) {
      log("error", `ingress failed for ${sessionKey}: ${String(err)}`, this.config);
      return;
    }

    // Kick off pull loop for this session if not already running
    if (!this.activeSessions.has(sessionKey)) {
      this.activeSessions.set(sessionKey, { cursor: "", pulling: true });
      void this.pullLoop(sessionKey, msg.from, token, msg.context_token);
    }
  }

  private async pullLoop(
    sessionKey: string,
    to: string,
    token: string,
    contextToken?: string,
  ): Promise<void> {
    const session = this.activeSessions.get(sessionKey)!;
    let idleRounds = 0;
    const MAX_IDLE = 12; // ~60s idle = session done

    while (this.running && idleRounds < MAX_IDLE) {
      try {
        const currentToken = await this.auth.getToken();
        const payloads = await pull(
          this.config.daemonUrl,
          {
            session_key: sessionKey,
            consumer_id: CONSUMER_ID,
            cursor: session.cursor || undefined,
            limit: PULL_LIMIT,
            wait_ms: PULL_WAIT_MS,
            return_mask: ["final"],
          },
          this.fetchFn,
        );

        if (payloads.length === 0) {
          idleRounds++;
          continue;
        }

        idleRounds = 0;
        for (const payload of payloads) {
          if (payload.text) {
            try {
              await sendMessage(
                this.config.apiBase,
                currentToken,
                to,
                payload.text,
                contextToken,
                this.fetchFn,
              );
            } catch (err) {
              log("error", `sendMessage failed to ${to}: ${String(err)}`, this.config);
            }
          }

          // Ack each payload — use raw.outbox_id as cursor if available
          const raw = payload.raw as Record<string, unknown> | null;
          const cursor =
            typeof raw?.outbox_id === "string" ? raw.outbox_id : session.cursor;
          if (cursor) {
            try {
              await ack(
                this.config.daemonUrl,
                { session_key: sessionKey, consumer_id: CONSUMER_ID, cursor },
                this.fetchFn,
              );
              session.cursor = cursor;
            } catch (err) {
              log("warn", `ack failed for ${sessionKey}: ${String(err)}`, this.config);
            }
          }
        }
      } catch (err) {
        if (err instanceof WechatApiError && err.errcode === -14) {
          this.auth.invalidateToken();
          token = await this.auth.getToken();
          continue;
        }
        log("error", `pullLoop error for ${sessionKey}: ${String(err)}`, this.config);
        idleRounds++;
      }
    }

    log("debug", `pullLoop ended for ${sessionKey}`, this.config);
    this.activeSessions.delete(sessionKey);
  }

  private isAllowed(userId: string): boolean {
    if (this.config.dmPolicy === "open") return true;
    return this.config.allowFrom.includes(userId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
