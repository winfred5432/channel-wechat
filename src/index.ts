#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { Auth } from "./auth.js";
import { Gateway } from "./gateway.js";

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
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
      process.exit(0);
    });
  }
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
