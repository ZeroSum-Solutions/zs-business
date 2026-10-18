import { createWriteStream } from "node:fs";
import { Transform, type Writable } from "node:stream";

/** Header.payload.signature with a base64url JSON header: every JWT the harness handles. */
const JWT = /eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/g;

export function redactJwts(text: string): string {
  return text.replace(JWT, "[redacted JWT]");
}

/**
 * A log file that never holds a token. Lines are buffered so a JWT split across two chunks
 * is still caught; the tail is flushed on end.
 */
export function redactingLog(file: string): Writable {
  let pending = "";
  const redactor = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      pending += chunk.toString("utf8");
      const cut = pending.lastIndexOf("\n") + 1;
      const ready = pending.slice(0, cut);
      pending = pending.slice(cut);
      done(null, redactJwts(ready));
    },
    flush(done) {
      done(null, redactJwts(pending));
    },
  });
  redactor.pipe(createWriteStream(file));
  return redactor;
}
