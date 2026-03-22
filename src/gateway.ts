import type { Config } from "./config.js";
import type { Auth } from "./auth.js";
import { getUpdates, sendMessage, WechatApiError, type MessageState } from "./wechat.js";
import { ingress, pull, ack } from "./daemon.js";

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
  }>();

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

          if (!text) {
            log("debug", `Non-text message from ${msg.from_user_id}, skipping`, this.config);
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

          log("info", `Ingress from ${msg.from_user_id} text=${JSON.stringify(text.slice(0, 80))}`, this.config);

          // Immediately show typing indicator before LLM processing begins
          try {
            const sessionState = this.sessions.get(sessionKey);
            await sendMessage(
              this.config.apiBase, token, msg.from_user_id,
              "...", sessionState?.contextToken, fetchFn, 1,
            );
            log("debug", `Typing indicator sent to ${msg.from_user_id}`, this.config);
          } catch (err) {
            log("debug", `Typing indicator failed (non-fatal): ${String(err)}`, this.config);
          }

          try {
            await ingress(
              this.config.daemonUrl,
              {
                session_key: sessionKey,
                text,
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
              return_mask: ["final", "stream"],
            },
            fetchFn,
          );

          consecutiveErrors = 0;

          for (const payload of payloads) {
            if (payload.text) {
              // Derive message_state from OutboxRecord.stream:
              //   stream present + is_final=false → 1 (SENDING, typing indicator)
              //   stream present + is_final=true  → 2 (FINISH)
              //   no stream field                 → 2 (FINISH, non-streaming reply)
              const raw = payload.raw as Record<string, unknown> | null;
              const stream = raw?.stream as { is_final?: boolean } | undefined;
              const messageState: MessageState =
                stream !== undefined && stream.is_final === false ? 1 : 2;

              log(
                "info",
                `Sending reply to ${state.toUser} state=${messageState}: ${payload.text.slice(0, 60)}`,
                this.config,
              );
              try {
                await sendMessage(
                  this.config.apiBase,
                  token,
                  state.toUser,
                  payload.text,
                  state.contextToken,
                  fetchFn,
                  messageState,
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
