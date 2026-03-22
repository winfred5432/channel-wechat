import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import type { Config } from "./config.js";
import type { Auth } from "./auth.js";
import { getUpdates, sendMessage, getConfig, sendTyping, WechatApiError } from "./wechat.js";
import { downloadMedia, uploadMedia } from "./media.js";
import { ingress, pull, ack } from "./daemon.js";

const MEDIA_TMP_DIR = "/tmp/channel-wechat-media";

const CONSUMER_ID = "channel-wechat";
const PULL_WAIT_MS = 10_000;
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
  private abortController = new AbortController();

  /**
   * Shared state between ingressLoop and pullLoop.
   *
   * WeChat ilink routes replies via context_token — a per-conversation
   * thread ID that must accompany every sendMessage call. The ingressLoop
   * keeps this map fresh on every incoming message; the pullLoop reads it
   * to correctly route each outbound reply.
   *
   * session_key → { toUser, contextToken, cursor }
   */
  private readonly sessions = new Map<string, {
    toUser: string;
    contextToken: string | undefined;
    cursor: string;
    stopTyping?: () => void;
  }>();

  // Per-user typing ticket cache. typing_ticket is fetched via getConfig and cached.
  private readonly typingTickets = new Map<string, { ticket: string; fetchedAt: number }>();
  private readonly TYPING_TICKET_TTL_MS = 20 * 60 * 60 * 1000; // 20h (official 24h, conservative)

  constructor(
    private readonly config: Config,
    private readonly auth: Auth,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  start(): void {
    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;
    // Wrap fetchFn to inject the abort signal into every request
    const fetch = this.fetchFn;
    const abortableFetch: typeof fetch = (url, init) =>
      fetch(url, { ...init, signal });
    void this.ingressLoop(abortableFetch);
    void this.pullLoop(abortableFetch);
  }

  stop(): void {
    this.running = false;
    this.abortController.abort();
  }

  /**
   * ingressLoop — permanent loop mirroring startPolling() in the reference
   * impl (codeyq/wechat-claude-code-channel).
   *
   * Responsibility: long-poll WeChat for incoming messages, keep the
   * contextToken map current, forward each message to the daemon.
   */
  private async ingressLoop(fetchFn: typeof fetch): Promise<void> {
    let consecutiveErrors = 0;
    log("info", "ingressLoop started", this.config);

    while (this.running) {
      log("debug", "ingressLoop tick", this.config);
      try {
        const token = await this.auth.getToken();
        const syncBuf = await this.auth.getSyncBuf();

        const { msgs, syncBuf: newSyncBuf } = await getUpdates(
          this.config.apiBase,
          token,
          syncBuf,
          fetchFn,
        );

        await this.auth.saveSyncBuf(newSyncBuf);
        consecutiveErrors = 0;

        for (const msg of msgs) {
          // Skip bot outgoing echoes (message_type 2), only process user messages (type 1)
          if (msg.message_type === 2) continue;

          if (!this.isAllowed(msg.from_user_id)) {
            log("debug", `Blocked message from ${msg.from_user_id}`, this.config);
            continue;
          }

          const text = msg.item_list
            ?.filter(i => i.type === 1 && i.text_item?.text)
            .map(i => i.text_item!.text)
            .join("") ?? "";

          // Handle image items (type:2) — download, decrypt, save to tmp file
          const imageItems = msg.item_list?.filter(i => i.type === 2) ?? [];
          const imagePaths: string[] = [];
          for (const imgItem of imageItems) {
            const media = (imgItem as { image_item?: { media?: { encrypt_query_param?: string; aes_key?: string } } }).image_item?.media;
            if (!media?.encrypt_query_param || !media?.aes_key) continue;
            try {
              await mkdir(MEDIA_TMP_DIR, { recursive: true });
              const buf = await downloadMedia({
                cdnBaseUrl: this.config.cdnBase,
                encryptQueryParam: media.encrypt_query_param,
                aesKeyBase64: media.aes_key,
                fetchFn,
              });
              const ext = "jpg";
              const fname = `${Date.now()}-${randomBytes(4).toString("hex")}.${ext}`;
              const fpath = `${MEDIA_TMP_DIR}/${fname}`;
              await writeFile(fpath, buf);
              imagePaths.push(fpath);
              log("info", `Downloaded image to ${fpath} (${buf.length} bytes)`, this.config);
            } catch (err) {
              log("warn", `Failed to download image from CDN: ${String(err)}`, this.config);
            }
          }

          if (!text && imagePaths.length === 0) {
            log("debug", `Non-text/image message from ${msg.from_user_id}, skipping`, this.config);
            continue;
          }

          const sessionKey = `wechat:${msg.from_user_id}`;

          // Keep contextToken current — this is what routes replies back into
          // the correct WeChat conversation thread (ilink protocol requirement)
          const existing = this.sessions.get(sessionKey);
          if (existing) {
            if (msg.context_token) existing.contextToken = msg.context_token;
          } else {
            this.sessions.set(sessionKey, {
              toUser: msg.from_user_id,
              contextToken: msg.context_token,
              cursor: "",
            });
          }

          log("info", `Ingress from ${msg.from_user_id} text=${JSON.stringify(combinedText.slice(0, 80))}`, this.config);

          // Start typing indicator (fire-and-forget; errors must not block ingress)
          void this.getTypingTicket(msg.from_user_id, msg.context_token, fetchFn).then(ticket => {
            if (!ticket) return;
            const session = this.sessions.get(sessionKey);
            if (!session) return;
            session.stopTyping?.();
            session.stopTyping = this.startTyping(msg.from_user_id, ticket, fetchFn);
          });

          try {
            await ingress(
              this.config.daemonUrl,
              {
                session_key: sessionKey,
                text: text || undefined,
                attachments: imagePaths.map(p => ({ path: p, mime: "image/jpeg" })),
                idempotency_key: String(msg.message_id),
                source_kind: "wechat",
                channel_id: `wechat-${msg.from_user_id.replace(/[^A-Za-z0-9_-]/g, "_")}`,
              },
              fetchFn,
            );
          } catch (err) {
            log("error", `ingress failed for ${sessionKey}: ${String(err)}`, this.config);
          }
        }
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        consecutiveErrors++;
        if (err instanceof WechatApiError && err.errcode === -14) {
          log("warn", "Token invalid (-14), triggering re-login", this.config);
          this.auth.invalidateToken();
          consecutiveErrors = 0;
          continue;
        }
        log("error", `ingressLoop error (${consecutiveErrors}): ${String(err)}`, this.config);
        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          log("warn", `Backing off ${BACKOFF_MS}ms after ${MAX_CONSECUTIVE_ERRORS} errors`, this.config);
          await sleep(BACKOFF_MS);
          consecutiveErrors = 0;
        }
      }
    }
  }

  /**
   * pullLoop — permanent loop that drains the daemon outbox and delivers
   * replies back to WeChat.
   *
   * One pull call per known session per iteration. New sessions registered
   * by ingressLoop are picked up automatically on the next pass.
   * Never exits while running — no idle timeout.
   */
  private async pullLoop(fetchFn: typeof fetch): Promise<void> {
    let consecutiveErrors = 0;
    log("info", "pullLoop started", this.config);

    while (this.running) {
      log("debug", "pullLoop tick", this.config);

      if (this.sessions.size === 0) {
        await sleep(1_000, this.abortController.signal);
        continue;
      }

      for (const [sessionKey, state] of this.sessions) {
        if (!this.running) break;
        try {
          const token = await this.auth.getToken();
          const payloads = await pull(
            this.config.daemonUrl,
            {
              session_key: sessionKey,
              consumer_id: CONSUMER_ID,
              cursor: state.cursor || undefined,
              limit: PULL_LIMIT,
              wait_ms: PULL_WAIT_MS,
              return_mask: ["final"],
              accept_mime: ["image/*"],
            },
            fetchFn,
          );

          consecutiveErrors = 0;

          for (const payload of payloads) {
            // Outbound: send image if mediaUrl present, then text
            if (payload.mediaUrl) {
              log("info", `Sending image to ${state.toUser}: ${payload.mediaUrl.slice(0, 80)}`, this.config);
              try {
                const uploaded = await uploadMedia({
                  apiBase: this.config.apiBase,
                  cdnBase: this.config.cdnBase,
                  token,
                  filePath: payload.mediaUrl.startsWith("file://")
                    ? new URL(payload.mediaUrl).pathname
                    : payload.mediaUrl,
                  toUserId: state.toUser,
                  fetchFn,
                });
                await sendMessage(
                  this.config.apiBase,
                  token,
                  state.toUser,
                  payload.text ?? "",
                  state.contextToken,
                  fetchFn,
                  undefined,
                  { encryptQueryParam: uploaded.encryptQueryParam, aesKeyBase64: uploaded.aesKeyBase64, midSize: uploaded.fileSizeCiphertext },
                );
              } catch (err) {
                log("error", `sendImage failed to ${state.toUser}: ${String(err)}`, this.config);
                // Fall through to send text only if image failed
                if (payload.text) {
                  await sendMessage(this.config.apiBase, token, state.toUser, payload.text, state.contextToken, fetchFn).catch(e =>
                    log("error", `sendMessage fallback failed: ${String(e)}`, this.config)
                  );
                }
              }
            } else if (payload.text) {
              log("info", `Sending reply to ${state.toUser}: ${payload.text.slice(0, 60)}`, this.config);
              try {
                await sendMessage(
                  this.config.apiBase,
                  token,
                  state.toUser,
                  payload.text,
                  state.contextToken,
                  fetchFn,
                );
              } catch (err) {
                if (err instanceof WechatApiError && err.errcode === -14) {
                  this.auth.invalidateToken();
                  throw err;
                }
                log("error", `sendMessage failed to ${state.toUser}: ${String(err)}`, this.config);
              }
            }

            // Always ack to advance cursor, even if sendMessage failed —
            // prevents a bad record from blocking the entire outbox forever
            const raw = payload.raw as Record<string, unknown> | null;
            const cursor = typeof raw?.id === "string" ? raw.id : null;
            if (cursor) {
              try {
                await ack(
                  this.config.daemonUrl,
                  { session_key: sessionKey, consumer_id: CONSUMER_ID, cursor },
                  fetchFn,
                );
                state.cursor = cursor;
              } catch (err) {
                log("warn", `ack failed (cursor=${cursor}): ${String(err)}`, this.config);
              }
            }
          }

          // Stop typing indicator after all payloads delivered
          if (payloads.length > 0 && state.stopTyping) {
            state.stopTyping();
            state.stopTyping = undefined;
          }
        } catch (err) {
          if ((err as Error)?.name === "AbortError") return;
          consecutiveErrors++;
          if (err instanceof WechatApiError && err.errcode === -14) {
            log("warn", "pullLoop: token invalid (-14), re-login", this.config);
            this.auth.invalidateToken();
            consecutiveErrors = 0;
            continue;
          }
          log("error", `pullLoop error for ${sessionKey} (${consecutiveErrors}): ${String(err)}`, this.config);
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            log("warn", `Backing off ${BACKOFF_MS}ms after ${MAX_CONSECUTIVE_ERRORS} errors`, this.config);
            await sleep(BACKOFF_MS);
            consecutiveErrors = 0;
          }
        }
      }
    }
  }

  private async getTypingTicket(
    userId: string,
    contextToken: string | undefined,
    fetchFn: typeof fetch,
  ): Promise<string | undefined> {
    const cached = this.typingTickets.get(userId);
    if (cached && Date.now() - cached.fetchedAt < this.TYPING_TICKET_TTL_MS) {
      return cached.ticket;
    }
    try {
      const token = await this.auth.getToken();
      const resp = await getConfig(this.config.apiBase, token, userId, contextToken, fetchFn);
      if (resp.typing_ticket) {
        this.typingTickets.set(userId, { ticket: resp.typing_ticket, fetchedAt: Date.now() });
        return resp.typing_ticket;
      }
    } catch (err) {
      log("debug", `getTypingTicket failed for ${userId}: ${String(err)}`, this.config);
    }
    return undefined;
  }

  private startTyping(userId: string, typingTicket: string, fetchFn: typeof fetch): () => void {
    const doSend = async (status: 1 | 2) => {
      try {
        const token = await this.auth.getToken();
        await sendTyping(this.config.apiBase, token, userId, typingTicket, status, fetchFn);
      } catch { /* ignore */ }
    };
    void doSend(1);
    const timer = setInterval(() => void doSend(1), 5000);
    return () => {
      clearInterval(timer);
      void doSend(2);
    };
  }

  private isAllowed(userId: string): boolean {
    if (this.config.dmPolicy === "open") return true;
    return this.config.allowFrom.includes(userId);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
