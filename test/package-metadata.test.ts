import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type PackageJson = {
  publishConfig?: { access?: string };
  main?: string;
  files?: string[];
  bin?: Record<string, string>;
  aladuo?: {
    channel?: {
      type?: string;
      bin?: string;
      envAllowlist?: string[];
    };
  };
};

function readPackageJson(): PackageJson {
  return JSON.parse(
    readFileSync(join(process.cwd(), "package.json"), "utf8")
  ) as PackageJson;
}

describe("package metadata", () => {
  it("declares the duoduo plugin contract", () => {
    const pkg = readPackageJson();

    expect(pkg.publishConfig?.access).toBe("public");
    expect(pkg.main).toBe("dist/plugin.js");
    expect(pkg.files).toEqual(expect.arrayContaining(["dist/", "README.md", "package.json"]));
    expect(pkg.bin).toEqual({ "duoduo-wechat": "./dist/plugin.js" });
    expect(pkg.aladuo?.channel).toEqual({
      type: "wechat",
      bin: "dist/plugin.js",
      envAllowlist: [
        "ALADUO_DAEMON_URL",
        "WECHAT_API_BASE",
        "WECHAT_DM_POLICY",
        "WECHAT_ALLOW_FROM",
        "WECHAT_STATE_DIR",
        "WECHAT_LOG_LEVEL",
        "WECHAT_HEALTH_PORT"
      ]
    });
  });
});
