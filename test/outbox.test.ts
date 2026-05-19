import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OutboxQueue } from "../src/outbox.js";

function makeRecord(text: string) {
  return {
    sessionKey: "wechat:user1",
    toUser: "user1",
    text,
    attachments: [],
  };
}

describe("OutboxQueue", () => {
  let stateDir: string;
  let filePath: string;

  beforeEach(async () => {
    stateDir = join(tmpdir(), `outbox-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    filePath = join(stateDir, "outbox.jsonl");
  });

  afterEach(async () => {
    await rm(stateDir, { recursive: true, force: true });
  });

  it("returns an empty list when the queue file is absent", async () => {
    const queue = new OutboxQueue(filePath);
    await expect(queue.readAll()).resolves.toEqual([]);
  });

  it("enqueues records, marks failures, filters exhausted attempts, and removes sent records", async () => {
    const queue = new OutboxQueue(filePath);
    const firstId = await queue.enqueue(makeRecord("first"));
    const secondId = await queue.enqueue(makeRecord("second"));

    await queue.markFailed(firstId, "send failed");
    const all = await queue.readAll();
    expect(all.map((record) => record.id)).toEqual([firstId, secondId]);
    expect(all[0].attempts).toBe(1);
    expect(all[0].lastError).toBe("send failed");

    const pendingAfterOneAttempt = await queue.getPending(1);
    expect(pendingAfterOneAttempt.map((record) => record.id)).toEqual([secondId]);

    await queue.markSent(secondId);
    expect((await queue.readAll()).map((record) => record.id)).toEqual([firstId]);
  });

  it("skips malformed persisted lines", async () => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      filePath,
      [
        "{not-json}",
        JSON.stringify({
          id: "ok",
          sessionKey: "wechat:user1",
          toUser: "user1",
          text: "hello",
          attachments: [],
          createdAt: 1,
          attempts: 0,
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const queue = new OutboxQueue(filePath);
    expect((await queue.readAll()).map((record) => record.id)).toEqual(["ok"]);
  });
});
