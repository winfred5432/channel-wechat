import { describe, it, expect, vi } from "vitest";
import type { Config } from "../src/config.js";
import type { Auth } from "../src/auth.js";
import { Gateway } from "../src/gateway.js";

// gateway.ts → auth.ts → qrcode: mock to prevent heavy import
vi.mock("qrcode", () => ({
  default: { toFile: vi.fn().mockResolvedValue(undefined) },
}));

const BASE_CONFIG: Config = {
  daemonUrl: "http://127.0.0.1:20233",
  apiBase: "https://ilinkai.weixin.qq.com",
  dmPolicy: "open",
  allowFrom: [],
  stateDir: "/tmp/test-state",
  logLevel: "error",
};

function makeAuth(token = "TOKEN", syncBuf = ""): Auth {
  return {
    getToken: vi.fn().mockResolvedValue(token),
    getSyncBuf: vi.fn().mockResolvedValue(syncBuf),
    saveSyncBuf: vi.fn().mockResolvedValue(undefined),
    invalidateToken: vi.fn(),
    startQrLogin: vi.fn().mockResolvedValue(token),
  } as unknown as Auth;
}

interface FetchCall {
  url: string;
  body?: Record<string, unknown>;
}

/**
 * Returns a fetchFn that serves the given responses in order.
 * After the last response is used, calls `onExhausted()` so the test can stop the gateway.
 * Subsequent calls return a never-resolving promise to prevent tight loops.
 */
function makeFetchSequence(
  responses: Array<{ body: unknown }>,
  onExhausted: () => void,
): { fetchFn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  let idx = 0;
  let exhausted = false;

  const fetchFn = vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body as string) : undefined });

    if (idx < responses.length) {
      const response = responses[idx++];
      if (idx === responses.length && !exhausted) {
        exhausted = true;
        setImmediate(onExhausted);
      }
      const bodyStr = JSON.stringify(response.body);
      return { ok: true, status: 200, json: async () => response.body, text: async () => bodyStr };
    }

    // Fallback: suspend until the gateway is stopped (abort signal fires)
    const signal = opts?.signal;
    return new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }) as unknown as typeof fetch;

  return { fetchFn, calls };
}

/** Build a WeChat getUpdates response with real message structure */
function wechatMsg(opts: {
  messageId?: string;
  fromUserId?: string;
  text?: string;
  contextToken?: string;
  messageType?: number;
}) {
  return {
    message_id: opts.messageId ?? "1",
    from_user_id: opts.fromUserId ?? "user1",
    message_type: opts.messageType ?? 1,
    item_list: opts.text ? [{ type: 1, text_item: { text: opts.text } }] : [],
    context_token: opts.contextToken,
  };
}

/** Build a daemon pull result with records wrapper */
function pullResult(records: unknown[]) {
  return { jsonrpc: "2.0", id: 1, result: { records, idle: records.length === 0 } };
}

describe("Gateway allowlist filtering", () => {
  it("blocks messages from users not in allowlist", async () => {
    const config: Config = { ...BASE_CONFIG, dmPolicy: "allowlist", allowFrom: ["allowed-user"] };
    const auth = makeAuth();

    let gateway: Gateway;
    const { fetchFn, calls } = makeFetchSequence(
      [
        {
          body: {
            ret: 0,
            msgs: [wechatMsg({ fromUserId: "blocked-user", text: "hi" })],
            get_updates_buf: "BUF2",
          },
        },
      ],
      () => gateway.stop(),
    );

    gateway = new Gateway(config, auth, fetchFn);
    await new Promise<void>((resolve) => {
      const orig = gateway.stop.bind(gateway);
      gateway.stop = () => { orig(); resolve(); };
      gateway.start();
    });

    const ingressCalls = calls.filter((c) => c.body?.method === "channel.ingress");
    expect(ingressCalls).toHaveLength(0);
  });

  it("allows messages from users in allowlist", async () => {
    const config: Config = { ...BASE_CONFIG, dmPolicy: "allowlist", allowFrom: ["allowed-user"] };
    const auth = makeAuth();

    let gateway: Gateway;
    const { fetchFn, calls } = makeFetchSequence(
      [
        {
          body: {
            ret: 0,
            msgs: [wechatMsg({ fromUserId: "allowed-user", text: "hi" })],
            get_updates_buf: "BUF2",
          },
        },
        { body: { jsonrpc: "2.0", id: 1, result: null } },   // ingress
        { body: pullResult([]) },                             // pull (empty)
      ],
      () => gateway.stop(),
    );

    gateway = new Gateway(config, auth, fetchFn);
    await new Promise<void>((resolve) => {
      const orig = gateway.stop.bind(gateway);
      gateway.stop = () => { orig(); resolve(); };
      gateway.start();
    });

    const ingressCalls = calls.filter(
      (c) => c.url.includes("rpc") && c.body?.method === "channel.ingress",
    );
    expect(ingressCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("Gateway open policy", () => {
  it("accepts messages from any user and sets source_kind=wechat", async () => {
    const config = { ...BASE_CONFIG, dmPolicy: "open" as const };
    const auth = makeAuth();

    let gateway: Gateway;
    const { fetchFn, calls } = makeFetchSequence(
      [
        {
          body: {
            ret: 0,
            msgs: [wechatMsg({ fromUserId: "random-user", text: "hello" })],
            get_updates_buf: "S",
          },
        },
        { body: { jsonrpc: "2.0", id: 1, result: null } },  // ingress
        { body: pullResult([]) },                            // pull
      ],
      () => gateway.stop(),
    );

    gateway = new Gateway(config, auth, fetchFn);
    await new Promise<void>((resolve) => {
      const orig = gateway.stop.bind(gateway);
      gateway.stop = () => { orig(); resolve(); };
      gateway.start();
    });

    const ingressCalls = calls.filter(
      (c) => c.url.includes("rpc") && c.body?.method === "channel.ingress",
    );
    expect(ingressCalls.length).toBeGreaterThanOrEqual(1);
    const params = ingressCalls[0].body?.params as Record<string, string>;
    expect(params.session_key).toBe("wechat:random-user");
    expect(params.source_kind).toBe("wechat");
  });
});

describe("Gateway pull and send flow", () => {
  it("sends pulled text back to WeChat user", async () => {
    const config = { ...BASE_CONFIG };
    const auth = makeAuth();

    let gateway: Gateway;
    const { fetchFn, calls } = makeFetchSequence(
      [
        {
          body: {
            ret: 0,
            msgs: [wechatMsg({ fromUserId: "u1", text: "question", contextToken: "CTX1" })],
            get_updates_buf: "S",
          },
        },
        { body: { jsonrpc: "2.0", id: 1, result: null } },  // ingress
        {
          body: pullResult([
            { session_key: "wechat:u1", text: "answer", raw: { id: "OBX1" } },
          ]),
        },
        { body: { ret: 0 } },                                // sendmessage
        { body: { jsonrpc: "2.0", id: 3, result: null } },  // ack
        { body: pullResult([]) },                            // next pull (empty)
      ],
      () => gateway.stop(),
    );

    gateway = new Gateway(config, auth, fetchFn);
    await new Promise<void>((resolve) => {
      const orig = gateway.stop.bind(gateway);
      gateway.stop = () => { orig(); resolve(); };
      gateway.start();
    });

    const sendCalls = calls.filter((c) => c.url.includes("sendmessage"));
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    // Verify correct ilink message format
    expect(sendCalls[0].body?.msg).toMatchObject({
      to_user_id: "u1",
      item_list: [{ type: 1, text_item: { text: "answer" } }],
      context_token: "CTX1",
    });
  });

  it("skips non-text messages (no item_list text)", async () => {
    const config = { ...BASE_CONFIG };
    const auth = makeAuth();

    let gateway: Gateway;
    const { fetchFn, calls } = makeFetchSequence(
      [
        {
          body: {
            ret: 0,
            msgs: [{ message_id: "1", from_user_id: "u1", message_type: 1, item_list: [{ type: 2 }] }],
            get_updates_buf: "S",
          },
        },
      ],
      () => gateway.stop(),
    );

    gateway = new Gateway(config, auth, fetchFn);
    await new Promise<void>((resolve) => {
      const orig = gateway.stop.bind(gateway);
      gateway.stop = () => { orig(); resolve(); };
      gateway.start();
    });

    const ingressCalls = calls.filter((c) => c.body?.method === "channel.ingress");
    expect(ingressCalls).toHaveLength(0);
  });
});

describe("Gateway error recovery", () => {
  it("re-authenticates on errcode -14", async () => {
    const config = { ...BASE_CONFIG };
    const auth = makeAuth();

    let gateway: Gateway;
    let callCount = 0;
    const fetchFn = vi.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        const b1 = JSON.stringify({ ret: -14, errmsg: "token invalid" });
        return { ok: true, json: async () => JSON.parse(b1), text: async () => b1 };
      }
      setImmediate(() => gateway.stop());
      const b2 = JSON.stringify({ ret: 0, msgs: [], get_updates_buf: "" });
      return { ok: true, json: async () => JSON.parse(b2), text: async () => b2 };
    }) as unknown as typeof fetch;

    gateway = new Gateway(config, auth, fetchFn);
    await new Promise<void>((resolve) => {
      const orig = gateway.stop.bind(gateway);
      gateway.stop = () => { orig(); resolve(); };
      gateway.start();
    });

    expect((auth.invalidateToken as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
