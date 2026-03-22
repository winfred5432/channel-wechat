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
 * Subsequent calls return a terminal empty-updates response to prevent tight loops.
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
        // Schedule stop after this response resolves
        setImmediate(onExhausted);
      }
      return { ok: true, status: 200, json: async () => response.body };
    }

    // Fallback: never-resolving promise to halt the loop without tight-looping
    return new Promise(() => {});
  }) as unknown as typeof fetch;

  return { fetchFn, calls };
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
            errcode: 0,
            errmsg: "ok",
            msg_list: [{ msgid: "1", from: "blocked-user", content: "hi" }],
            sync_buf: "BUF2",
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
            errcode: 0,
            errmsg: "ok",
            msg_list: [{ msgid: "1", from: "allowed-user", content: "hi" }],
            sync_buf: "BUF2",
          },
        },
        { body: { jsonrpc: "2.0", id: 1, result: null } },   // ingress
        { body: { jsonrpc: "2.0", id: 2, result: [] } },     // pull (empty)
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
            errcode: 0,
            errmsg: "ok",
            msg_list: [{ msgid: "1", from: "random-user", content: "hello" }],
            sync_buf: "S",
          },
        },
        { body: { jsonrpc: "2.0", id: 1, result: null } },  // ingress
        { body: { jsonrpc: "2.0", id: 2, result: [] } },    // pull
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
            errcode: 0,
            errmsg: "ok",
            msg_list: [{ msgid: "m1", from: "u1", content: "question" }],
            sync_buf: "S",
          },
        },
        { body: { jsonrpc: "2.0", id: 1, result: null } },  // ingress
        {
          body: {
            jsonrpc: "2.0",
            id: 2,
            result: [{ sessionKey: "wechat:u1", text: "answer", raw: { outbox_id: "OBX1" } }],
          },
        },
        { body: { errcode: 0, errmsg: "ok" } },              // sendmessage
        { body: { jsonrpc: "2.0", id: 3, result: null } },   // ack
        { body: { jsonrpc: "2.0", id: 4, result: [] } },     // next pull (empty)
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
    expect(sendCalls[0].body?.to).toBe("u1");
    expect(sendCalls[0].body?.content).toBe("answer");
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
        return { ok: true, json: async () => ({ errcode: -14, errmsg: "token invalid" }) };
      }
      // Second call: succeed, then stop
      setImmediate(() => gateway.stop());
      return { ok: true, json: async () => ({ errcode: 0, errmsg: "ok", msg_list: [], sync_buf: "" }) };
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
