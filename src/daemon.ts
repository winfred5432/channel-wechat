import type {
  ChannelIngressParams,
  ChannelPullParams,
  ChannelAckParams,
  OutboundChannelPayload,
} from "@openduo/protocol";

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
  records: OutboundChannelPayload[];
  idle?: boolean;
}

export async function pull(
  daemonUrl: string,
  params: ChannelPullParams,
  fetchFn: typeof fetch = fetch,
): Promise<OutboundChannelPayload[]> {
  const result = await rpc(daemonUrl, "channel.pull", params, fetchFn);
  const res = result as PullResult | null;
  return res?.records ?? [];
}

export async function ack(
  daemonUrl: string,
  params: ChannelAckParams,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  await rpc(daemonUrl, "channel.ack", params, fetchFn);
}
