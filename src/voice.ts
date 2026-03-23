/**
 * Audio → SILK transcoding for WeChat voice messages.
 *
 * WeChat ilink only accepts SILK v3 encoded audio (encode_type=6).
 * Most TTS outputs are mp3/wav/m4a, so we transcode:
 *
 *   mp3/wav/m4a/ogg/… → ffmpeg → PCM (16kHz, 16-bit LE, mono) → silk-wasm → SILK
 *
 * ffmpeg must be available on PATH.
 */

import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Sample rate used for WeChat voice messages. */
export const VOICE_SAMPLE_RATE = 16000;

/**
 * Transcode an arbitrary audio buffer to SILK v3 format.
 *
 * @param buf - Raw audio file bytes (mp3, wav, m4a, ogg, silk, …)
 * @param mime - MIME type hint, e.g. "audio/mpeg", "audio/wav", "audio/silk"
 * @returns SILK-encoded buffer ready for upload (mediaType=VOICE)
 */
export async function toSilk(buf: Buffer, mime: string): Promise<{ silk: Buffer; playtimeMs: number }> {
  // If already SILK, pass through directly.
  // Detect by MIME or magic bytes ("#!SILK" header).
  if (mime === "audio/silk" || isSilkBuffer(buf)) {
    // Estimate playtime from buffer size (rough: ~1.3 kB/s at 24kbps)
    const playtimeMs = estimateSilkPlaytime(buf);
    return { silk: buf, playtimeMs };
  }

  // Step 1: decode to raw PCM via ffmpeg
  const pcm = await toPcm(buf);

  // Step 2: encode PCM → SILK via silk-wasm
  const { encode } = await import("silk-wasm");
  const result = await encode(pcm, VOICE_SAMPLE_RATE);
  const silk = Buffer.from(result.data);

  // playtime: PCM duration = bytes / (sampleRate * 2 bytes/sample)
  const playtimeMs = Math.round((pcm.length / (VOICE_SAMPLE_RATE * 2)) * 1000);

  return { silk, playtimeMs };
}

/**
 * Use ffmpeg to decode any audio format to raw PCM:
 *   16000 Hz, 16-bit signed little-endian, mono
 */
function toPcm(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-v", "quiet",
      "-i", "pipe:0",          // read from stdin
      "-f", "s16le",           // raw signed 16-bit LE
      "-acodec", "pcm_s16le",
      "-ar", String(VOICE_SAMPLE_RATE),
      "-ac", "1",              // mono
      "pipe:1",                // write to stdout
    ]);

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    ff.stdout.on("data", (d: Buffer) => chunks.push(d));
    ff.stderr.on("data", (d: Buffer) => errChunks.push(d));

    ff.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf-8").slice(-500);
        return reject(new Error(`ffmpeg exited ${code}: ${stderr}`));
      }
      resolve(Buffer.concat(chunks));
    });

    ff.on("error", (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));

    ff.stdin.write(buf);
    ff.stdin.end();
  });
}

/**
 * Transcribe a SILK audio buffer using whisper.
 * SILK → ffmpeg → WAV → whisper → text
 *
 * @returns Transcribed text, or null if whisper fails.
 */
export async function transcribeSilk(buf: Buffer): Promise<string | null> {
  const tmpWav = join(tmpdir(), `wechat-voice-${randomBytes(4).toString("hex")}.wav`);
  try {
    // Decode SILK to WAV via ffmpeg
    const wav = await toWav(buf);
    await writeFile(tmpWav, wav);

    // Run whisper CLI
    const text = await runWhisper(tmpWav);
    return text || null;
  } finally {
    unlink(tmpWav).catch(() => {});
  }
}

/**
 * Use ffmpeg to decode SILK to WAV (16kHz mono).
 */
function toWav(buf: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-v", "quiet",
      "-i", "pipe:0",
      "-f", "wav",
      "-acodec", "pcm_s16le",
      "-ar", String(VOICE_SAMPLE_RATE),
      "-ac", "1",
      "pipe:1",
    ]);

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    ff.stdout.on("data", (d: Buffer) => chunks.push(d));
    ff.stderr.on("data", (d: Buffer) => errChunks.push(d));

    ff.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf-8").slice(-500);
        return reject(new Error(`ffmpeg (toWav) exited ${code}: ${stderr}`));
      }
      resolve(Buffer.concat(chunks));
    });

    ff.on("error", (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));

    ff.stdin.write(buf);
    ff.stdin.end();
  });
}

/**
 * Run whisper CLI on a WAV file and return the transcribed text.
 */
function runWhisper(wavPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("whisper", [
      wavPath,
      "--model", "base",
      "--language", "zh",
      "--output_format", "txt",
      "--output_dir", tmpdir(),
      "--fp16", "False",
    ]);

    const errChunks: Buffer[] = [];
    proc.stderr.on("data", (d: Buffer) => errChunks.push(d));

    proc.on("close", async (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf-8").slice(-500);
        return reject(new Error(`whisper exited ${code}: ${stderr}`));
      }
      // whisper writes <filename>.txt in output_dir
      const txtPath = join(tmpdir(), wavPath.replace(/\\/g, "/").split("/").pop()!.replace(/\.wav$/, ".txt"));
      try {
        const { readFile } = await import("node:fs/promises");
        const txt = await readFile(txtPath, "utf-8");
        unlink(txtPath).catch(() => {});
        resolve(txt.trim());
      } catch {
        resolve("");
      }
    });

    proc.on("error", (err) => reject(new Error(`whisper spawn failed: ${err.message}`)));
  });
}

/** Check for SILK magic bytes: "#!SILK_V3" or "#!SILK" */
function isSilkBuffer(buf: Buffer): boolean {
  if (buf.length < 9) return false;
  const header = buf.subarray(0, 9).toString("ascii");
  return header.startsWith("#!SILK_V3") || header.startsWith("#!SILK");
}

/**
 * Rough SILK playtime estimate.
 * At 24 kbps: ~3000 bytes/s → ms = bytes / 3
 */
function estimateSilkPlaytime(silk: Buffer): number {
  return Math.round(silk.length / 3);
}
