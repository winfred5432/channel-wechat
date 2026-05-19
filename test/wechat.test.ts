import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import {
  getQrCode,
  pollQrStatus,
  getUpdates,
  getUploadUrl,
  sendMessage,
  getConfig,
  sendTyping,
  splitText,
  buildBaseInfo,
  sanitizeBotAgent,
  WechatApiError,
  CHUNK_SIZE,
} from "../src/wechat.js";
import * as wechat from "../src/wechat.js";
import { Auth } from "../src/auth.js";

const BASE = "https://ilinkai.weixin.qq.com";

vi.mock("qrcode", () => ({
  default: {
    toFile: vi.fn().mockResolvedValue(undefined),
  },
}));

function makeFetch(response: unknown, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(response),
    json: async () => response,
  }) as unknown as typeof fetch;
}

describe("getQrCode", () => {
  it("returns qrcode and qrcodeImgUrl on success", async () => {
    const fetchFn = makeFetch({ qrcode: "QR123", qrcode_img_content: "https://img.example.com/qr.png" });
    const result = await getQrCode(BASE, fetchFn);
    expect(result).toEqual({ qrcode: "QR123", qrcodeImgUrl: "https://img.example.com/qr.png" });
    const calledUrl = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("get_bot_qrcode?bot_type=3");
    const opts = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>)["iLink-App-Id"]).toBe("bot");
    expect((opts.headers as Record<string, string>)["iLink-App-ClientVersion"]).toMatch(/^\d+$/);
  });

  it("throws on HTTP error", async () => {
    const fetchFn = makeFetch({}, 500);
    await expect(getQrCode(BASE, fetchFn)).rejects.toThrow("HTTP 500");
  });

  it("normalizes trailing slash in baseUrl", async () => {
    const fetchFn = makeFetch({ qrcode: "Q", qrcode_img_content: "I" });
    await getQrCode(BASE + "/", fetchFn);
    const url = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    // URL should not have double slash in path (e.g. .com//ilink)
    expect(url).not.toMatch(/\.com\/\//);
  });
});

describe("protocol base_info", () => {
  it("defaults bot_agent to valid UA-style Duoduo product", () => {
    expect(buildBaseInfo().bot_agent).toMatch(/^Duoduo\/(?:\d+\.\d+\.\d+|0\.0\.0)$/);
  });

  it("keeps valid custom UA-style bot agent", () => {
    expect(sanitizeBotAgent("Duoduo/0.1.2 (prod) SDK/1.0")).toBe("Duoduo/0.1.2 (prod) SDK/1.0");
  });

  it("falls back invalid custom bot agent to valid UA-style Duoduo product", () => {
    expect(sanitizeBotAgent("多多")).toMatch(/^Duoduo\/(?:\d+\.\d+\.\d+|0\.0\.0)$/);
  });

  it("keeps multi-word product comments together", () => {
    expect(sanitizeBotAgent("Duoduo/0.1.2 (prod canary) SDK/1.0")).toBe("Duoduo/0.1.2 (prod canary) SDK/1.0");
  });

  it("drops invalid comments but keeps the preceding product token", () => {
    expect(sanitizeBotAgent("Duoduo/0.1.2 (生产)")).toBe("Duoduo/0.1.2");
  });

  it("keeps adjacent valid product tokens", () => {
    expect(sanitizeBotAgent("Duoduo/0.1.2 SDK/1.0")).toBe("Duoduo/0.1.2 SDK/1.0");
  });

  it("truncates overlong bot agent strings at a valid token boundary", () => {
    const raw = Array.from({ length: 30 }, (_, i) => `SDK${i}/1.0`).join(" ");
    const sanitized = sanitizeBotAgent(raw);
    expect(sanitized).toMatch(/^SDK0\/1\.0/);
    expect(sanitized.endsWith(" ")).toBe(false);
    expect(Buffer.byteLength(sanitized, "utf-8")).toBeLessThanOrEqual(256);
  });
});

describe("pollQrStatus", () => {
  it("returns wait status", async () => {
    const fetchFn = makeFetch({ status: "wait" });
    const result = await pollQrStatus(BASE, "QR123", fetchFn);
    expect(result.status).toBe("wait");
    expect(result.token).toBeUndefined();
  });

  it("returns confirmed status with token and botId", async () => {
    const fetchFn = makeFetch({
      status: "confirmed",
      bot_token: "REALTOKEN",
      ilink_bot_id: "BOT1",
      ilink_user_id: "USER1",
      baseurl: "https://other.example.com",
    });
    const result = await pollQrStatus(BASE, "QR123", fetchFn);
    expect(result.status).toBe("confirmed");
    expect(result.token).toBe("REALTOKEN");
    expect(result.botId).toBe("BOT1");
    expect(result.userId).toBe("USER1");
    expect(result.resolvedBaseUrl).toBe("https://other.example.com");
  });

  it("returns redirect status with redirect_host", async () => {
    const fetchFn = makeFetch({
      status: "scaned_but_redirect",
      redirect_host: "redirect.weixin.qq.com",
    });
    const result = await pollQrStatus(BASE, "QR123", fetchFn);
    expect(result.status).toBe("scaned_but_redirect");
    expect(result.redirectHost).toBe("redirect.weixin.qq.com");
  });

  it("returns wait on AbortError timeout", async () => {
    const abortErr = new DOMException("timeout", "AbortError");
    const fetchFn = vi.fn().mockRejectedValue(abortErr) as unknown as typeof fetch;
    const result = await pollQrStatus(BASE, "QR123", fetchFn);
    expect(result.status).toBe("wait");
  });

  it("encodes qrcode in URL", async () => {
    const fetchFn = makeFetch({ status: "wait" });
    await pollQrStatus(BASE, "QR 123+/=", fetchFn);
    const calledUrl = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    expect(calledUrl).toContain("qrcode=QR%20123%2B%2F%3D");
  });

  it("throws on HTTP error", async () => {
    const fetchFn = makeFetch({}, 500);
    await expect(pollQrStatus(BASE, "QR", fetchFn)).rejects.toThrow("HTTP 500");
  });
});

describe("getUploadUrl", () => {
  it("returns upload_full_url and falls back upload_url to it", async () => {
    const fetchFn = makeFetch({
      ret: 0,
      upload_full_url: "https://cdn.example.com/upload?x=1",
      upload_param: "UPLOAD_PARAM",
      encrypt_query_param: "ENC",
    });
    const result = await getUploadUrl({
      baseUrl: BASE,
      token: "TOKEN",
      filekey: "FILEKEY",
      mediaType: 3,
      toUserId: "user1",
      rawsize: 12,
      rawfilemd5: "md5",
      filesize: 16,
      aeskey: "aes",
      fetchFn,
    });
    expect(result.upload_full_url).toBe("https://cdn.example.com/upload?x=1");
    expect(result.upload_url).toBe("https://cdn.example.com/upload?x=1");
    expect(result.upload_param).toBe("UPLOAD_PARAM");
    expect(result.encrypt_query_param).toBe("ENC");
  });
});

describe("getUpdates", () => {
  it("returns messages and new syncBuf", async () => {
    const msgs = [{ msgid: "1", from: "user1", content: "hello", msg_type: 1 }];
    const fetchFn = makeFetch({ ret: 0, msgs, get_updates_buf: "BUF2" });
    const result = await getUpdates(BASE, "TOKEN", "BUF1", fetchFn);
    expect(result.msgs).toEqual(msgs);
    expect(result.syncBuf).toBe("BUF2");
  });

  it("returns empty msgs when msgs absent", async () => {
    const fetchFn = makeFetch({ ret: 0, get_updates_buf: "BUF2" });
    const result = await getUpdates(BASE, "TOKEN", "BUF1", fetchFn);
    expect(result.msgs).toEqual([]);
  });

  it("preserves old syncBuf when get_updates_buf absent", async () => {
    const fetchFn = makeFetch({ ret: 0 });
    const result = await getUpdates(BASE, "TOKEN", "OLD", fetchFn);
    expect(result.syncBuf).toBe("OLD");
  });

  it("sends get_updates_buf in body and Authorization header", async () => {
    const fetchFn = makeFetch({ ret: 0 });
    await getUpdates(BASE, "MYTOKEN", "MYSYNC", fetchFn);
    const [url, opts] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("getupdates");
    expect((opts.headers as Record<string, string>)["Authorization"]).toBe("Bearer MYTOKEN");
    const body = JSON.parse(opts.body as string);
    expect(body.get_updates_buf).toBe("MYSYNC");
    expect(body.base_info.bot_agent).toMatch(/^Duoduo\/(?:\d+\.\d+\.\d+|0\.0\.0)$/);
    expect(body.base_info.channel_version).toMatch(/^(?:\d+\.\d+\.\d+|unknown)$/);
    expect((opts.headers as Record<string, string>)["iLink-App-Id"]).toBe("bot");
  });

  it("throws WechatApiError on non-zero ret code", async () => {
    const fetchFn = makeFetch({ ret: -1, errmsg: "fail" });
    await expect(getUpdates(BASE, "T", "S", fetchFn)).rejects.toThrow(WechatApiError);
  });

  it("throws WechatApiError on non-zero errcode when ret is absent", async () => {
    const fetchFn = makeFetch({ errcode: -2, errmsg: "expired" });
    await expect(getUpdates(BASE, "T", "S", fetchFn)).rejects.toThrow("WechatApiError[-2]: expired");
  });

  it("throws with response body on HTTP error", async () => {
    const fetchFn = makeFetch({ errmsg: "bad gateway" }, 502);
    await expect(getUpdates(BASE, "T", "S", fetchFn)).rejects.toThrow('getUpdates HTTP 502: {"errmsg":"bad gateway"}');
  });

  it("returns empty on AbortError", async () => {
    const abortErr = new DOMException("timeout", "AbortError");
    const fetchFn = vi.fn().mockRejectedValue(abortErr) as unknown as typeof fetch;
    const result = await getUpdates(BASE, "T", "OLD", fetchFn);
    expect(result.msgs).toEqual([]);
    expect(result.syncBuf).toBe("OLD");
  });

  it("rethrows non-timeout transport failures", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    await expect(getUpdates(BASE, "T", "OLD", fetchFn)).rejects.toThrow("network down");
  });
});

describe("sendMessage", () => {
  it("sends a single message for short text with correct msg format", async () => {
    const fetchFn = makeFetch({ ret: 0 });
    await sendMessage(BASE, "TOKEN", "user1", "hello", undefined, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, opts] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("sendmessage");
    const body = JSON.parse(opts.body as string);
    expect(body.msg.to_user_id).toBe("user1");
    expect(body.msg.item_list[0].text_item.text).toBe("hello");
    expect(body.base_info.bot_agent).toMatch(/^Duoduo\/(?:\d+\.\d+\.\d+|0\.0\.0)$/);
    expect(body.msg.context_token).toBeUndefined();
  });

  it("includes context_token when provided", async () => {
    const fetchFn = makeFetch({ ret: 0 });
    await sendMessage(BASE, "TOKEN", "user1", "hi", "CTXTOKEN", fetchFn);
    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.msg.context_token).toBe("CTXTOKEN");
  });

  it("splits long text into multiple messages", async () => {
    const fetchFn = makeFetch({ ret: 0 });
    const longText = "a".repeat(CHUNK_SIZE * 2 + 100);
    await sendMessage(BASE, "TOKEN", "user1", longText, undefined, fetchFn);
    expect(fetchFn).toHaveBeenCalledTimes(3);
  });

  it("throws WechatApiError on non-zero ret code", async () => {
    const fetchFn = makeFetch({ ret: -1, errmsg: "fail" });
    await expect(sendMessage(BASE, "T", "u", "hi", undefined, fetchFn)).rejects.toThrow(WechatApiError);
  });

  it("throws on HTTP error", async () => {
    const fetchFn = makeFetch({}, 500);
    await expect(sendMessage(BASE, "T", "u", "hi", undefined, fetchFn)).rejects.toThrow("HTTP 500");
  });

  it("uses AuthorizationType header", async () => {
    const fetchFn = makeFetch({ ret: 0 });
    await sendMessage(BASE, "TOKEN", "user1", "hi", undefined, fetchFn);
    const opts = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((opts.headers as Record<string, string>)["AuthorizationType"]).toBe("ilink_bot_token");
  });

  it("sends native voice messages with default SILK metadata", async () => {
    const fetchFn = makeFetch({ ret: 0 });
    await sendMessage(
      BASE,
      "TOKEN",
      "user1",
      "",
      "CTX",
      fetchFn,
      {
        kind: "voice",
        item: {
          encryptQueryParam: "ENC",
          aesKeyBase64: "AES",
        },
      },
    );
    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.msg.item_list[0].type).toBe(3);
    expect(body.msg.item_list[0].voice_item.encode_type).toBe(6);
    expect(body.msg.item_list[0].voice_item.sample_rate).toBe(16000);
    expect(body.msg.item_list[0].voice_item.bits_per_sample).toBe(16);
    expect(body.msg.item_list[0].voice_item.playtime).toBe(0);
    expect(body.msg.context_token).toBe("CTX");
  });

  it("sends native voice messages with explicit metadata", async () => {
    const fetchFn = makeFetch({ ret: 0 });
    await sendMessage(
      BASE,
      "TOKEN",
      "user1",
      "",
      undefined,
      fetchFn,
      {
        kind: "voice",
        item: {
          encryptQueryParam: "ENC",
          aesKeyBase64: "AES",
          encodeType: 7,
          sampleRate: 24000,
          bitsPerSample: 24,
          playtimeMs: 1234,
        },
      },
    );
    const body = JSON.parse((fetchFn as ReturnType<typeof vi.fn>).mock.calls[0][1].body as string);
    expect(body.msg.item_list[0].voice_item.encode_type).toBe(7);
    expect(body.msg.item_list[0].voice_item.sample_rate).toBe(24000);
    expect(body.msg.item_list[0].voice_item.bits_per_sample).toBe(24);
    expect(body.msg.item_list[0].voice_item.playtime).toBe(1234);
  });
});

describe("getConfig", () => {
  it("posts ilink_user_id and context_token", async () => {
    const fetchFn = makeFetch({ ret: 0, typing_ticket: "TT" });
    const result = await getConfig(BASE, "TOKEN", "user1", "CTX", fetchFn);
    expect(result.typing_ticket).toBe("TT");
    const [url, opts] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("getconfig");
    const body = JSON.parse(opts.body as string);
    expect(body.ilink_user_id).toBe("user1");
    expect(body.context_token).toBe("CTX");
  });

  it("throws on HTTP error", async () => {
    const fetchFn = makeFetch({}, 500);
    await expect(getConfig(BASE, "TOKEN", "user1", "CTX", fetchFn)).rejects.toThrow("getConfig HTTP 500");
  });
});

describe("sendTyping", () => {
  it("posts typing status to the typing endpoint", async () => {
    const fetchFn = makeFetch({ ret: 0 });
    await sendTyping(BASE, "TOKEN", "user1", "TT", 1, fetchFn);
    const [url, opts] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(url).toContain("sendtyping");
    const body = JSON.parse(opts.body as string);
    expect(body.status).toBe(1);
    expect(body.typing_ticket).toBe("TT");
  });

  it("swallows transport failures", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    await expect(sendTyping(BASE, "TOKEN", "user1", "TT", 2, fetchFn)).resolves.toBeUndefined();
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

describe("Auth QR redirect", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = join(tmpdir(), `wechat-auth-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("switches polling host after scaned_but_redirect", async () => {
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const getQrCodeSpy = vi.spyOn(wechat, "getQrCode").mockResolvedValue({
      qrcode: "QR123",
      qrcodeImgUrl: "https://img.example.com/qr.png",
    });
    const seenBases: string[] = [];
    vi.spyOn(wechat, "pollQrStatus").mockImplementation(async (baseUrl) => {
      seenBases.push(baseUrl);
      if (seenBases.length === 1) {
        return { status: "scaned_but_redirect", redirectHost: "redirect.weixin.qq.com" };
      }
      return {
        status: "confirmed",
        token: "TOKEN",
        botId: "BOT1",
        resolvedBaseUrl: "https://redirect.weixin.qq.com",
      };
    });

    const auth = new Auth(stateDir, BASE, vi.fn() as unknown as typeof fetch, 0);
    await expect(auth.startQrLogin()).resolves.toBe("TOKEN");
    expect(seenBases).toEqual([BASE, "https://redirect.weixin.qq.com"]);
    expect(getQrCodeSpy).toHaveBeenCalledWith(BASE, expect.any(Function));
    stdoutSpy.mockRestore();
  });
});
