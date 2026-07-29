import { clipboard, nativeImage, type NativeImage } from 'electron';
import { createHash } from 'node:crypto';
import type { ClipboardPayload } from '../shared/types';

/**
 * Images past this size are worth a second look before they go on the wire.
 * Below it, the encoding choice makes no difference anyone can feel.
 */
const JPEG_THRESHOLD_BYTES = 384 * 1024;
const JPEG_QUALITY = 88;

export function readClipboardText(): string {
  return clipboard.readText().trim();
}

/**
 * Whatever image is on the clipboard, identified cheaply and encoded lazily.
 *
 * The clipboard is polled several times a second, and encoding an image to PNG
 * costs well over a hundred milliseconds for a screenshot — which the app used
 * to pay on every single poll, for as long as that screenshot stayed on the
 * clipboard, purely to work out whether it had changed. The raw bitmap is
 * already in memory, so hashing that answers the same question for a fraction
 * of the cost, and the encode only happens for a picture actually being sent.
 */
export type ClipboardImage = {
  fingerprint: string;
  toDataUrl: () => string;
};

export function readClipboardImage(): ClipboardImage | null {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return null;
  }

  const bitmap = image.toBitmap();
  const { width, height } = image.getSize();
  const digest = createHash('sha1').update(bitmap).digest('hex');

  return {
    fingerprint: `${width}x${height}:${digest}`,
    toDataUrl: () => encodeForTransfer(image, bitmap)
  };
}

export function readClipboardImageDataUrl(): string | null {
  return readClipboardImage()?.toDataUrl() ?? null;
}

/**
 * PNG for anything small, and for anything with transparency to protect. For a
 * large photograph or screenshot, JPEG is routinely a fraction of the size, and
 * every byte saved is time the far side spends waiting for the paste.
 */
function encodeForTransfer(image: NativeImage, bitmap: Buffer): string {
  const png = image.toPNG();
  const asPng = () => `data:image/png;base64,${png.toString('base64')}`;

  if (png.byteLength <= JPEG_THRESHOLD_BYTES || hasTransparency(bitmap)) {
    return asPng();
  }

  const jpeg = image.toJPEG(JPEG_QUALITY);
  // Only worth a lossy copy when it is a saving worth having.
  return jpeg.byteLength > 0 && jpeg.byteLength * 2 <= png.byteLength
    ? `data:image/jpeg;base64,${jpeg.toString('base64')}`
    : asPng();
}

/** The bitmap is BGRA, so every fourth byte is an alpha value. */
function hasTransparency(bitmap: Buffer): boolean {
  for (let index = 3; index < bitmap.length; index += 4) {
    if (bitmap[index] !== 255) {
      return true;
    }
  }
  return false;
}

export function writeClipboardText(text: string): void {
  clipboard.writeText(text);
}

/**
 * Puts an image on the clipboard and reports the fingerprint it landed with, so
 * the poller recognises it as the copy that just arrived rather than something
 * freshly copied here and sends it straight back where it came from.
 */
export function writeClipboardImage(dataUrl: string): string | null {
  const image = nativeImage.createFromDataURL(dataUrl);
  clipboard.writeImage(image);
  return readClipboardImage()?.fingerprint ?? null;
}

export function createTextClipboardPayload(sourceId: string, sourceName: string, text: string): ClipboardPayload {
  return {
    kind: 'text',
    text,
    sourceId,
    sourceName,
    timestamp: Date.now(),
    dataUrl: undefined
  };
}

export function createImageClipboardPayload(sourceId: string, sourceName: string, dataUrl: string): ClipboardPayload {
  return {
    kind: 'image',
    text: '',
    sourceId,
    sourceName,
    timestamp: Date.now(),
    dataUrl
  };
}
