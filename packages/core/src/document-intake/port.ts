// Document intake ports (docs/requirements/document-intake.md DL-3, DL-9, DL-16). Core holds no
// storage client and no Python: the API wires a real file store, the Docling service implements the
// same JSON over HTTPS, and tests use the fakes below.
import type { DoclingResult } from "@zs/contracts";

/** DL-9: what the Docling port is given. The PDF is untrusted data. */
export interface DoclingInput {
  readonly tenantId: string;
  readonly jobId: string;
  readonly fileSha256: string;
  readonly bytes: Uint8Array;
  readonly maxPages: number;
}

export interface DoclingPort {
  /** Tables with page and box provenance. Throws DoclingLimitError past a limit (DL-8). */
  extract(input: DoclingInput): Promise<DoclingResult>;
}

/** DL-8: the worker refuses a document past 50 pages or 90 seconds; either fails the job. */
export class DoclingLimitError extends Error {
  constructor(readonly reason: "too_many_pages" | "timeout") {
    super(reason);
    this.name = "DoclingLimitError";
  }
}

/**
 * DL-3, DL-16: where uploaded PDFs live, at the server-built path `t/<tenantId>/intake/<jobId>/<sha256>.pdf`.
 * A tenant never names the path. Deletion happens 30 days after the job ends; a failed insert deletes at once.
 */
export interface IntakeFileStore {
  put(path: string, bytes: Uint8Array): Promise<void>;
  read(path: string): Promise<Uint8Array | null>;
  delete(path: string): Promise<void>;
}

export const intakeFilePath = (tenantId: string, jobId: string, fileSha256: string): string =>
  `t/${tenantId}/intake/${jobId}/${fileSha256}.pdf`;

/** In-memory store for tests and demos. */
export class InMemoryIntakeFileStore implements IntakeFileStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly deleted: string[] = [];
  async put(path: string, bytes: Uint8Array): Promise<void> {
    this.objects.set(path, new Uint8Array(bytes));
  }
  async read(path: string): Promise<Uint8Array | null> {
    const found = this.objects.get(path);
    return found ? new Uint8Array(found) : null;
  }
  async delete(path: string): Promise<void> {
    this.deleted.push(path);
    this.objects.delete(path);
  }
}
