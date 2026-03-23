import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { extname } from "node:path";
import type { Config } from "./config.js";
import type { Auth } from "./auth.js";
import { getUpdates, sendMessage, getConfig, sendTyping, WechatApiError } from "./wechat.js";
import { downloadMedia, uploadMedia, MEDIA_TYPE_IMAGE, MEDIA_TYPE_FILE, MEDIA_TYPE_VOICE } from "./media.js";
import { ingress, subscribePull, fileDownload } from "./daemon.js";
import { toSilk } from "./voice.js";

const MEDIA_TMP_DIR = "/tmp/channel-wechat-media";

const CONSUMER_ID = "channel-wechat";
const WS_RECONNECT_MS = 3_000;
const SLOW_RECONNECT_MS = 30_000;
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

        if (msgs.length > 0) {
          log("debug", `getUpdates: ${msgs.length} msgs, types=${msgs.map(m => `msg_type=${m.message_type} items=[${m.item_list?.map(i => i.type).join(",")}]`).join(" | ")}`, this.config);
        }

        for (const msg of msgs) {
          // Skip bot outgoing echoes (message_type 2), only process user messages (type 1)
          if (msg.message_type === 2) continue;

          if (!this.isAllowed(msg.from_user_id)) {
            log("debug", `Blocked message from ${msg.from_user_id}`, this.config);
            continue;
          }

          log("debug", `raw item_list from ${msg.from_user_id}: ${JSON.stringify(msg.item_list)}`, this.config);

          const text = msg.item_list
            ?.filter(i => i.type === 1 && i.text_item?.text)
            .map(i => i.text_item!.text)
            .join("") ?? "";

          // Download and save all media items (image/voice/file/video)
          await mkdir(MEDIA_TMP_DIR, { recursive: true });
          const attachments: Array<{ path: string; mime: string }> = [];

          for (const item of msg.item_list ?? []) {
            try {
              if (item.type === 2 && item.image_item?.media?.encrypt_query_param) {
                // IMAGE
                // aeskey (hex string) and media.aes_key (base64 of that hex string) are equivalent.
                // parseAesKey handles both base64(raw 16 bytes) and base64(hex 32 chars).
                // media.aes_key = base64(aeskey) so it is always the correct form for parseAesKey.
                const img = item.image_item;
                const aesKeyBase64 = img.media!.aes_key ?? (img.aeskey ? Buffer.from(img.aeskey).toString("base64") : undefined);
                if (!aesKeyBase64) continue;
                const buf = await downloadMedia({
                  cdnBaseUrl: this.config.cdnBase,
                  encryptQueryParam: img.media!.encrypt_query_param!,
                  aesKeyBase64,
                  fetchFn,
                });
                const fpath = `${MEDIA_TMP_DIR}/${Date.now()}-${randomBytes(4).toString("hex")}.jpg`;
                await writeFile(fpath, buf);
                attachments.push({ path: fpath, mime: "image/jpeg" });
                log("info", `Downloaded image → ${fpath} (${buf.length}B)`, this.config);

              } else if (item.type === 3 && item.voice_item?.media?.encrypt_query_param && item.voice_item.media.aes_key) {
                // VOICE
                const v = item.voice_item;
                const buf = await downloadMedia({
                  cdnBaseUrl: this.config.cdnBase,
                  encryptQueryParam: v.media!.encrypt_query_param!,
                  aesKeyBase64: v.media!.aes_key!,
                  fetchFn,
                });
                // Silk format by default; transcode not available here, pass as-is
                const fpath = `${MEDIA_TMP_DIR}/${Date.now()}-${randomBytes(4).toString("hex")}.silk`;
                await writeFile(fpath, buf);
                attachments.push({ path: fpath, mime: "audio/silk" });
                log("info", `Downloaded voice → ${fpath} (${buf.length}B)`, this.config);

              } else if (item.type === 4 && item.file_item?.media?.encrypt_query_param && item.file_item.media.aes_key) {
                // FILE
                const f = item.file_item;
                const buf = await downloadMedia({
                  cdnBaseUrl: this.config.cdnBase,
                  encryptQueryParam: f.media!.encrypt_query_param!,
                  aesKeyBase64: f.media!.aes_key!,
                  fetchFn,
                });
                const origName = f.file_name ?? "file.bin";
                const ext = extname(origName) || ".bin";
                const mime = guessMime(origName);
                const fpath = `${MEDIA_TMP_DIR}/${Date.now()}-${randomBytes(4).toString("hex")}${ext}`;
                await writeFile(fpath, buf);
                attachments.push({ path: fpath, mime });
                log("info", `Downloaded file "${origName}" → ${fpath} (${buf.length}B)`, this.config);

              } else if (item.type === 5 && item.video_item?.media?.encrypt_query_param && item.video_item.media.aes_key) {
                // VIDEO
                const vid = item.video_item;
                const buf = await downloadMedia({
                  cdnBaseUrl: this.config.cdnBase,
                  encryptQueryParam: vid.media!.encrypt_query_param!,
                  aesKeyBase64: vid.media!.aes_key!,
                  fetchFn,
                });
                const fpath = `${MEDIA_TMP_DIR}/${Date.now()}-${randomBytes(4).toString("hex")}.mp4`;
                await writeFile(fpath, buf);
                attachments.push({ path: fpath, mime: "video/mp4" });
                log("info", `Downloaded video → ${fpath} (${buf.length}B)`, this.config);
              }
            } catch (err) {
              log("warn", `Failed to download media item type=${item.type}: ${String(err)}`, this.config);
            }
          }

          if (!text && attachments.length === 0) {
            log("debug", `Non-text/media message from ${msg.from_user_id}, skipping`, this.config);
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

          log("info", `Ingress from ${msg.from_user_id} text=${JSON.stringify(text.slice(0, 80))} attachments=${attachments.length}`, this.config);

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
                attachments,
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
   * pullLoop — establishes a persistent WebSocket subscription per session,
   * delivering daemon outbox messages back to WeChat.
   *
   * Uses `subscribePull` so the daemon registers `channel_capabilities`
   * server-side (via wit()), enabling attachment delivery.
   */
  private async pullLoop(fetchFn: typeof fetch): Promise<void> {
    log("info", "pullLoop started (WebSocket mode)", this.config);

    // -----------------------------------------------------------------------
    // Capability heartbeat WS — registers channel_capabilities immediately on
    // startup so the daemon knows this channel accepts attachments, without
    // waiting for a real user session to appear.  Uses a sentinel session key
    // that never receives actual output (no real user sends from that key).
    // -----------------------------------------------------------------------
    const CAP_SENTINEL = "wechat:__cap_heartbeat__";
    // eslint-disable-next-line prefer-const
    let capCleanup: (() => void) | null;
    capCleanup = null as (() => void) | null;

    const ensureCapHeartbeat = () => {
      if (capCleanup) return;
      log("debug", "Registering capability heartbeat WS", this.config);
      capCleanup = subscribePull({
        daemonUrl: this.config.daemonUrl,
        sessionKey: CAP_SENTINEL,
        consumerId: CONSUMER_ID,
        sourceKind: "wechat",
        onOutput: async () => { /* sentinel session never receives real output */ },
        onAck: () => {},
        onError: () => {},
        onClose: () => {
          capCleanup = null;
          if (!this.running) return;
          // Reconnect after a short delay to keep capabilities registered
          setTimeout(ensureCapHeartbeat, WS_RECONNECT_MS);
        },
      });
    };
    ensureCapHeartbeat();

    // sessionKey → WS cleanup function
    const wsCleanups = new Map<string, () => void>();
    // Per-session consecutive error count
    const errorCounts = new Map<string, number>();

    const ensureSubscribed = (sessionKey: string, state: {
      toUser: string;
      contextToken: string | undefined;
      cursor: string;
      stopTyping?: () => void;
    }) => {
      if (wsCleanups.has(sessionKey)) return;

      log("info", `WS subscribing for ${sessionKey}`, this.config);

      const cleanup = subscribePull({
        daemonUrl: this.config.daemonUrl,
        sessionKey,
        consumerId: CONSUMER_ID,
        cursor: state.cursor || undefined,
        sourceKind: "wechat",
        onOutput: async (payload) => {
          const token = await this.auth.getToken();
          const attachments = payload.attachments ?? [];

          if (attachments.length > 0) {
            // Send each attachment, then the text (if any) after the last one
            for (let i = 0; i < attachments.length; i++) {
              const att = attachments[i];
              const isLast = i === attachments.length - 1;
              const textForThisItem = isLast ? (payload.text ?? "") : "";
              log("info", `Sending attachment to ${state.toUser}: ${att.path} (${att.mime})`, this.config);
              try {
                // Download attachment content via RPC — the path is daemon-internal
                // and the channel/session may run on different machines.
                const fileBuffer = await fileDownload(this.config.daemonUrl, att.path, fetchFn);
                const isImage = att.mime.startsWith("image/");
                const isAudio = att.mime.startsWith("audio/");

                if (isAudio) {
                  // Transcode to SILK, then send as voice message (type:3)
                  const { silk, playtimeMs } = await toSilk(fileBuffer, att.mime);
                  const uploaded = await uploadMedia({
                    apiBase: this.config.apiBase,
                    cdnBase: this.config.cdnBase,
                    token,
                    filePath: silk,
                    toUserId: state.toUser,
                    mediaType: MEDIA_TYPE_VOICE,
                    fetchFn,
                  });
                  await sendMessage(
                    this.config.apiBase,
                    token,
                    state.toUser,
                    textForThisItem,
                    state.contextToken,
                    fetchFn,
                    { kind: "voice", item: { encryptQueryParam: uploaded.encryptQueryParam, aesKeyBase64: uploaded.aesKeyBase64, playtimeMs } },
                  );
                } else {
                  const uploaded = await uploadMedia({
                    apiBase: this.config.apiBase,
                    cdnBase: this.config.cdnBase,
                    token,
                    filePath: fileBuffer,
                    toUserId: state.toUser,
                    mediaType: isImage ? MEDIA_TYPE_IMAGE : MEDIA_TYPE_FILE,
                    fetchFn,
                  });
                  const fileName = att.path.split("/").pop() ?? "file";
                  await sendMessage(
                    this.config.apiBase,
                    token,
                    state.toUser,
                    textForThisItem,
                    state.contextToken,
                    fetchFn,
                    isImage
                      ? { encryptQueryParam: uploaded.encryptQueryParam, aesKeyBase64: uploaded.aesKeyBase64, midSize: uploaded.fileSizeCiphertext }
                      : { kind: "file", item: { encryptQueryParam: uploaded.encryptQueryParam, aesKeyBase64: uploaded.aesKeyBase64, fileName, fileSize: uploaded.rawSize } },
                  );
                }
              } catch (err) {
                if (err instanceof WechatApiError && err.errcode === -14) {
                  this.auth.invalidateToken();
                }
                log("error", `sendAttachment failed to ${state.toUser}: ${String(err)}`, this.config);
                // Fallback: send text only for the last attachment
                if (isLast && payload.text) {
                  await sendMessage(this.config.apiBase, token, state.toUser, payload.text, state.contextToken, fetchFn).catch(e =>
                    log("error", `sendMessage fallback failed: ${String(e)}`, this.config)
                  );
                }
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
              }
              log("error", `sendMessage failed to ${state.toUser}: ${String(err)}`, this.config);
            }
          }

          // Stop typing indicator after delivery
          if (state.stopTyping) {
            state.stopTyping();
            state.stopTyping = undefined;
          }
        },
        onAck: (cursor) => {
          state.cursor = cursor;
          errorCounts.set(sessionKey, 0);
        },
        onError: (err) => {
          const count = (errorCounts.get(sessionKey) ?? 0) + 1;
          errorCounts.set(sessionKey, count);
          log("error", `WS error for ${sessionKey} (${count}): ${String(err)}`, this.config);
        },
        onClose: () => {
          wsCleanups.delete(sessionKey);
          if (!this.running) return;
          const errors = errorCounts.get(sessionKey) ?? 0;
          const delay = errors >= MAX_CONSECUTIVE_ERRORS ? SLOW_RECONNECT_MS : WS_RECONNECT_MS;
          log("info", `WS closed for ${sessionKey}, reconnecting in ${delay}ms`, this.config);
          setTimeout(() => {
            if (this.running && this.sessions.has(sessionKey)) {
              const s = this.sessions.get(sessionKey)!;
              ensureSubscribed(sessionKey, s);
            }
          }, delay);
        },
      });

      wsCleanups.set(sessionKey, cleanup);
    };

    while (this.running) {
      // Subscribe any new sessions
      for (const [sessionKey, state] of this.sessions) {
        ensureSubscribed(sessionKey, state);
      }

      // Clean up WS connections for sessions that have disappeared
      for (const [sessionKey, cleanup] of wsCleanups) {
        if (!this.sessions.has(sessionKey)) {
          cleanup();
          wsCleanups.delete(sessionKey);
        }
      }

      await sleep(1_000, this.abortController.signal);
    }

    // Shut down all connections on stop
    const finalCapCleanup = capCleanup;
    capCleanup = null;
    finalCapCleanup?.();
    for (const cleanup of wsCleanups.values()) {
      cleanup();
    }
    wsCleanups.clear();
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

/** Best-effort MIME type guess from filename extension. */
function guessMime(filename: string): string {
  const ext = extname(filename).toLowerCase();
  const map: Record<string, string> = {
    ".pdf":  "application/pdf",
    ".doc":  "application/msword",
    ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls":  "application/vnd.ms-excel",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".ppt":  "application/vnd.ms-powerpoint",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip":  "application/zip",
    ".txt":  "text/plain",
    ".csv":  "text/csv",
    ".json": "application/json",
    ".png":  "image/png",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif":  "image/gif",
    ".webp": "image/webp",
    ".mp4":  "video/mp4",
    ".mov":  "video/quicktime",
    ".mp3":  "audio/mpeg",
    ".m4a":  "audio/mp4",
    ".wav":  "audio/wav",
  };
  return map[ext] ?? "application/octet-stream";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });
}
