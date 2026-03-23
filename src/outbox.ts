import { appendFile, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export interface OutboxRecord {
  id: string;
  sessionKey: string;
  toUser: string;
  contextToken?: string;
  text: string;
  attachments: Array<{ path: string; mime: string }>;
  createdAt: number;
  attempts: number;
  lastError?: string;
}

const DEFAULT_MAX_ATTEMPTS = 3;

export class OutboxQueue {
  // Serialize all writes through a promise chain to avoid interleaved appends
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async enqueue(
    record: Omit<OutboxRecord, "id" | "createdAt" | "attempts">,
  ): Promise<string> {
    const id = randomBytes(8).toString("hex");
    const full: OutboxRecord = {
      ...record,
      id,
      createdAt: Date.now(),
      attempts: 0,
    };
    const line = JSON.stringify(full) + "\n";

    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, line, "utf8");
    });
    await this.writeChain;
    return id;
  }

  async getPending(maxAttempts: number = DEFAULT_MAX_ATTEMPTS): Promise<OutboxRecord[]> {
    const all = await this.readAll();
    return all
      .filter((r) => r.attempts < maxAttempts)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  async markSent(id: string): Promise<void> {
    await this.rewrite((records) => records.filter((r) => r.id !== id));
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.rewrite((records) =>
      records.map((r) =>
        r.id === id
          ? { ...r, attempts: r.attempts + 1, lastError: error }
          : r,
      ),
    );
  }

  async readAll(): Promise<OutboxRecord[]> {
    if (!existsSync(this.filePath)) return [];
    const raw = await readFile(this.filePath, "utf8");
    const records: OutboxRecord[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as OutboxRecord);
      } catch {
        // Skip malformed lines silently
      }
    }
    return records;
  }

  private async rewrite(
    transform: (records: OutboxRecord[]) => OutboxRecord[],
  ): Promise<void> {
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const records = await this.readAll();
      const updated = transform(records);
      const content = updated.map((r) => JSON.stringify(r)).join("\n") + (updated.length > 0 ? "\n" : "");
      const tmp = this.filePath + ".tmp";
      await writeFile(tmp, content, "utf8");
      await rename(tmp, this.filePath);
    });
    await this.writeChain;
  }
}
