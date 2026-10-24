// Transcription ports (docs/requirements/transcription.md X-1, X-4, X-8). Core holds no storage
// client and no voicemail table: the API wires real adapters, and tests use the fakes below.
import type { Transaction } from "@zs/db";

/** One piece of audio a worker can read. */
export interface AudioObject {
  readonly body: Uint8Array | ReadableStream<Uint8Array>;
  readonly bytes: number;
  readonly contentType: string;
}

export interface SignedUpload {
  readonly uploadUrl: string;
  readonly method: "PUT";
  readonly expiresAt: Date;
}

/**
 * Where uploaded audio lives, keyed by the server-built path `audio/<tenantId>/<jobId>`. A tenant
 * never names the path. Deletion is best effort after a job ends (X-8); a daily sweep is the backstop.
 */
export interface TranscriptionAudioStore {
  signUpload(input: { readonly path: string; readonly maxBytes: number; readonly now: Date }): Promise<SignedUpload>;
  /** The size of the stored object, or null when nothing was uploaded to that path. */
  head(path: string): Promise<{ readonly bytes: number } | null>;
  read(path: string): Promise<AudioObject | null>;
  delete(path: string): Promise<void>;
}

/**
 * The voicemail side of a job (twilio.md T-13): the missed-call slice owns the voicemails table and
 * its recordings. `find` runs in the job's tenant transaction and says whether this tenant has the
 * voicemail; `open` fetches its audio for the worker.
 */
export interface VoicemailSource {
  find(tx: Transaction, tenantId: string, voicemailId: string): Promise<boolean>;
  open(tenantId: string, voicemailId: string): Promise<AudioObject | null>;
}

export const audioPath = (tenantId: string, jobId: string): string => `audio/${tenantId}/${jobId}`;

/** In-memory store for tests and demos: signs a fake URL and keeps bytes in a map. */
export class InMemoryAudioStore implements TranscriptionAudioStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType: string }>();
  readonly deleted: string[] = [];

  async signUpload(input: { path: string; maxBytes: number; now: Date }): Promise<SignedUpload> {
    return { uploadUrl: `https://audio.example.test/${input.path}`, method: "PUT", expiresAt: new Date(input.now.getTime() + 15 * 60_000) };
  }
  /** A test stands in for the owner's PUT to the signed URL. */
  put(path: string, bytes: Uint8Array, contentType = "audio/wav"): void {
    this.objects.set(path, { bytes, contentType });
  }
  async head(path: string) {
    const found = this.objects.get(path);
    return found ? { bytes: found.bytes.byteLength } : null;
  }
  async read(path: string): Promise<AudioObject | null> {
    const found = this.objects.get(path);
    return found ? { body: found.bytes, bytes: found.bytes.byteLength, contentType: found.contentType } : null;
  }
  async delete(path: string): Promise<void> {
    this.deleted.push(path);
    this.objects.delete(path);
  }
}

/** In-memory voicemails, keyed by tenant, for tests. */
export class InMemoryVoicemails implements VoicemailSource {
  private readonly items = new Map<string, Uint8Array>();
  add(tenantId: string, voicemailId: string, bytes: Uint8Array): void {
    this.items.set(`${tenantId}/${voicemailId}`, bytes);
  }
  async find(_tx: Transaction, tenantId: string, voicemailId: string): Promise<boolean> {
    return this.items.has(`${tenantId}/${voicemailId}`);
  }
  async open(tenantId: string, voicemailId: string): Promise<AudioObject | null> {
    const bytes = this.items.get(`${tenantId}/${voicemailId}`);
    return bytes ? { body: bytes, bytes: bytes.byteLength, contentType: "audio/wav" } : null;
  }
}
