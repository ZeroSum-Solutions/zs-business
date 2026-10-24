// Handwritten Kie.ai fixtures (image-port.md IM-17): our own values, in the JSON shape Kie's public
// docs describe for upload, createTask and recordInfo. Nothing here was captured from the live API.
// TODO verify: the shapes against docs.kie.ai (unreachable from the build machine on 2026-10-24).
import { encodeRgbaPng, type RgbaImage } from "../../src/images/png.js";

export const KIE_TEST_KEY = "kie_test_key_0123456789abcdef";
export const UPLOADED_URL = "https://tempfile.redpandaai.co/zs-images/variant-src.png";
export const RESULT_HOST = "https://tempfile.aiquickdraw.com";

/** `POST /api/file-base64-upload` success. */
export const uploadOk = (url = UPLOADED_URL) => ({
  success: true, code: 200, msg: "ok",
  data: { fileName: "variant-src.png", filePath: "zs-images/variant-src.png", downloadUrl: url, fileSize: 1234, mimeType: "image/png", uploadedAt: "2026-10-24T09:00:00.000Z" },
});

/** `POST /api/v1/jobs/createTask` success. */
export const createOk = (taskId: string) => ({ code: 200, msg: "success", data: { taskId } });
/** createTask refused in the body (Kie answers HTTP 200 with its own code). */
export const createRefused = { code: 422, msg: "bad input", data: null };

/** `GET /api/v1/jobs/recordInfo?taskId=...` in each state. */
export function record(taskId: string, model: string, state: "waiting" | "queuing" | "generating" | "success" | "fail", resultUrls: string[] = []) {
  return {
    code: 200, msg: "success",
    data: {
      taskId, model, state,
      param: JSON.stringify({ model, input: {} }),
      resultJson: state === "success" ? JSON.stringify({ resultUrls }) : "",
      failCode: state === "fail" ? "501" : "", failMsg: state === "fail" ? "generation failed" : "",
      costTime: state === "success" ? 4200 : 0,
      completeTime: state === "success" ? 1792828800000 : null,
      createTime: 1792828795000,
    },
  };
}

/** An opaque source with a colour ramp, so every product pixel differs from its neighbours. */
export function sourceImage(width: number, height: number): RgbaImage {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const o = (y * width + x) * 4;
    rgba[o] = x & 0xff; rgba[o + 1] = y & 0xff; rgba[o + 2] = (x + y) & 0xff; rgba[o + 3] = 255;
  }
  return { width, height, rgba };
}

/** The cut-out Kie returns: RGBA at the source's size, a soft-edged ellipse of alpha. */
export function cutoutPng(width: number, height: number): Uint8Array {
  const image = sourceImage(width, height);
  const cx = (width - 1) / 2; const cy = (height - 1) / 2;
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const d = Math.hypot((x - cx) / (width * 0.35), (y - cy) / (height * 0.35));
    image.rgba[(y * width + x) * 4 + 3] = d <= 0.8 ? 255 : d >= 1 ? 0 : Math.round(255 * (1 - d) / 0.2);
  }
  return encodeRgbaPng(image);
}

export function flatPng(width: number, height: number, rgb: readonly [number, number, number]): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let p = 0; p < width * height; p += 1) rgba.set([rgb[0], rgb[1], rgb[2], 255], p * 4);
  return encodeRgbaPng({ width, height, rgba });
}
