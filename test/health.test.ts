import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startHealthServer, type HealthState } from "../src/health.js";

async function startServer(state: HealthState) {
  const server = startHealthServer(state, 0);
  await new Promise<void>((resolve) => server.on("listening", resolve));
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

describe("startHealthServer", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 404 for non-health requests", async () => {
    const server = await startServer({ running: true, tokenObtainedAt: Date.now() });
    try {
      const res = await fetch(`${server.baseUrl}/missing`);
      expect(res.status).toBe(404);
      await expect(res.text()).resolves.toBe("Not Found");
    } finally {
      await server.close();
    }
  });

  it("returns unavailable when the gateway is stopped", async () => {
    const server = await startServer({ running: false, tokenObtainedAt: Date.now() });
    try {
      const res = await fetch(`${server.baseUrl}/health`);
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({
        status: "unavailable",
        reason: "gateway_stopped",
      });
    } finally {
      await server.close();
    }
  });

  it("returns ok while running with a fresh token", async () => {
    const server = await startServer({ running: true, tokenObtainedAt: Date.now() });
    try {
      const res = await fetch(`${server.baseUrl}/health`);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toMatchObject({ status: "ok" });
    } finally {
      await server.close();
    }
  });

  it("returns token_stale before a token has been obtained", async () => {
    const server = await startServer({ running: true, tokenObtainedAt: 0 });
    try {
      const res = await fetch(`${server.baseUrl}/health`);
      expect(res.status).toBe(503);
      await expect(res.json()).resolves.toMatchObject({ status: "token_stale" });
    } finally {
      await server.close();
    }
  });
});
