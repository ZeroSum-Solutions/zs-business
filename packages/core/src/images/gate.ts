// image-port.md IM-14: a release publishes only images that are media assets of the tenant.
// Staged and unapproved variants are not assets, so their bytes cannot reach a site.
import { Conflict } from "@zs/contracts";
import type { Transaction } from "@zs/db";

export async function assertImagesApproved(
  tx: Transaction, tenantId: string, files: readonly { readonly mediaType: string; readonly sha256: string }[],
): Promise<void> {
  const wanted = [...new Set(files.filter((file) => file.mediaType.toLowerCase().startsWith("image/")).map((file) => file.sha256))];
  if (wanted.length === 0) return;
  const known = new Set((await tx.query<{ sha256: string }>(
    "SELECT sha256 FROM media_assets WHERE tenant_id=$1 AND sha256 = ANY($2::text[])", [tenantId, wanted])).rows.map((row) => row.sha256));
  if (wanted.some((sha) => !known.has(sha))) throw new Conflict("A release holds an image that is not approved", { reason: "image_not_approved" });
}
