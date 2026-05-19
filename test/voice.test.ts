import { describe, expect, it } from "vitest";
import { toSilk } from "../src/voice.js";

describe("toSilk", () => {
  it("passes through buffers declared as SILK audio", async () => {
    const input = Buffer.from("raw silk bytes");
    const result = await toSilk(input, "audio/silk");
    expect(result.silk).toBe(input);
    expect(result.playtimeMs).toBe(Math.round(input.length / 3));
  });

  it("passes through buffers with a SILK magic header", async () => {
    const input = Buffer.from("#!SILK_V3\npayload");
    const result = await toSilk(input, "application/octet-stream");
    expect(result.silk).toBe(input);
    expect(result.playtimeMs).toBe(Math.round(input.length / 3));
  });
});
