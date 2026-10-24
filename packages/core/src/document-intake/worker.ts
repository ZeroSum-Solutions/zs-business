// The worker loop (docs/requirements/document-intake.md DL-5, DL-8, DL-9): claim a job, fetch the
// PDF, run the Docling port under a time limit, post the tables or the failure. The real service
// runs the same loop in Python; the session's `worker` object and an HTTP client both fit the API.
import type { ClaimedIntakeJob, IntakeWorkerOutcome } from "@zs/contracts";
import { ActionError, INTAKE_MAX_PAGES } from "@zs/contracts";
import { DoclingLimitError, type DoclingPort } from "./port.js";

/** DL-8: the worker's own limit per document. */
export const INTAKE_PARSE_TIMEOUT_MS = 90_000;

export interface IntakeWorkerApi {
  claim(): Promise<ClaimedIntakeJob | null>;
  file(jobId: string, leaseToken: string): Promise<Uint8Array>;
  result(jobId: string, leaseToken: string, body: unknown): Promise<IntakeWorkerOutcome>;
  fail(jobId: string, leaseToken: string, body: { reason: "too_many_pages" | "timeout" | "invalid_result" | "worker_error" }): Promise<IntakeWorkerOutcome>;
}

export interface IntakeWorkerRun {
  readonly job: ClaimedIntakeJob;
  /** What the server said the job became, or null when the lease was lost or the result was refused. */
  readonly outcome: IntakeWorkerOutcome | null;
}

class ParseTimeout extends Error {}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new ParseTimeout()), ms); });
  return Promise.race([work, limit]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

/** Claim one job and finish it. Null when nothing is due. */
export async function runDocumentIntakeWorker(options: {
  readonly api: IntakeWorkerApi;
  readonly port: DoclingPort;
  readonly timeoutMs?: number;
}): Promise<IntakeWorkerRun | null> {
  const { api, port } = options;
  const job = await api.claim();
  if (!job) return null;
  const fail = async (reason: "too_many_pages" | "timeout" | "worker_error"): Promise<IntakeWorkerRun> => {
    try {
      return { job, outcome: await api.fail(job.id, job.leaseToken, { reason }) };
    } catch (error) {
      if (error instanceof ActionError) return { job, outcome: null };
      throw error;
    }
  };
  let tables;
  try {
    const bytes = await api.file(job.id, job.leaseToken);
    tables = await withTimeout(
      port.extract({ tenantId: job.tenantId, jobId: job.id, fileSha256: job.fileSha256, bytes, maxPages: Math.min(job.maxPages, INTAKE_MAX_PAGES) }),
      options.timeoutMs ?? INTAKE_PARSE_TIMEOUT_MS,
    );
  } catch (error) {
    if (error instanceof ParseTimeout) return fail("timeout");
    if (error instanceof DoclingLimitError) return fail(error.reason);
    // A lost lease or a missing file is the server's answer: another claim owns the job now.
    if (error instanceof ActionError) return { job, outcome: null };
    return fail("worker_error");
  }
  try {
    return { job, outcome: await api.result(job.id, job.leaseToken, tables) };
  } catch (error) {
    // The server refused the result (invalid_result already failed the job) or the lease moved on.
    if (error instanceof ActionError) return { job, outcome: null };
    return fail("worker_error");
  }
}
