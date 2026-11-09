import type { BoardAsset } from '../src/shared/board.js';

export class UnsupportedImageError extends Error {}

export interface ImageInfo {
  mimeType: BoardAsset['mimeType'];
  width: number;
  height: number;
}

function dimensions(width: number, height: number): { width: number; height: number } {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 12_000 || height > 12_000 || width * height > 25_000_000) {
    throw new UnsupportedImageError('Слишком большой или некорректный размер изображения.');
  }
  return { width, height };
}

function pngCrc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  let offset = 8;
  let width = 0; let height = 0; let sawHeader = false; let sawData = false; let sawEnd = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const crcOffset = dataStart + length;
    if (crcOffset + 4 > bytes.length) break;
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (pngCrc32(bytes.subarray(offset + 4, crcOffset)) !== bytes.readUInt32BE(crcOffset)) {
      throw new UnsupportedImageError('Файл PNG повреждён (ошибка CRC).');
    }
    if (!sawHeader) {
      if (type !== 'IHDR' || length !== 13) throw new UnsupportedImageError('Некорректный заголовок PNG.');
      width = bytes.readUInt32BE(dataStart); height = bytes.readUInt32BE(dataStart + 4); sawHeader = true;
    } else if (type === 'IHDR') {
      throw new UnsupportedImageError('Некорректная структура PNG.');
    }
    if (type === 'IDAT') sawData = true;
    if (type === 'IEND') {
      if (length !== 0 || !sawData || crcOffset + 4 !== bytes.length) throw new UnsupportedImageError('Файл PNG повреждён.');
      sawEnd = true;
      break;
    }
    offset = crcOffset + 4;
  }
  if (!sawHeader || !sawData || !sawEnd) throw new UnsupportedImageError('Файл PNG обрезан или повреждён.');
  return dimensions(width, height);
}

function jpegDimensions(bytes: Buffer): { width: number; height: number } {
  let offset = 2;
  const frameMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (frameMarkers.has(marker)) {
      if (length < 7) break;
      return dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3));
    }
    offset += length;
  }
  throw new UnsupportedImageError('Файл JPEG повреждён или не содержит размеров кадра.');
}

function webpDimensions(bytes: Buffer): { width: number; height: number } {
  if (bytes.length < 30) throw new UnsupportedImageError('Файл WebP повреждён.');
  const chunk = bytes.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return dimensions(1 + bytes.readUIntLE(24, 3), 1 + bytes.readUIntLE(27, 3));
  }
  if (chunk === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return dimensions(bytes.readUInt16LE(26) & 0x3fff, bytes.readUInt16LE(28) & 0x3fff);
  }
  if (chunk === 'VP8L' && bytes[20] === 0x2f && bytes.length >= 25) {
    const b0 = bytes[21]!; const b1 = bytes[22]!; const b2 = bytes[23]!; const b3 = bytes[24]!;
    return dimensions(1 + b0 + ((b1 & 0x3f) << 8), 1 + (b1 >> 6) + (b2 << 2) + ((b3 & 0x0f) << 10));
  }
  throw new UnsupportedImageError('Файл WebP повреждён или имеет неподдерживаемый заголовок.');
}

export function inspectImage(bytes: Buffer, claimedMime: string): ImageInfo {
  let info: ImageInfo;
  if (bytes.length >= 45 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    info = { mimeType: 'image/png', ...pngDimensions(bytes) };
  } else if (bytes.length >= 6 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) {
    info = { mimeType: 'image/jpeg', ...jpegDimensions(bytes) };
  } else if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new UnsupportedImageError('Файл WebP повреждён.');
    info = { mimeType: 'image/webp', ...webpDimensions(bytes) };
  } else {
    throw new UnsupportedImageError('Поддерживаются только PNG, JPEG и WebP с корректной сигнатурой.');
  }
  if (claimedMime !== info.mimeType) throw new UnsupportedImageError('MIME-тип не совпадает с содержимым изображения.');
  return info;
}
