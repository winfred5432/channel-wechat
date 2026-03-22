import { homedir } from "node:os";
import { resolve } from "node:path";

export interface Config {
  daemonUrl: string;
  apiBase: string;
  cdnBase: string;
  dmPolicy: "open" | "allowlist";
  allowFrom: string[];
  stateDir: string;
  logLevel: string;
}

export function loadConfig(): Config {
  const dmPolicy = process.env.WECHAT_DM_POLICY ?? "open";
  if (dmPolicy !== "open" && dmPolicy !== "allowlist") {
    throw new Error(`WECHAT_DM_POLICY must be 'open' or 'allowlist', got: ${dmPolicy}`);
  }

  const allowFromRaw = process.env.WECHAT_ALLOW_FROM ?? "";
  const allowFrom = allowFromRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (dmPolicy === "allowlist" && allowFrom.length === 0) {
    throw new Error("WECHAT_DM_POLICY=allowlist requires WECHAT_ALLOW_FROM to be set");
  }

  const stateDirRaw = process.env.WECHAT_STATE_DIR ?? "~/.openduo/wechat-channel";
  const stateDir = stateDirRaw.startsWith("~")
    ? resolve(homedir(), stateDirRaw.slice(2))
    : resolve(stateDirRaw);

  const logLevel = process.env.WECHAT_LOG_LEVEL ?? "info";
  if (!["error", "warn", "info", "debug"].includes(logLevel)) {
    throw new Error(`WECHAT_LOG_LEVEL must be one of error|warn|info|debug, got: ${logLevel}`);
  }

  return {
    daemonUrl: process.env.ALADUO_DAEMON_URL ?? "http://127.0.0.1:20233",
    apiBase: process.env.WECHAT_API_BASE ?? "https://ilinkai.weixin.qq.com",
    cdnBase: process.env.WECHAT_CDN_BASE ?? "https://cdn.ilinkai.weixin.qq.com",
    dmPolicy,
    allowFrom,
    stateDir,
    logLevel,
  };
}
