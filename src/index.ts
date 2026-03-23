#!/usr/bin/env node
import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { loadConfig } from "./config.js";
import { Auth } from "./auth.js";
import { Gateway } from "./gateway.js";

const PIDFILE = "/tmp/channel-wechat.pid";

function acquireLock(): void {
  if (existsSync(PIDFILE)) {
    const oldPid = parseInt(readFileSync(PIDFILE, "utf-8").trim(), 10);
    // Check if the old process is still alive
    try {
      process.kill(oldPid, 0); // signal 0 = just check existence
      console.error(`[ERROR] Another channel-wechat process is already running (PID ${oldPid}). Exiting.`);
      process.exit(1);
    } catch {
      // Process is dead — stale pidfile, safe to overwrite
      console.warn(`[WARN] Stale pidfile found (PID ${oldPid} is dead), overwriting.`);
    }
  }
  writeFileSync(PIDFILE, String(process.pid), "utf-8");
}

function releaseLock(): void {
  try { unlinkSync(PIDFILE); } catch { /* ignore */ }
}

async function main() {
  acquireLock();

  let config;
  try {
    config = loadConfig();
  } catch (err) {
    releaseLock();
    console.error(`[ERROR] Configuration error: ${String(err)}`);
    process.exit(1);
  }

  console.log("[INFO] [wechat-channel] Starting openduo WeChat channel adapter");
  console.log(`[INFO] [wechat-channel] Daemon: ${config.daemonUrl}`);
  console.log(`[INFO] [wechat-channel] DM policy: ${config.dmPolicy}`);
  console.log(`[INFO] [wechat-channel] State dir: ${config.stateDir}`);

  const auth = new Auth(config.stateDir, config.apiBase);

  // Ensure we have a token before starting the gateway
  try {
    await auth.getToken();
  } catch (err) {
    console.error(`[ERROR] Authentication failed: ${String(err)}`);
    process.exit(1);
  }

  const gateway = new Gateway(config, auth);
  gateway.start();

  // Graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.log(`\n[INFO] [wechat-channel] Received ${sig}, shutting down…`);
      gateway.stop();
      releaseLock();
      process.exit(0);
    });
  }
  process.on("exit", releaseLock);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
