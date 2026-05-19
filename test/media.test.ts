import { createCipheriv } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MEDIA_TYPE_FILE,
  downloadMedia,
  uploadMedia,
} from "../src/media.js";

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function mediaFetchResponse(options: {
  ok?: boolean;
  status?: number;
  statusText?: string;
  body?: Buffer | string;
  json?: unknown;
  headers?: Record<string, string>;
}) {
  const body = options.body ?? "";
  const headers = options.headers ?? {};
  return {
    ok: options.ok ?? true,
    status: options.status ?? 200,
    statusText: options.statusText ?? "OK",
    text: async () => typeof body === "string" ? body : body.toString("utf8"),
    json: async () => options.json,
    arrayBuffer: async () => {
      const buffer = typeof body === "string" ? Buffer.from(body) : body;
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    },
    headers: {
      get: (name: string) => headers[name.toLowerCase()] ?? null,
    },
  };
}

describe("downloadMedia", () => {
  it("requires either fullUrl or encryptQueryParam", async () => {
    await expect(downloadMedia({ cdnBaseUrl: "https://cdn.example.com" })).rejects.toThrow(
      "downloadMedia requires fullUrl or encryptQueryParam",
    );
  });

  it("downloads a fullUrl payload without decrypting when no AES key is provided", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mediaFetchResponse({ body: "plain" })) as unknown as typeof fetch;
    const result = await downloadMedia({
      cdnBaseUrl: "https://cdn.example.com",
      fullUrl: "https://cdn.example.com/file",
      fetchFn,
    });

    expect(result.toString("utf8")).toBe("plain");
    expect(fetchFn).toHaveBeenCalledWith("https://cdn.example.com/file");
  });

  it("builds a CDN download URL and decrypts raw AES keys", async () => {
    const key = Buffer.from("0123456789abcdef");
    const ciphertext = encryptAesEcb(Buffer.from("secret"), key);
    const fetchFn = vi.fn().mockResolvedValue(mediaFetchResponse({ body: ciphertext })) as unknown as typeof fetch;

    const result = await downloadMedia({
      cdnBaseUrl: "https://cdn.example.com/",
      encryptQueryParam: "a+b c",
      aesKeyBase64: key.toString("base64"),
      fetchFn,
    });

    expect(result.toString("utf8")).toBe("secret");
    expect(fetchFn).toHaveBeenCalledWith("https://cdn.example.com/download?encrypted_query_param=a%2Bb%20c");
  });

  it("decrypts hex-string AES keys", async () => {
    const key = Buffer.from("abcdef0123456789");
    const ciphertext = encryptAesEcb(Buffer.from("payload"), key);
    const fetchFn = vi.fn().mockResolvedValue(mediaFetchResponse({ body: ciphertext })) as unknown as typeof fetch;

    const result = await downloadMedia({
      cdnBaseUrl: "https://cdn.example.com",
      fullUrl: "https://cdn.example.com/file",
      aesKeyBase64: Buffer.from(key.toString("hex")).toString("base64"),
      fetchFn,
    });

    expect(result.toString("utf8")).toBe("payload");
  });

  it("includes CDN error response bodies", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mediaFetchResponse({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      body: "denied",
    })) as unknown as typeof fetch;

    await expect(downloadMedia({
      cdnBaseUrl: "https://cdn.example.com",
      fullUrl: "https://cdn.example.com/file",
      fetchFn,
    })).rejects.toThrow("CDN download failed: 403 Forbidden body=denied");
  });
});

describe("uploadMedia", () => {
  it("uploads encrypted bytes through an upload_param destination", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(mediaFetchResponse({
        json: { ret: 0, upload_param: "UPLOAD PARAM" },
      }))
      .mockResolvedValueOnce(mediaFetchResponse({
        headers: { "x-encrypted-param": "ENC" },
      })) as unknown as typeof fetch;

    const result = await uploadMedia({
      apiBase: "https://api.example.com",
      cdnBase: "https://cdn.example.com/",
      token: "TOKEN",
      filePath: Buffer.from("hello"),
      toUserId: "user1",
      mediaType: MEDIA_TYPE_FILE,
      fetchFn,
    });

    expect(result.encryptQueryParam).toBe("ENC");
    expect(result.rawSize).toBe(5);
    expect(result.fileSizeCiphertext).toBe(16);

    const [apiUrl, apiOpts] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit];
    expect(apiUrl).toBe("https://api.example.com/ilink/bot/getuploadurl");
    const apiBody = JSON.parse(apiOpts.body as string);
    expect(apiBody.media_type).toBe(MEDIA_TYPE_FILE);
    expect(apiBody.to_user_id).toBe("user1");

    const [cdnUrl, cdnOpts] = (fetchFn as ReturnType<typeof vi.fn>).mock.calls[1] as [string, RequestInit];
    expect(cdnUrl).toContain("https://cdn.example.com/upload?encrypted_query_param=UPLOAD%20PARAM");
    expect(cdnUrl).toContain("filekey=");
    expect(cdnOpts.body).toBeInstanceOf(Uint8Array);
  });

  it("prefers upload_full_url when present", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(mediaFetchResponse({
        json: { ret: 0, upload_param: "UPLOAD_PARAM", upload_full_url: "https://upload.example.com/direct" },
      }))
      .mockResolvedValueOnce(mediaFetchResponse({
        headers: { "x-encrypted-param": "ENC" },
      })) as unknown as typeof fetch;

    await uploadMedia({
      apiBase: "https://api.example.com/",
      cdnBase: "https://cdn.example.com",
      token: "TOKEN",
      filePath: Buffer.from("hello"),
      toUserId: "user1",
      fetchFn,
    });

    expect((fetchFn as ReturnType<typeof vi.fn>).mock.calls[1][0]).toBe("https://upload.example.com/direct");
  });

  it("throws when getuploadurl fails", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mediaFetchResponse({
      ok: false,
      status: 500,
    })) as unknown as typeof fetch;

    await expect(uploadMedia({
      apiBase: "https://api.example.com",
      cdnBase: "https://cdn.example.com",
      token: "TOKEN",
      filePath: Buffer.from("hello"),
      toUserId: "user1",
      fetchFn,
    })).rejects.toThrow("getuploadurl HTTP 500");
  });

  it("throws when getuploadurl returns an API error", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mediaFetchResponse({
      json: { errcode: -1, errmsg: "bad token" },
    })) as unknown as typeof fetch;

    await expect(uploadMedia({
      apiBase: "https://api.example.com",
      cdnBase: "https://cdn.example.com",
      token: "TOKEN",
      filePath: Buffer.from("hello"),
      toUserId: "user1",
      fetchFn,
    })).rejects.toThrow("getuploadurl error -1: bad token");
  });

  it("throws when no upload destination is returned", async () => {
    const fetchFn = vi.fn().mockResolvedValue(mediaFetchResponse({
      json: { ret: 0 },
    })) as unknown as typeof fetch;

    await expect(uploadMedia({
      apiBase: "https://api.example.com",
      cdnBase: "https://cdn.example.com",
      token: "TOKEN",
      filePath: Buffer.from("hello"),
      toUserId: "user1",
      fetchFn,
    })).rejects.toThrow("getuploadurl returned no upload destination");
  });

  it("throws when CDN upload fails", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(mediaFetchResponse({
        json: { ret: 0, upload_full_url: "https://upload.example.com/direct" },
      }))
      .mockResolvedValueOnce(mediaFetchResponse({
        ok: false,
        status: 418,
        headers: { "x-error-message": "nope" },
      })) as unknown as typeof fetch;

    await expect(uploadMedia({
      apiBase: "https://api.example.com",
      cdnBase: "https://cdn.example.com",
      token: "TOKEN",
      filePath: Buffer.from("hello"),
      toUserId: "user1",
      fetchFn,
    })).rejects.toThrow("CDN upload failed: nope");
  });

  it("throws when CDN upload does not return an encrypted parameter", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(mediaFetchResponse({
        json: { ret: 0, upload_full_url: "https://upload.example.com/direct" },
      }))
      .mockResolvedValueOnce(mediaFetchResponse({})) as unknown as typeof fetch;

    await expect(uploadMedia({
      apiBase: "https://api.example.com",
      cdnBase: "https://cdn.example.com",
      token: "TOKEN",
      filePath: Buffer.from("hello"),
      toUserId: "user1",
      fetchFn,
    })).rejects.toThrow("CDN upload response missing x-encrypted-param header");
  });
});
