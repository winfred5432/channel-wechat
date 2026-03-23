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
