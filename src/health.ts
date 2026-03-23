import http from "node:http";

export interface HealthState {
  running: boolean;
  tokenObtainedAt: number; // timestamp ms, 0 if never
}

export function startHealthServer(state: HealthState, port: number): http.Server {
  const server = http.createServer((req, res) => {
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    if (!state.running) {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "unavailable", reason: "gateway_stopped" }));
      return;
    }

    const tokenAgeMs = state.tokenObtainedAt > 0 ? Date.now() - state.tokenObtainedAt : Infinity;
    if (tokenAgeMs > 20 * 60 * 60 * 1000) { // 20h stale threshold
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "token_stale",
        token_age_hours: Math.floor(tokenAgeMs / 3_600_000),
      }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      status: "ok",
      uptime_seconds: Math.floor(process.uptime()),
      token_age_hours: Math.floor(tokenAgeMs / 3_600_000),
    }));
  });

  server.listen(port, () => {
    console.log(`[INFO] [wechat-channel] Health check listening on :${port}/health`);
  });

  return server;
}
