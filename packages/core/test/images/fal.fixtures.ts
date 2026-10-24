// Handwritten FAL queue fixtures (image-port.md IM-17): our own values in the JSON shape FAL's public
// queue docs describe. Not captured from the live API; shapes marked TODO verify in adapters/fal.ts.
import { vi } from "vitest";
import { encodeRgbaPng, type RgbaImage } from "../../src/images/png.js";

export const FAL_KEY = "fal_test_key_7c1d9e0b4a2f";
export const QUEUE = "https://queue.fal.run";
export const MEDIA = "https://v3.fal.media/files/zs-test";

export const submitBody = (app: string, requestId: string) => ({
  request_id: requestId,
  status_url: `${QUEUE}/${app}/requests/${requestId}/status`,
  response_url: `${QUEUE}/${app}/requests/${requestId}`,
  cancel_url: `${QUEUE}/${app}/requests/${requestId}/cancel`,
});
export const statusBody = (status: "IN_QUEUE" | "IN_PROGRESS" | "COMPLETED", requestId: string, app: string) => ({
  status,
  request_id: requestId,
  response_url: `${QUEUE}/${app}/requests/${requestId}`,
  ...(status === "IN_QUEUE" ? { queue_position: 2 } : {}),
});
export const imageResult = (url: string, width: number, height: number) => ({
  image: { url, content_type: "image/png", file_name: url.split("/").pop(), width, height },
});
export const imagesResult = (url: string, width: number, height: number) => ({
  images: [{ url, content_type: "image/png", width, height }],
  seed: 4242,
  has_nsfw_concepts: [false],
  prompt: "ignored by the adapter",
});
export const errorResult = { detail: [{ loc: ["body", "image_url"], msg: "our own test message", type: "value_error" }], error_type: "validation_error" };

export interface Seen { readonly method: string; readonly url: string; readonly headers: Record<string, string>; readonly body: unknown }
type Route = (seen: Seen) => Response | Promise<Response>;

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
export const png = (bytes: Uint8Array) => new Response(new Uint8Array(bytes), { status: 200, headers: { "content-type": "image/png" } });

/** An injected fetch that routes by `METHOD url` and records every request. An unrouted URL is a test failure. */
export function router(routes: Record<string, Route>) {
  const seen: Seen[] = [];
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, name) => { headers[name] = value; });
    const entry: Seen = {
      method: init?.method ?? "GET", url: String(url), headers,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    seen.push(entry);
    const route = routes[`${entry.method} ${entry.url}`];
    if (!route) throw new Error(`Unrouted test request ${entry.method} ${entry.url}`);
    return route(entry);
  });
  return { seen, fetcher: fetcher as unknown as typeof fetch };
}

/** An opaque test photo: a gradient with a pattern, so every pixel differs from its neighbours. */
export function photo(width: number, height: number): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p += 1) {
    rgba[p * 4] = (p * 7) & 0xff;
    rgba[p * 4 + 1] = (p * 3 + 40) & 0xff;
    rgba[p * 4 + 2] = (p * 11 + 9) & 0xff;
    rgba[p * 4 + 3] = 255;
  }
  return { width, height, rgba };
}

/** The vendor's cut-out: the source's colours with a soft ellipse as alpha (partial alpha at the rim). */
export function cutout(source: RgbaImage, size = { width: source.width, height: source.height }): Uint8Array {
  const { width, height } = size;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const d = Math.hypot((x - (width - 1) / 2) / (width * 0.35), (y - (height - 1) / 2) / (height * 0.35));
      const a = d <= 0.8 ? 255 : d >= 1 ? 0 : Math.round((255 * (1 - d)) / 0.2);
      const from = (Math.min(y, source.height - 1) * source.width + Math.min(x, source.width - 1)) * 4;
      // A cut-out may change colour under the alpha; only the alpha is used (IM-9).
      rgba[p * 4] = (source.rgba[from]! + 3) & 0xff;
      rgba[p * 4 + 1] = source.rgba[from + 1]!;
      rgba[p * 4 + 2] = source.rgba[from + 2]!;
      rgba[p * 4 + 3] = a;
    }
  }
  return encodeRgbaPng({ width, height, rgba });
}

export function flat(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p += 1) rgba.set([rgb[0], rgb[1], rgb[2], 255], p * 4);
  return encodeRgbaPng({ width, height, rgba });
}
