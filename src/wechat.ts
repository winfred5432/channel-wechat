export const WECHAT_BASE = "https://ilinkai.weixin.qq.com";
export const CHUNK_SIZE = 4000;

export interface WechatMsg {
  msgid: string;
  from: string;
  to?: string;
  content: string;
  msg_type?: number;
  create_time?: number;
  context_token?: string;
}

interface QrCodeResponse {
  errcode: number;
  errmsg: string;
  qrcode: string;
  token: string;
}

interface QrStatusResponse {
  errcode: number;
  errmsg: string;
  status: "waiting" | "scanned" | "confirmed" | "expired";
  token?: string;
}

interface GetUpdatesResponse {
  errcode: number;
  errmsg: string;
  msg_list?: WechatMsg[];
  sync_buf?: string;
}

interface SendMessageResponse {
  errcode: number;
  errmsg: string;
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

export async function getQrCode(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ qrcode: string; token: string }> {
  const url = `${baseUrl}/ilink/bot/get_bot_qrcode?bot_type=3`;
  const res = await fetchFn(url, { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status} from getQrCode`);
  const data = (await res.json()) as QrCodeResponse;
  if (data.errcode !== 0) throw new WechatApiError(data.errcode, data.errmsg);
  return { qrcode: data.qrcode, token: data.token };
}

export async function pollQrStatus(
  baseUrl: string,
  qrcode: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ status: QrStatusResponse["status"]; token?: string }> {
  const url = `${baseUrl}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const res = await fetchFn(url, { method: "GET" });
  if (!res.ok) throw new Error(`HTTP ${res.status} from pollQrStatus`);
  const data = (await res.json()) as QrStatusResponse;
  if (data.errcode !== 0) throw new WechatApiError(data.errcode, data.errmsg);
  return { status: data.status, token: data.token };
}

export async function getUpdates(
  baseUrl: string,
  token: string,
  syncBuf: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ msgs: WechatMsg[]; syncBuf: string }> {
  const url = `${baseUrl}/ilink/bot/getupdates`;
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ sync_buf: syncBuf, timeout: 35 }),
    signal: AbortSignal.timeout(40_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from getUpdates`);
  const data = (await res.json()) as GetUpdatesResponse;
  if (data.errcode !== 0) throw new WechatApiError(data.errcode, data.errmsg);
  return {
    msgs: data.msg_list ?? [],
    syncBuf: data.sync_buf ?? syncBuf,
  };
}

export async function sendMessage(
  baseUrl: string,
  token: string,
  to: string,
  text: string,
  contextToken?: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const chunks = splitText(text);
  for (const chunk of chunks) {
    const body: Record<string, unknown> = {
      to,
      msg_type: 1,
      content: chunk,
    };
    if (contextToken) body.context_token = contextToken;

    const url = `${baseUrl}/ilink/bot/sendmessage`;
    const res = await fetchFn(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from sendMessage`);
    const data = (await res.json()) as SendMessageResponse;
    if (data.errcode !== 0) throw new WechatApiError(data.errcode, data.errmsg);
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
