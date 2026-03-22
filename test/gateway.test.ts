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
  cdnBase: "https://cdn.ilinkai.weixin.qq.com",
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

type UrlPattern = string | RegExp;

/**
 * URL-routed fetch mock. Each entry routes to a specific ilink/daemon endpoint.
 *
 * Responses are served by matching against the URL in order within each endpoint's queue.
 * This prevents ingressLoop and pullLoop from competing for the same sequential mock.
 *
 * Special endpoints:
 * - "getconfig" and "sendtyping" always return {ret:0} immediately (typing indicator).
 * - Unmatched calls or exhausted queues suspend on the abort signal.
 *
 * onExhausted is called once all non-typing queues are drained.
 */
function makeFetchRouted(
  routes: Array<{ match: UrlPattern; responses: Array<{ body: unknown }> }>,
  onExhausted: () => void,
): { fetchFn: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const queues = routes.map(r => ({ match: r.match, queue: [...r.responses] }));
  let exhausted = false;

  function checkExhausted() {
    if (!exhausted && queues.every(q => q.queue.length === 0)) {
      exhausted = true;
      setImmediate(onExhausted);
    }
  }

  const fetchFn = vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
    calls.push({ url, body: opts?.body ? JSON.parse(opts.body as string) : undefined });

    // Typing indicator: always return OK without touching queues
    if (typeof url === "string" && (url.includes("getconfig") || url.includes("sendtyping"))) {
      return { ok: true, status: 200, json: async () => ({ ret: 0 }), text: async () => '{"ret":0}' };
    }

    // Find matching route
    for (const route of queues) {
      const matched = typeof route.match === "string"
        ? url.includes(route.match)
        : route.match.test(url);
      if (matched && route.queue.length > 0) {
        const response = route.queue.shift()!;
        checkExhausted();
        const bodyStr = JSON.stringify(response.body);
        return { ok: true, status: 200, json: async () => response.body, text: async () => bodyStr };
      }
    }

    // No match or exhausted queue: suspend until abort
    const signal = opts?.signal;
    return new Promise<never>((_resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException("Aborted", "AbortError")); return; }
      signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
  }) as unknown as typeof fetch;

  return { fetchFn, calls };
}

/**
 * Simple sequential fetch mock for tests where only one fetch pattern is expected
 * (e.g., ingressLoop-only tests that never reach pullLoop).
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

    // Typing indicator: serve immediately without consuming the sequence
    if (typeof url === "string" && (url.includes("getconfig") || url.includes("sendtyping"))) {
      return { ok: true, status: 200, json: async () => ({ ret: 0 }), text: async () => '{"ret":0}' };
    }

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

/** Minimal OutboxRecord for pull responses (matches outboxToOutbound expectations) */
function makeOutboxRecord(id: string, sessionKey: string, text: string) {
  return {
    id,
    created_at: new Date().toISOString(),
    channel_kind: "wechat",
    session_key: sessionKey,
    payload: { text },
    status: "pending" as const,
    attempts: 0,
    last_attempt_at: null,
    last_error: null,
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
    // Use URL-routed mock to prevent ingressLoop and pullLoop from competing
    // for the same sequential response queue.
    const { fetchFn, calls } = makeFetchRouted(
      [
        {
          match: "getupdates",
          responses: [
            // First poll: message from u1
            {
              body: {
                ret: 0,
                msgs: [wechatMsg({ fromUserId: "u1", text: "question", contextToken: "CTX1" })],
                get_updates_buf: "S",
              },
            },
            // Subsequent polls: empty (suspends after this queue is exhausted)
          ],
        },
        {
          match: "/rpc",
          responses: [
            { body: { jsonrpc: "2.0", id: 1, result: null } },          // ingress
            { body: pullResult([makeOutboxRecord("OBX1", "wechat:u1", "answer")]) }, // pull
            { body: { jsonrpc: "2.0", id: 3, result: null } },          // ack
            { body: pullResult([]) },                                     // next pull empty → stop
          ],
        },
        {
          match: "sendmessage",
          responses: [
            { body: { ret: 0 } },  // sendmessage reply
          ],
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

    const sendCalls = calls.filter((c) => c.url.includes("sendmessage"));
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    // Verify correct ilink message format
    expect(sendCalls[0].body?.msg).toMatchObject({
      to_user_id: "u1",
      item_list: [{ type: 1, text_item: { text: "answer" } }],
      context_token: "CTX1",
    });
  });

  it("skips messages with no text and no images", async () => {
    // Regression: type:3 (non-text, non-image) message should be skipped entirely
    const config = { ...BASE_CONFIG };
    const auth = makeAuth();

    let gateway: Gateway;
    const { fetchFn, calls } = makeFetchSequence(
      [
        {
          body: {
            ret: 0,
            msgs: [{ message_id: "1", from_user_id: "u1", message_type: 1, item_list: [{ type: 3 }] }],
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

  it("ingresses image-only messages via attachments (regression: combinedText was not defined)", async () => {
    // Regression test: image item (type:2) without text must still trigger ingress.
    // Previously this crashed with "ReferenceError: combinedText is not defined".
    const config = { ...BASE_CONFIG };
    const auth = makeAuth();

    let gateway: Gateway;
    const imageMsg = {
      message_id: "img-1",
      from_user_id: "u1",
      message_type: 1,
      context_token: "ctx",
      item_list: [{
        type: 2,
        image_item: { media: { encrypt_query_param: "eqp=abc", aes_key: Buffer.from("0123456789abcdef").toString("base64") } },
      }],
    };

    // Use URL-routed mock to avoid ingressLoop consuming ingress responses with getupdates calls.
    // CDN download returns an ArrayBuffer (binary content); routed separately from JSON APIs.
    const { fetchFn: routedFetch, calls } = makeFetchRouted(
      [
        {
          match: "getupdates",
          responses: [{ body: { ret: 0, msgs: [imageMsg], get_updates_buf: "S" } }],
        },
        {
          match: "/rpc",
          responses: [{ body: { jsonrpc: "2.0", id: 1, result: null } }],  // ingress
        },
      ],
      () => gateway.stop(),
    );

    // Wrap to intercept CDN download and return binary ArrayBuffer.
    // The ciphertext must have valid AES-128-ECB + PKCS7 padding so decryption succeeds.
    // Encrypted with key=Buffer.from("0123456789abcdef"), plaintext="hello":
    const validCiphertext = new Uint8Array([103, 76, 126, 243, 142, 120, 202, 189, 156, 236, 156, 18, 88, 35, 166, 57]);
    const fetchFn = vi.fn().mockImplementation(async (url: string, opts?: RequestInit) => {
      if (typeof url === "string" && url.includes("download")) {
        return { ok: true, status: 200, arrayBuffer: async () => validCiphertext.buffer.slice(0) };
      }
      return (routedFetch as ReturnType<typeof vi.fn>)(url, opts);
    }) as unknown as typeof fetch;

    gateway = new Gateway(config, auth, fetchFn);
    await new Promise<void>((resolve) => {
      const orig = gateway.stop.bind(gateway);
      gateway.stop = () => { orig(); resolve(); };
      gateway.start();
    });

    const ingressCalls = calls.filter((c) => c.body?.method === "channel.ingress");
    // Must have called ingress (not crashed/skipped)
    expect(ingressCalls.length).toBeGreaterThanOrEqual(1);
    // text should be undefined (image-only), attachments should be present
    const ingressBody = ingressCalls[0]?.body?.params as Record<string, unknown> | undefined;
    expect(ingressBody?.session_key).toBe("wechat:u1");
    expect(Array.isArray(ingressBody?.attachments)).toBe(true);
  });
});

describe("Gateway error recovery", () => {
  it("re-authenticates on errcode -14", async () => {
    const config = { ...BASE_CONFIG };
    const auth = makeAuth();

    let gateway: Gateway;
    // Use makeFetchRouted so subsequent getUpdates calls suspend on the abort signal
    // rather than returning immediately in a tight loop.
    const { fetchFn } = makeFetchRouted(
      [
        {
          match: "getupdates",
          responses: [
            // First call: returns -14 to trigger invalidateToken
            { body: { ret: -14, errmsg: "token invalid" } },
            // Second call: empty response, triggers stop()
            { body: { ret: 0, msgs: [], get_updates_buf: "" } },
          ],
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

    expect((auth.invalidateToken as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});
