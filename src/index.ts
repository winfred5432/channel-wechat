import { writeFileSync, readFileSync, unlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, resolveStateDir } from "./config.js";
import { Auth } from "./auth.js";
import { Gateway } from "./gateway.js";
import { startHealthServer } from "./health.js";
import { OutboxQueue } from "./outbox.js";
import { printPendingQrCodeTerminal } from "./qr-state.js";

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

function readStateDirArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--state-dir") return args[i + 1];
    if (arg.startsWith("--state-dir=")) return arg.slice("--state-dir=".length);
  }
  return undefined;
}

async function runQrCodeTerminal(args: string[]): Promise<void> {
  const stateDir = readStateDirArg(args) ?? resolveStateDir();
  await printPendingQrCodeTerminal(stateDir);
}

async function runAdapter() {
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

  const outbox = new OutboxQueue(join(config.stateDir, "outbox.jsonl"));
  const gateway = new Gateway(config, auth, fetch, outbox);
  gateway.start();

  const healthPort = parseInt(process.env.WECHAT_HEALTH_PORT ?? "8765", 10);
  const healthState = { running: true, tokenObtainedAt: auth.tokenObtainedAt };
  const healthServer = startHealthServer(healthState, healthPort);
  // Keep tokenObtainedAt in sync as auth refreshes
  const healthSyncInterval = setInterval(() => {
    healthState.tokenObtainedAt = auth.tokenObtainedAt;
  }, 60_000);

  // Graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      console.log(`\n[INFO] [wechat-channel] Received ${sig}, shutting down…`);
      healthState.running = false;
      clearInterval(healthSyncInterval);
      healthServer.close();
      gateway.stop();
      releaseLock();
      process.exit(0);
    });
  }
  process.on("exit", releaseLock);
}

export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const [command, ...args] = argv;
  if (command === "qrcode-terminal") {
    await runQrCodeTerminal(args);
    return;
  }
  await runAdapter();
}

const entryArg = process.argv[1];
const isEntrypoint = Boolean(entryArg) && import.meta.url === pathToFileURL(entryArg).href;

if (isEntrypoint) {
  runCli().catch((err) => {
    console.error("[FATAL]", err);
    process.exit(1);
  });
}
