import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type OutputWriter = (chunk: string) => boolean;

const QR_CODE_PNG = "qrcode.png";
const QR_CODE_TEXT = "qrcode.txt";

function resolveQrFile(stateDir: string, fileName: string): string {
  return resolve(stateDir, fileName);
}

export function getQrCodePngPath(stateDir: string): string {
  return resolveQrFile(stateDir, QR_CODE_PNG);
}

export function getQrCodeTextPath(stateDir: string): string {
  return resolveQrFile(stateDir, QR_CODE_TEXT);
}

export async function savePendingQrCode(stateDir: string, qrPayload: string): Promise<void> {
  if (!existsSync(stateDir)) {
    await mkdir(stateDir, { recursive: true });
  }
  await writeFile(getQrCodeTextPath(stateDir), qrPayload, "utf8");
}

export async function clearPendingQrCode(stateDir: string): Promise<void> {
  await Promise.all([
    unlink(getQrCodePngPath(stateDir)).catch(() => {}),
    unlink(getQrCodeTextPath(stateDir)).catch(() => {}),
  ]);
}

export async function printPendingQrCodeTerminal(
  stateDir: string,
  writer: OutputWriter = (chunk) => process.stdout.write(chunk),
): Promise<void> {
  const txtPath = getQrCodeTextPath(stateDir);
  let qrPayload: string;
  try {
    qrPayload = (await readFile(txtPath, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const pngPath = getQrCodePngPath(stateDir);
      if (existsSync(pngPath)) {
        throw new Error(
          `No current pending QR code found in ${stateDir}. Existing ${pngPath} is likely stale; trigger a fresh QR login before using qrcode-terminal.`,
        );
      }
      throw new Error(
        `No current pending QR code found in ${stateDir}. Start a fresh QR login before using qrcode-terminal.`,
      );
    }
    throw error;
  }
  if (!qrPayload) {
    throw new Error(`No current pending QR code found in ${stateDir}. Start a fresh QR login before using qrcode-terminal.`);
  }

  const QRCode = (await import("qrcode")).default;
  const terminalQr = await QRCode.toString(qrPayload, { type: "terminal", small: true });
  writer(terminalQr.endsWith("\n") ? terminalQr : `${terminalQr}\n`);
}
