import { randomBytes } from "node:crypto";

export const WECHAT_BASE = "https://ilinkai.weixin.qq.com";
export const CHUNK_SIZE = 4000;

/** CDN media reference embedded in an item. */
export interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
}

export interface WechatMsgItem {
  type: number;
  text_item?: { text: string };
  image_item?: {
    media?: CDNMedia;
    /** Raw AES-128 key as hex string (preferred over media.aes_key for inbound decryption). */
    aeskey?: string;
    mid_size?: number;
    hd_size?: number;
  };
  voice_item?: {
    media?: CDNMedia;
    /** Voice encoding: 1=pcm 2=adpcm 3=feature 4=speex 5=amr 6=silk 7=mp3 8=ogg-speex */
    encode_type?: number;
    /** Voice duration in milliseconds */
    playtime?: number;
    /** Voice-to-text transcription (if available) */
    text?: string;
  };
  file_item?: {
    media?: CDNMedia;
    file_name?: string;
    md5?: string;
    len?: string;
  };
  video_item?: {
    media?: CDNMedia;
    video_size?: number;
    play_length?: number;
  };
}

export interface WechatMsg {
  message_id: number | string;
  from_user_id: string;
  to_user_id?: string;
  message_type?: number;
  item_list?: WechatMsgItem[];
  context_token?: string;
}

// Real API response shapes (verified against reference impl codeyq/wechat-claude-code-channel)
interface QrCodeResponse {
  qrcode: string;             // used for pollQrStatus
  qrcode_img_content: string; // QR image URL → render to PNG
}

interface QrStatusResponse {
  status: "wait" | "scaned" | "confirmed" | "expired";
  bot_token?: string;
  ilink_bot_id?: string;
  ilink_user_id?: string;
  baseurl?: string;
}

interface GetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WechatMsg[];
  get_updates_buf?: string;
}

interface SendMessageResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
}

export class WechatApiError extends Error {
  constructor(
    public readonly errcode: number,
    message: string,
  ) {
    super(`WechatApiError[${errcode}]: ${message}`);
    this.name = "WechatApiError";
  }
}

/** X-WECHAT-UIN: base64 of a random uint32 string (matches reference impl) */
function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

/** Build required headers for ilink bot API POST requests */
function buildHeaders(token: string | undefined, body: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Content-Length": String(Buffer.byteLength(body, "utf-8")),
    AuthorizationType: "ilink_bot_token",
    "X-WECHAT-UIN": randomWechatUin(),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

export async function getQrCode(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ qrcode: string; qrcodeImgUrl: string }> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=3`;
  const res = await fetchFn(url, { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status} from getQrCode`);
  const data = (await res.json()) as QrCodeResponse;
  return { qrcode: data.qrcode, qrcodeImgUrl: data.qrcode_img_content };
}

export async function pollQrStatus(
  baseUrl: string,
  qrcode: string,
  fetchFn: typeof fetch = fetch,
): Promise<{
  status: QrStatusResponse["status"];
  token?: string;
  botId?: string;
  userId?: string;
  resolvedBaseUrl?: string;
}> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  let res: Response;
  try {
    res = await fetchFn(url, {
      method: "GET",
      headers: { "iLink-App-ClientVersion": "1" },
      signal: AbortSignal.timeout(35_000),
    });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { status: "wait" };
    }
    throw err;
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from pollQrStatus`);
  const data = (await res.json()) as QrStatusResponse;
  return {
    status: data.status,
    token: data.bot_token,
    botId: data.ilink_bot_id,
    userId: data.ilink_user_id,
    resolvedBaseUrl: data.baseurl,
  };
}

export async function getUpdates(
  baseUrl: string,
  token: string,
  syncBuf: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ msgs: WechatMsg[]; syncBuf: string }> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const body = JSON.stringify({
    get_updates_buf: syncBuf,
    base_info: { channel_version: "claude-code-1.0" },
  });
  let rawText: string;
  try {
    const res = await fetchFn(`${base}ilink/bot/getupdates`, {
      method: "POST",
      headers: buildHeaders(token, body),
      body,
      signal: AbortSignal.timeout(40_000),
    });
    rawText = await res.text();
    if (!res.ok) throw new Error(`getUpdates HTTP ${res.status}: ${rawText}`);
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "AbortError") {
      return { msgs: [], syncBuf };
    }
    throw err;
  }
  const data = JSON.parse(rawText) as GetUpdatesResponse;
  const code = data.ret ?? data.errcode ?? 0;
  if (code !== 0) throw new WechatApiError(code, data.errmsg ?? "unknown");
  return {
    msgs: data.msgs ?? [],
    syncBuf: data.get_updates_buf ?? syncBuf,
  };
}

function generateClientId(): string {
  return `cc-wx-${Date.now()}-${randomBytes(4).toString("hex")}`;
}

export interface ImageItem {
  encryptQueryParam: string;
  aesKeyBase64: string;
  midSize: number;
}

export interface FileItem {
  encryptQueryParam: string;
  aesKeyBase64: string;
  fileName: string;
  fileSize: number;  // plaintext size in bytes
}

export interface VoiceItem {
  encryptQueryParam: string;
  aesKeyBase64: string;
  /** encode_type=6 (SILK v3) */
  encodeType?: number;
  sampleRate?: number;
  bitsPerSample?: number;
  /** Duration in milliseconds */
  playtimeMs?: number;
}

export async function sendMessage(
  baseUrl: string,
  token: string,
  toUser: string,
  text: string,
  contextToken?: string,
  fetchFn: typeof fetch = fetch,
  mediaItem?: ImageItem | { kind: "file"; item: FileItem } | { kind: "voice"; item: VoiceItem },
): Promise<void> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;

  if (mediaItem) {
    let itemList: unknown[];
    if ("kind" in mediaItem && mediaItem.kind === "file") {
      // Send file message (type:4 FILE)
      const f = mediaItem.item;
      itemList = [{
        type: 4,
        file_item: {
          media: {
            encrypt_query_param: f.encryptQueryParam,
            aes_key: f.aesKeyBase64,
            encrypt_type: 1,
          },
          file_name: f.fileName,
          md5: "",
          len: String(f.fileSize),
        },
      }];
    } else if ("kind" in mediaItem && mediaItem.kind === "voice") {
      // Send voice message (type:3 VOICE, SILK v3)
      const v = mediaItem.item;
      itemList = [{
        type: 3,
        voice_item: {
          media: {
            encrypt_query_param: v.encryptQueryParam,
            aes_key: v.aesKeyBase64,
            encrypt_type: 1,
          },
          encode_type: v.encodeType ?? 6,       // 6 = SILK v3
          sample_rate: v.sampleRate ?? 16000,
          bits_per_sample: v.bitsPerSample ?? 16,
          playtime: v.playtimeMs ?? 0,
        },
      }];
    } else {
      // Send image message (type:2 IMAGE)
      const img = mediaItem as ImageItem;
      itemList = [{
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: img.encryptQueryParam,
            aes_key: img.aesKeyBase64,
            encrypt_type: 1,
          },
          mid_size: img.midSize,
        },
      }];
    }

    const msgBody: Record<string, unknown> = {
      from_user_id: "",
      to_user_id: toUser,
      client_id: generateClientId(),
      message_type: 2,
      message_state: 2,
      item_list: itemList,
    };
    if (contextToken) msgBody.context_token = contextToken;
    const body = JSON.stringify({
      msg: msgBody,
      base_info: { channel_version: "claude-code-1.0" },
    });
    const res = await fetchFn(`${base}ilink/bot/sendmessage`, {
      method: "POST",
      headers: buildHeaders(token, body),
      body,
    });
    if (!res.ok) throw new Error(`sendMessage HTTP ${res.status}`);
    const data = (await res.json()) as SendMessageResponse;
    const code = data.ret ?? data.errcode ?? 0;
    if (code !== 0) throw new WechatApiError(code, data.errmsg ?? "unknown");

    // Send accompanying text if provided
    if (text) {
      await sendMessage(baseUrl, token, toUser, text, contextToken, fetchFn);
    }
    return;
  }

  for (const chunk of splitText(text)) {
    const msgBody: Record<string, unknown> = {
      from_user_id: "",
      to_user_id: toUser,
      client_id: generateClientId(),
      message_type: 2,   // BOT
      message_state: 2,  // FINISH
      item_list: [{ type: 1, text_item: { text: chunk } }],
    };
    if (contextToken) msgBody.context_token = contextToken;
    const body = JSON.stringify({
      msg: msgBody,
      base_info: { channel_version: "claude-code-1.0" },
    });
    const res = await fetchFn(`${base}ilink/bot/sendmessage`, {
      method: "POST",
      headers: buildHeaders(token, body),
      body,
    });
    if (!res.ok) throw new Error(`sendMessage HTTP ${res.status}`);
    const data = (await res.json()) as SendMessageResponse;
    const code = data.ret ?? data.errcode ?? 0;
    if (code !== 0) throw new WechatApiError(code, data.errmsg ?? "unknown");
  }
}

interface GetUploadUrlResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  upload_param?: string;
  upload_url?: string;
  encrypt_query_param?: string;
}

export async function getUploadUrl(params: {
  baseUrl: string;
  token: string;
  filekey: string;
  mediaType: number;
  toUserId: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  aeskey: string;  // hex string
  fetchFn?: typeof fetch;
}): Promise<{ upload_url?: string; upload_param?: string; encrypt_query_param?: string }> {
  const { baseUrl, token, fetchFn = fetch, ...rest } = params;
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const body = JSON.stringify({
    filekey: rest.filekey,
    media_type: rest.mediaType,
    to_user_id: rest.toUserId,
    rawsize: rest.rawsize,
    rawfilemd5: rest.rawfilemd5,
    filesize: rest.filesize,
    no_need_thumb: true,
    aeskey: rest.aeskey,
    base_info: { channel_version: "claude-code-1.0" },
  });
  const res = await fetchFn(`${base}ilink/bot/getuploadurl`, {
    method: "POST",
    headers: buildHeaders(token, body),
    body,
  });
  if (!res.ok) throw new Error(`getUploadUrl HTTP ${res.status}`);
  const data = (await res.json()) as GetUploadUrlResponse;
  const code = data.ret ?? data.errcode ?? 0;
  if (code !== 0) throw new WechatApiError(code, data.errmsg ?? "unknown");
  return {
    upload_url: data.upload_url,
    upload_param: data.upload_param,
    encrypt_query_param: data.encrypt_query_param,
  };
}

export function splitText(text: string, chunkSize = CHUNK_SIZE): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let offset = 0;
  while (offset < text.length) {
    chunks.push(text.slice(offset, offset + chunkSize));
    offset += chunkSize;
  }
  return chunks;
}

export interface GetConfigResponse {
  ret?: number;
  errmsg?: string;
  typing_ticket?: string;
}

export interface SendTypingResponse {
  ret?: number;
  errmsg?: string;
}

/**
 * Fetch per-user bot config from ilink, primarily to get typing_ticket.
 * typing_ticket is required for sendTyping.
 */
export async function getConfig(
  baseUrl: string,
  token: string,
  ilinkUserId: string,
  contextToken?: string,
  fetchFn: typeof fetch = fetch,
): Promise<GetConfigResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const body = JSON.stringify({
    ilink_user_id: ilinkUserId,
    context_token: contextToken,
    base_info: {},
  });
  const res = await fetchFn(`${base}ilink/bot/getconfig`, {
    method: "POST",
    headers: buildHeaders(token, body),
    body,
  });
  if (!res.ok) throw new Error(`getConfig HTTP ${res.status}`);
  return (await res.json()) as GetConfigResponse;
}

/**
 * Send a typing indicator to a WeChat user.
 * status: 1 = typing (start/keepalive), 2 = cancel
 * Requires typing_ticket from getConfig().
 */
export async function sendTyping(
  baseUrl: string,
  token: string,
  ilinkUserId: string,
  typingTicket: string,
  status: 1 | 2,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const body = JSON.stringify({
    ilink_user_id: ilinkUserId,
    typing_ticket: typingTicket,
    status,
    base_info: {},
  });
  try {
    await fetchFn(`${base}ilink/bot/sendtyping`, {
      method: "POST",
      headers: buildHeaders(token, body),
      body,
    });
  } catch {
    // swallow errors — typing failures must not interrupt the main flow
  }
}
