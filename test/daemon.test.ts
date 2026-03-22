import { describe, it, expect, vi } from "vitest";
import { ingress, pull, ack, DaemonError } from "../src/daemon.js";

const DAEMON_URL = "http://127.0.0.1:20233";

function makeFetch(result?: unknown, error?: { code: number; message: string }): typeof fetch {
  const response = error
    ? { jsonrpc: "2.0", id: 1, error }
    : { jsonrpc: "2.0", id: 1, result: result ?? null };
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => response,
  }) as unknown as typeof fetch;
}

function extractRequest(fetchFn: typeof fetch): { method: string; params: unknown } {
  const body = JSON.parse(
    ((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit).body as string,
  );
  return body;
}

describe("ingress", () => {
  it("calls channel.ingress RPC", async () => {
    const fetchFn = makeFetch();
    await ingress(DAEMON_URL, { session_key: "wechat:user1", text: "hello" }, fetchFn);
    const req = extractRequest(fetchFn);
    expect(req.method).toBe("channel.ingress");
    expect((req.params as { session_key: string }).session_key).toBe("wechat:user1");
  });

  it("posts to /rpc endpoint", async () => {
    const fetchFn = makeFetch();
    await ingress(DAEMON_URL, { session_key: "k", text: "t" }, fetchFn);
    const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(url).toBe(`${DAEMON_URL}/rpc`);
  });

  it("throws DaemonError on RPC error", async () => {
    const fetchFn = makeFetch(undefined, { code: -32000, message: "bad request" });
    await expect(ingress(DAEMON_URL, { session_key: "k" }, fetchFn)).rejects.toThrow(DaemonError);
  });

  it("throws on HTTP error", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    await expect(ingress(DAEMON_URL, { session_key: "k" }, fetchFn)).rejects.toThrow("HTTP 503");
  });
});

/** Minimal OutboxRecord that satisfies outboxToOutbound */
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

describe("pull", () => {
  it("calls channel.pull and maps OutboxRecords to OutboundChannelPayloads", async () => {
    const record = makeOutboxRecord("REC1", "wechat:u1", "hello");
    const fetchFn = makeFetch({ records: [record], idle: false });
    const result = await pull(
      DAEMON_URL,
      { session_key: "wechat:u1", consumer_id: "channel-wechat" },
      fetchFn,
    );
    expect(result).toHaveLength(1);
    expect(result[0].sessionKey).toBe("wechat:u1");
    expect(result[0].text).toBe("hello");
    expect((result[0].raw as { id: string }).id).toBe("REC1");
    const req = extractRequest(fetchFn);
    expect(req.method).toBe("channel.pull");
  });

  it("returns empty array when result is null", async () => {
    const fetchFn = makeFetch(null);
    const result = await pull(DAEMON_URL, { session_key: "s", consumer_id: "cw" }, fetchFn);
    expect(result).toEqual([]);
  });

  it("includes cursor and limit in params", async () => {
    const fetchFn = makeFetch({ records: [], idle: true });
    await pull(
      DAEMON_URL,
      { session_key: "s", consumer_id: "cw", cursor: "C1", limit: 5 },
      fetchFn,
    );
    const req = extractRequest(fetchFn);
    const params = req.params as Record<string, unknown>;
    expect(params.cursor).toBe("C1");
    expect(params.limit).toBe(5);
  });
});

describe("ack", () => {
  it("calls channel.ack RPC", async () => {
    const fetchFn = makeFetch();
    await ack(
      DAEMON_URL,
      { session_key: "s", consumer_id: "channel-wechat", cursor: "C1" },
      fetchFn,
    );
    const req = extractRequest(fetchFn);
    expect(req.method).toBe("channel.ack");
    const params = req.params as Record<string, unknown>;
    expect(params.cursor).toBe("C1");
  });

  it("throws DaemonError on RPC error", async () => {
    const fetchFn = makeFetch(undefined, { code: -32600, message: "invalid request" });
    await expect(
      ack(DAEMON_URL, { session_key: "s", consumer_id: "cw", cursor: "C" }, fetchFn),
    ).rejects.toThrow(DaemonError);
  });
});
