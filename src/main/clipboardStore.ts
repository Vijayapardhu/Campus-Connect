import { clipboard, nativeImage } from 'electron';
import type { ClipboardPayload } from '../shared/types';

export function readClipboardText(): string {
  return clipboard.readText().trim();
}

export function readClipboardImageDataUrl(): string | null {
  const image = clipboard.readImage();
  if (image.isEmpty()) {
    return null;
  }

  return image.toDataURL();
}

export function writeClipboardText(text: string): void {
  clipboard.writeText(text);
}

export function writeClipboardImage(dataUrl: string): void {
  const image = nativeImage.createFromDataURL(dataUrl);
  clipboard.writeImage(image);
}

export function copyImageToClipboard(dataUrl: string): void {
  const image = nativeImage.createFromDataURL(dataUrl);
  clipboard.writeImage(image);
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
