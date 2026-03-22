import type {
  ChannelIngressParams,
  ChannelPullParams,
  ChannelAckParams,
  OutboundChannelPayload,
} from "@openduo/protocol";
import { outboxToOutbound } from "@openduo/protocol";

// ---------------------------------------------------------------------------
// WebSocket subscription
// ---------------------------------------------------------------------------

export type WsOutputCallback = (payload: OutboundChannelPayload) => Promise<void>;

/**
 * Open a persistent WebSocket connection to the daemon and subscribe to
 * session output via channel.pull.  Capabilities are registered server-side
 * on connection so the bot knows the channel supports attachments.
 *
 * The returned cleanup function closes the socket.
 */
export function subscribePull(params: {
  daemonUrl: string;
  sessionKey: string;
  consumerId: string;
  cursor?: string;
  sourceKind?: string;
  onOutput: WsOutputCallback;
  onAck: (cursor: string) => void;
  onError: (err: Error) => void;
  onClose: () => void;
}): () => void {
  const wsUrl = params.daemonUrl.replace(/^http/, "ws") + "/ws";
  const ws = new WebSocket(wsUrl);
  let reqId = 1;

  ws.addEventListener("open", () => {
    const pullReq = {
      jsonrpc: "2.0",
      id: `pull_${reqId++}`,
      method: "channel.pull",
      params: {
        session_key: params.sessionKey,
        consumer_id: params.consumerId,
        cursor: params.cursor || undefined,
        return_mask: ["final"],
        source_kind: params.sourceKind ?? "wechat",
        channel_id: params.sessionKey,
        channel_capabilities: { outbound: { accept_mime: ["*/*"] } },
      } as ChannelPullParams & { source_kind: string; channel_id: string },
    };
    ws.send(JSON.stringify(pullReq));
  });

  ws.addEventListener("message", async (ev) => {
    let msg: { id?: unknown; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(ev.data as string);
    } catch {
      return;
    }

    // Push notification from daemon
    if (msg.method === "session.output") {
      const p = msg.params as { session_key: string; record: Parameters<typeof outboxToOutbound>[0] };
      if (p?.record) {
        const payload = outboxToOutbound(p.record);
        try {
          await params.onOutput(payload);
        } finally {
          // Ack via the same WS connection
          if (p.record.id) {
            const ackReq = {
              jsonrpc: "2.0",
              id: `ack_${reqId++}`,
              method: "channel.ack",
              params: {
                session_key: params.sessionKey,
                consumer_id: params.consumerId,
                cursor: p.record.id,
              },
            };
            ws.send(JSON.stringify(ackReq));
            params.onAck(p.record.id);
          }
        }
      }
      return;
    }

    // RPC response (e.g. to our pull request) — check for errors
    if (msg.error) {
      params.onError(new DaemonError(msg.error.code, msg.error.message));
    }
  });

  ws.addEventListener("error", () => {
    params.onError(new Error("WebSocket error"));
  });

  ws.addEventListener("close", () => {
    params.onClose();
  });

  return () => {
    try { ws.close(); } catch { /* ignore */ }
  };
}

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params: unknown;
};

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

let _reqId = 1;

export class DaemonError extends Error {
  constructor(
    public readonly code: number,
    message: string,
  ) {
    super(`DaemonError[${code}]: ${message}`);
    this.name = "DaemonError";
  }
}

async function rpc(
  daemonUrl: string,
  method: string,
  params: unknown,
  fetchFn: typeof fetch = fetch,
): Promise<unknown> {
  const id = _reqId++;
  const body: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
  const res = await fetchFn(`${daemonUrl}/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Daemon HTTP ${res.status} for method ${method}`);
  }
  const data = (await res.json()) as JsonRpcResponse;
  if (data.error) {
    throw new DaemonError(data.error.code, data.error.message);
  }
  return data.result;
}

export async function ingress(
  daemonUrl: string,
  params: ChannelIngressParams,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await rpc(daemonUrl, "channel.ingress", params, fetchFn);
}

interface PullResult {
  // daemon returns raw OutboxRecord objects; we apply outboxToOutbound mapping
  records: Parameters<typeof outboxToOutbound>[0][];
  idle?: boolean;
}

export async function pull(
  daemonUrl: string,
  params: ChannelPullParams,
  fetchFn: typeof fetch = fetch,
): Promise<OutboundChannelPayload[]> {
  const result = await rpc(daemonUrl, "channel.pull", params, fetchFn);
  const res = result as PullResult | null;
  return (res?.records ?? []).map(outboxToOutbound);
}

export async function ack(
  daemonUrl: string,
  params: ChannelAckParams,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await rpc(daemonUrl, "channel.ack", params, fetchFn);
}
