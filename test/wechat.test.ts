import { describe, it, expect, vi } from "vitest";
import {
  getQrCode,
  pollQrStatus,
  getUpdates,
  sendMessage,
  splitText,
  WechatApiError,
  CHUNK_SIZE,
} from "../src/wechat.js";

const BASE = "https://ilinkai.weixin.qq.com";

function makeFetch(response: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => response,
  }) as unknown as typeof fetch;
}

describe("getQrCode", () => {
  it("returns qrcode and token on success", async () => {
    const fetchFn = makeFetch({ errcode: 0, errmsg: "ok", qrcode: "QR123", token: "TOK" });
    const result = await getQrCode(BASE, fetchFn);
    expect(result).toEqual({ qrcode: "QR123", token: "TOK" });
    expect(fetchFn).toHaveBeenCalledWith(
      `${BASE}/ilink/bot/get_bot_qrcode?bot_type=3`,
      { method: "GET" },
    );
  });

  it("throws WechatApiError on non-zero errcode", async () => {
    const fetchFn = makeFetch({ errcode: -1, errmsg: "invalid" });
    await expect(getQrCode(BASE, fetchFn)).rejects.toThrow(WechatApiError);
  });

  it("throws on HTTP error", async () => {
    const fetchFn = makeFetch({}, 500);
    await expect(getQrCode(BASE, fetchFn)).rejects.toThrow("HTTP 500");
  });
});

describe("pollQrStatus", () => {
  it("returns waiting status", async () => {
    const fetchFn = makeFetch({ errcode: 0, errmsg: "ok", status: "waiting" });
    const result = await pollQrStatus(BASE, "QR123", fetchFn);
    expect(result.status).toBe("waiting");
    expect(result.token).toBeUndefined();
  });

  it("returns confirmed status with token", async () => {
    const fetchFn = makeFetch({ errcode: 0, errmsg: "ok", status: "confirmed", token: "REALTOKEN" });
    const result = await pollQrStatus(BASE, "QR123", fetchFn);
    expect(result.status).toBe("confirmed");
    expect(result.token).toBe("REALTOKEN");
  });

  it("throws WechatApiError on errcode -14 (expired)", async () => {
    const fetchFn = makeFetch({ errcode: -14, errmsg: "qrcode expired" });
    await expect(pollQrStatus(BASE, "QR123", fetchFn)).rejects.toThrow(WechatApiError);
  });

  it("encodes qrcode in URL", async () => {
    const fetchFn = makeFetch({ errcode: 0, errmsg: "ok", status: "waiting" });
    await pollQrStatus(BASE, "QR 123+/=", fetchFn);
    const calledUrl = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("qrcode=QR%20123%2B%2F%3D");
  });
});

describe("getUpdates", () => {
  it("returns messages and new syncBuf", async () => {
    const msgs = [
      { msgid: "1", from: "user1", content: "hello", msg_type: 1 },
    ];
    const fetchFn = makeFetch({ errcode: 0, errmsg: "ok", msg_list: msgs, sync_buf: "BUF2" });
    const result = await getUpdates(BASE, "TOKEN", "BUF1", fetchFn);
    expect(result.msgs).toEqual(msgs);
    expect(result.syncBuf).toBe("BUF2");
  });

  it("returns empty msgs array when msg_list absent", async () => {
    const fetchFn = makeFetch({ errcode: 0, errmsg: "ok", sync_buf: "BUF2" });
    const result = await getUpdates(BASE, "TOKEN", "BUF1", fetchFn);
    expect(result.msgs).toEqual([]);
  });

  it("preserves old syncBuf if new one absent", async () => {
    const fetchFn = makeFetch({ errcode: 0, errmsg: "ok" });
    const result = await getUpdates(BASE, "TOKEN", "OLD", fetchFn);
    expect(result.syncBuf).toBe("OLD");
  });

  it("sends Authorization header and sync_buf body", async () => {
    const fetchFn = makeFetch({ errcode: 0, errmsg: "ok" });
    await getUpdates(BASE, "MYTOKEN", "MYSYNC", fetchFn);
    const [url, opts] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/ilink/bot/getupdates`);
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer MYTOKEN");
    expect(JSON.parse(opts.body as string)).toMatchObject({ sync_buf: "MYSYNC", timeout: 35 });
  });

  it("throws WechatApiError on non-zero errcode", async () => {
    const fetchFn = makeFetch({ errcode: -1, errmsg: "fail" });
    await expect(getUpdates(BASE, "T", "S", fetchFn)).rejects.toThrow(WechatApiError);
  });
});

describe("sendMessage", () => {
  it("sends a single message for short text", async () => {
    const fetchFn = makeFetch({ errcode: 0, errmsg: "ok" });
    await sendMessage(BASE, "TOKEN", "user1", "hello", undefined, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, opts] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${BASE}/ilink/bot/sendmessage`);
    const body = JSON.parse(opts.body as string);
    expect(body.to).toBe("user1");
    expect(body.content).toBe("hello");
    expect(body.context_token).toBeUndefined();
  });

  it("includes context_token when provided", async () => {
    const fetchFn = makeFetch({ errcode: 0, errmsg: "ok" });
    await sendMessage(BASE, "TOKEN", "user1", "hi", "CTXTOKEN", fetchFn);
    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.context_token).toBe("CTXTOKEN");
  });

  it("splits long text into multiple messages", async () => {
    const fetchFn = makeFetch({ errcode: 0, errmsg: "ok" });
    const longText = "a".repeat(CHUNK_SIZE * 2 + 100);
    await sendMessage(BASE, "TOKEN", "user1", longText, undefined, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("throws WechatApiError on non-zero errcode", async () => {
    const fetchFn = makeFetch({ errcode: -1, errmsg: "fail" });
    await expect(sendMessage(BASE, "T", "u", "hi", undefined, fetchFn)).rejects.toThrow(WechatApiError);
  });
});

describe("splitText", () => {
  it("returns single chunk for short text", () => {
    expect(splitText("hello")).toEqual(["hello"]);
  });

  it("returns single chunk for text exactly at limit", () => {
    const text = "a".repeat(CHUNK_SIZE);
    expect(splitText(text)).toEqual([text]);
  });

  it("splits text exceeding chunk size", () => {
    const text = "a".repeat(CHUNK_SIZE + 1);
    const chunks = splitText(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(CHUNK_SIZE);
    expect(chunks[1]).toHaveLength(1);
  });

  it("splits into N chunks for N*size text", () => {
    const n = 4;
    const text = "x".repeat(CHUNK_SIZE * n);
    const chunks = splitText(text);
    expect(chunks).toHaveLength(n);
    chunks.forEach((c) => expect(c).toHaveLength(CHUNK_SIZE));
  });
});
