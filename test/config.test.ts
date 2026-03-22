import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { loadConfig } from "../src/config.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe("loadConfig", () => {
  beforeEach(() => {
    delete process.env.WECHAT_DM_POLICY;
    delete process.env.WECHAT_ALLOW_FROM;
    delete process.env.WECHAT_STATE_DIR;
    delete process.env.WECHAT_LOG_LEVEL;
    delete process.env.WECHAT_API_BASE;
    delete process.env.ALADUO_DAEMON_URL;
  });

  it("returns defaults", () => {
    const config = loadConfig();
    expect(config.dmPolicy).toBe("open");
    expect(config.allowFrom).toEqual([]);
    expect(config.logLevel).toBe("info");
    expect(config.daemonUrl).toBe("http://127.0.0.1:20233");
    expect(config.apiBase).toBe("https://ilinkai.weixin.qq.com");
    expect(config.stateDir).toContain(".openduo");
  });

  it("resolves ~ in stateDir", () => {
    withEnv({ WECHAT_STATE_DIR: "~/custom/path" }, () => {
      const config = loadConfig();
      expect(config.stateDir).not.toContain("~");
      expect(config.stateDir).toContain("custom/path");
    });
  });

  it("parses allowlist policy and allow_from", () => {
    withEnv({ WECHAT_DM_POLICY: "allowlist", WECHAT_ALLOW_FROM: "uid1,uid2" }, () => {
      const config = loadConfig();
      expect(config.dmPolicy).toBe("allowlist");
      expect(config.allowFrom).toEqual(["uid1", "uid2"]);
    });
  });

  it("trims whitespace in WECHAT_ALLOW_FROM", () => {
    withEnv({ WECHAT_DM_POLICY: "allowlist", WECHAT_ALLOW_FROM: " uid1 , uid2 " }, () => {
      const config = loadConfig();
      expect(config.allowFrom).toEqual(["uid1", "uid2"]);
    });
  });

  it("throws on invalid DM policy", () => {
    withEnv({ WECHAT_DM_POLICY: "invalid" }, () => {
      expect(() => loadConfig()).toThrow(/WECHAT_DM_POLICY/);
    });
  });

  it("throws on allowlist without allow_from", () => {
    withEnv({ WECHAT_DM_POLICY: "allowlist" }, () => {
      expect(() => loadConfig()).toThrow(/WECHAT_ALLOW_FROM/);
    });
  });

  it("throws on invalid log level", () => {
    withEnv({ WECHAT_LOG_LEVEL: "verbose" }, () => {
      expect(() => loadConfig()).toThrow(/WECHAT_LOG_LEVEL/);
    });
  });

  it("uses ALADUO_DAEMON_URL", () => {
    withEnv({ ALADUO_DAEMON_URL: "http://10.0.0.1:8080" }, () => {
      const config = loadConfig();
      expect(config.daemonUrl).toBe("http://10.0.0.1:8080");
    });
  });
});
