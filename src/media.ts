import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// AES-128-ECB helpers
// ---------------------------------------------------------------------------

function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = createCipheriv("aes-128-ecb", key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = createDecipheriv("aes-128-ecb", key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** AES-128-ECB ciphertext size with PKCS7 padding to 16-byte boundary. */
function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/**
 * Parse CDNMedia.aes_key into a raw 16-byte AES key.
 *
 * Two encodings are seen in the wild:
 *   - base64(raw 16 bytes)           → images
 *   - base64(hex string of 16 bytes) → file / voice / video
 */
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, "base64");
  if (decoded.length === 16) return decoded;
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(decoded.toString("ascii"))) {
    return Buffer.from(decoded.toString("ascii"), "hex");
  }
  throw new Error(
    `aes_key must decode to 16 raw bytes or 32-char hex string, got ${decoded.length} bytes`,
  );
}

// ---------------------------------------------------------------------------
// Download (inbound)
// ---------------------------------------------------------------------------

/**
 * Download and decrypt an encrypted image from ilink CDN.
 * Returns the decrypted image as a Buffer.
 */
export async function downloadMedia(params: {
  cdnBaseUrl: string;
  encryptQueryParam: string;
  aesKeyBase64: string;
  fetchFn?: typeof fetch;
}): Promise<Buffer> {
  const { cdnBaseUrl, encryptQueryParam, aesKeyBase64, fetchFn = fetch } = params;
  const base = cdnBaseUrl.endsWith("/") ? cdnBaseUrl.slice(0, -1) : cdnBaseUrl;
  const url = `${base}/download?encrypted_query_param=${encodeURIComponent(encryptQueryParam)}`;

  const res = await fetchFn(url);
  if (!res.ok) {
    const body = await res.text().catch(() => "(unreadable)");
    throw new Error(`CDN download failed: ${res.status} ${res.statusText} body=${body}`);
  }
  const encrypted = Buffer.from(await res.arrayBuffer());
  const key = parseAesKey(aesKeyBase64);
  return decryptAesEcb(encrypted, key);
}

// ---------------------------------------------------------------------------
// Upload (outbound)
// ---------------------------------------------------------------------------

export interface UploadedMedia {
  /** For image_item.media.encrypt_query_param */
  encryptQueryParam: string;
  /** For image_item.media.aes_key (base64 of hex-encoded key) */
  aesKeyBase64: string;
  /** AES-128-ECB ciphertext size; use for image_item.mid_size / hd_size */
  fileSizeCiphertext: number;
  /** Plaintext file size in bytes; use for file_item.len */
  rawSize: number;
}

interface GetUploadUrlResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upload_param?: string;
  upload_url?: string;
  encrypt_query_param?: string;
}

/**
 * Upload a local file to ilink CDN and return upload info for sendMessage.
 *
 * Upload flow (mirrors official src/cdn/upload.ts):
 *   1. Read file, compute MD5 and sizes
 *   2. Generate random 16-byte AES key
 *   3. Call ilink/bot/getuploadurl to get a pre-signed upload URL
 *   4. AES-128-ECB encrypt the file
 *   5. POST encrypted bytes to CDN upload URL
 *   6. Return UploadedMedia for use in sendMessage image_item
 */
/** media_type values from UploadMediaType: 1=IMAGE, 2=VIDEO, 3=FILE, 4=VOICE */
export const MEDIA_TYPE_IMAGE = 1;
export const MEDIA_TYPE_FILE = 3;

export async function uploadMedia(params: {
  apiBase: string;
  cdnBase: string;
  token: string;
  /** Either a filesystem path or a pre-loaded Buffer */
  filePath: string | Buffer;
  toUserId: string;
  mediaType?: number;  // default: MEDIA_TYPE_IMAGE (1)
  fetchFn?: typeof fetch;
}): Promise<UploadedMedia> {
  const { apiBase, cdnBase, token, filePath, toUserId, mediaType = MEDIA_TYPE_IMAGE, fetchFn = fetch } = params;

  const plaintext = Buffer.isBuffer(filePath) ? filePath : await readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = randomBytes(16).toString("hex");
  const aeskey = randomBytes(16);

  // Step 1: get pre-signed upload URL
  const apiBaseNorm = apiBase.endsWith("/") ? apiBase : `${apiBase}/`;
  const reqBody = JSON.stringify({
    filekey,
    media_type: mediaType,
    to_user_id: toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
    base_info: { channel_version: "claude-code-1.0" },
  });

  const uin = Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64");

  const uploadUrlRes = await fetchFn(`${apiBaseNorm}ilink/bot/getuploadurl`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(reqBody, "utf-8")),
      AuthorizationType: "ilink_bot_token",
      Authorization: `Bearer ${token}`,
      "X-WECHAT-UIN": uin,
    },
    body: reqBody,
  });

  if (!uploadUrlRes.ok) {
    throw new Error(`getuploadurl HTTP ${uploadUrlRes.status}`);
  }
  const uploadUrlData = (await uploadUrlRes.json()) as GetUploadUrlResponse;
  const code = uploadUrlData.ret ?? uploadUrlData.errcode ?? 0;
  if (code !== 0) {
    throw new Error(`getuploadurl error ${code}: ${uploadUrlData.errmsg ?? "unknown"}`);
  }

  const uploadParam = uploadUrlData.upload_param;
  if (!uploadParam) {
    throw new Error("getuploadurl returned no upload_param");
  }

  // Step 2: encrypt and upload to CDN
  const cdnBaseNorm = cdnBase.endsWith("/") ? cdnBase.slice(0, -1) : cdnBase;
  const cdnUrl = `${cdnBaseNorm}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  const ciphertext = encryptAesEcb(plaintext, aeskey);

  const cdnRes = await fetchFn(cdnUrl, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: new Uint8Array(ciphertext),
  });

  if (!cdnRes.ok) {
    const errMsg = cdnRes.headers.get("x-error-message") ?? `status ${cdnRes.status}`;
    throw new Error(`CDN upload failed: ${errMsg}`);
  }

  const encryptQueryParam = cdnRes.headers.get("x-encrypted-param");
  if (!encryptQueryParam) {
    throw new Error("CDN upload response missing x-encrypted-param header");
  }

  // aes_key in image_item uses base64(hex-string) encoding (matches official impl)
  const aesKeyBase64 = Buffer.from(aeskey.toString("hex")).toString("base64");

  return {
    encryptQueryParam,
    aesKeyBase64,
    fileSizeCiphertext: filesize,
    rawSize: rawsize,
  };
}
