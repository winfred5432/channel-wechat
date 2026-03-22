import { randomBytes } from "node:crypto";

export const WECHAT_BASE = "https://ilinkai.weixin.qq.com";
export const CHUNK_SIZE = 4000;

interface WechatMsgItem {
  type: number;
  text_item?: { text: string };
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

export async function sendMessage(
  baseUrl: string,
  token: string,
  toUser: string,
  text: string,
  contextToken?: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
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
