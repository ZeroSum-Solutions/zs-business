// Image bytes (image-port.md IM-3, IM-9). Original code on node:zlib: header reading for the
// three upload types, and a small PNG codec (8-bit gray, gray+alpha, RGB and RGBA, not
// interlaced) so our own code can build and compare pixels without trusting a vendor's output.
import { crc32, deflateSync, inflateSync } from "node:zlib";
import { MEDIA_LIMITS, type MediaContentType } from "@zs/contracts";

export interface ImageInfo {
  readonly contentType: MediaContentType;
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const u16be = (b: Uint8Array, i: number) => (b[i]! << 8) | b[i + 1]!;
const u32be = (b: Uint8Array, i: number) => ((b[i]! * 2 ** 24) + (b[i + 1]! << 16) + (b[i + 2]! << 8) + b[i + 3]!);
const u16le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8);
const u24le = (b: Uint8Array, i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const ascii = (b: Uint8Array, i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));

function startsWith(bytes: Uint8Array, prefix: Uint8Array): boolean {
  return bytes.length >= prefix.length && prefix.every((value, i) => bytes[i] === value);
}

/** The type and size an image's own header claims, or null when it is none of the three types. */
export function readImageInfo(bytes: Uint8Array): ImageInfo | null {
  if (startsWith(bytes, PNG_SIGNATURE)) {
    if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return null;
    return { contentType: "image/png", width: u32be(bytes, 16), height: u32be(bytes, 20) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 4 <= bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1]!;
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      const length = u16be(bytes, i + 2);
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        if (i + 9 > bytes.length) return null;
        return { contentType: "image/jpeg", height: u16be(bytes, i + 5), width: u16be(bytes, i + 7) };
      }
      if (length < 2) return null;
      i += 2 + length;
    }
    return null;
  }
  if (bytes.length >= 30 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") {
    const kind = ascii(bytes, 12, 4);
    if (kind === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a)
      return { contentType: "image/webp", width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff };
    if (kind === "VP8L" && bytes[20] === 0x2f) {
      const bits = bytes[21]! | (bytes[22]! << 8) | (bytes[23]! << 16) | (bytes[24]! * 2 ** 24);
      return { contentType: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (kind === "VP8X") return { contentType: "image/webp", width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 };
  }
  return null;
}

/** IM-3: whether a size is inside the upload limits. */
export function sizeAllowed(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1
    && width <= MEDIA_LIMITS.maxSide && height <= MEDIA_LIMITS.maxSide && width * height <= MEDIA_LIMITS.maxPixels;
}

/** Pixels as RGBA, row by row, four bytes each. */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8Array;
}

export class UnsupportedImage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedImage";
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export interface DecodedPng extends RgbaImage {
  /** PNG colour type: 0 gray, 2 RGB, 4 gray+alpha, 6 RGBA. */
  readonly colorType: number;
}

/** Decodes a non-interlaced 8-bit PNG. Anything else throws UnsupportedImage. */
export function decodePng(bytes: Uint8Array): DecodedPng {
  if (!startsWith(bytes, PNG_SIGNATURE)) throw new UnsupportedImage("Not a PNG");
  let width = 0;
  let height = 0;
  let colorType = -1;
  const data: Uint8Array[] = [];
  let i = 8;
  let sawEnd = false;
  while (i + 12 <= bytes.length) {
    const length = u32be(bytes, i);
    const type = ascii(bytes, i + 4, 4);
    if (i + 12 + length > bytes.length) throw new UnsupportedImage("Truncated PNG chunk");
    const body = bytes.subarray(i + 8, i + 8 + length);
    if (type === "IHDR") {
      if (length !== 13) throw new UnsupportedImage("Bad PNG header");
      width = u32be(body, 0);
      height = u32be(body, 4);
      if (body[8] !== 8) throw new UnsupportedImage("Only 8-bit PNG is supported");
      colorType = body[9]!;
      if (![0, 2, 4, 6].includes(colorType)) throw new UnsupportedImage("Unsupported PNG colour type");
      if (body[10] !== 0 || body[11] !== 0 || body[12] !== 0) throw new UnsupportedImage("Interlaced PNG is not supported");
    } else if (type === "IDAT") data.push(body);
    else if (type === "IEND") { sawEnd = true; break; }
    i += 12 + length;
  }
  if (!sawEnd || colorType < 0 || !sizeAllowed(width, height)) throw new UnsupportedImage("Unreadable PNG");
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const stride = width * channels;
  const expected = height * (stride + 1);
  let raw: Uint8Array;
  try {
    const joined = Buffer.concat(data);
    raw = inflateSync(joined, { maxOutputLength: expected });
  } catch {
    throw new UnsupportedImage("Unreadable PNG data");
  }
  if (raw.length !== expected) throw new UnsupportedImage("Unreadable PNG data");
  const scan = new Uint8Array(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? scan[dst + x - channels]! : 0;
      const up = y > 0 ? scan[dst - stride + x]! : 0;
      const upLeft = y > 0 && x >= channels ? scan[dst - stride + x - channels]! : 0;
      const value = raw[src + x]!;
      switch (filter) {
        case 0: scan[dst + x] = value; break;
        case 1: scan[dst + x] = (value + left) & 0xff; break;
        case 2: scan[dst + x] = (value + up) & 0xff; break;
        case 3: scan[dst + x] = (value + ((left + up) >> 1)) & 0xff; break;
        case 4: scan[dst + x] = (value + paeth(left, up, upLeft)) & 0xff; break;
        default: throw new UnsupportedImage("Bad PNG filter");
      }
    }
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    const s = p * channels;
    const d = p * 4;
    if (colorType === 0) { rgba[d] = rgba[d + 1] = rgba[d + 2] = scan[s]!; rgba[d + 3] = 255; }
    else if (colorType === 2) { rgba[d] = scan[s]!; rgba[d + 1] = scan[s + 1]!; rgba[d + 2] = scan[s + 2]!; rgba[d + 3] = 255; }
    else if (colorType === 4) { rgba[d] = rgba[d + 1] = rgba[d + 2] = scan[s]!; rgba[d + 3] = scan[s + 1]!; }
    else { rgba[d] = scan[s]!; rgba[d + 1] = scan[s + 1]!; rgba[d + 2] = scan[s + 2]!; rgba[d + 3] = scan[s + 3]!; }
  }
  return { width, height, rgba, colorType };
}

function chunk(type: string, body: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "ascii");
  out.set(body, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

function encode(width: number, height: number, colorType: 0 | 6, channels: 1 | 4, pixels: Uint8Array): Uint8Array {
  if (!sizeAllowed(width, height) || pixels.length !== width * height * channels) throw new UnsupportedImage("Bad image size");
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) raw.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = colorType;
  return new Uint8Array(Buffer.concat([
    PNG_SIGNATURE, chunk("IHDR", header), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array(0)),
  ]));
}

/** Deterministic: the same pixels always give the same bytes (filter 0, fixed zlib level). */
export const encodeRgbaPng = (image: RgbaImage): Uint8Array => encode(image.width, image.height, 6, 4, image.rgba);
/** An 8-bit grayscale PNG: one byte per pixel. */
export const encodeGrayPng = (width: number, height: number, gray: Uint8Array): Uint8Array => encode(width, height, 0, 1, gray);
