import { describe, expect, it } from "vitest";
import { StreamingMarkdownFilter } from "../src/markdown-filter.js";

describe("StreamingMarkdownFilter", () => {
  it("preserves code fences verbatim across chunks", () => {
    const filter = new StreamingMarkdownFilter();
    const first = filter.feed("before\n```ts\ncon");
    const second = filter.feed("sole.log(1)\n```\nafter");
    expect(first + second).toBe("before\n```ts\nconsole.log(1)\n```\nafter");
    expect(filter.flush()).toBe("");
  });

  it("preserves inline code and table rows", () => {
    const filter = new StreamingMarkdownFilter();
    const input = "Use `x * y` and | a | b |\n|---|---|\n";
    expect(filter.feed(input)).toBe(input);
    expect(filter.flush()).toBe("");
  });

  it("removes image markdown entirely", () => {
    const filter = new StreamingMarkdownFilter();
    expect(filter.feed("keep ![alt text](https://example.com/a.png) tail")).toBe("keep  tail");
    expect(filter.flush()).toBe("");
  });

  it("strips h5 and h6 markers at line start", () => {
    const filter = new StreamingMarkdownFilter();
    expect(filter.feed("##### Heading\n###### Another\n### Keep\n")).toBe("Heading\nAnother\n### Keep\n");
    expect(filter.flush()).toBe("");
  });

  it("keeps bold markers and strips CJK italics markers", () => {
    const filter = new StreamingMarkdownFilter();
    expect(filter.feed("**bold** and *italic* and *中文*")).toBe("**bold** and *italic* and 中文");
    expect(filter.flush()).toBe("");
  });

  it("handles split image markers and unmatched trailing markers", () => {
    const filter = new StreamingMarkdownFilter();
    expect(filter.feed("start ![" )).toBe("start ");
    expect(filter.feed("alt](url) end *")).toBe(" end ");
    expect(filter.flush()).toBe("*");
  });
});
