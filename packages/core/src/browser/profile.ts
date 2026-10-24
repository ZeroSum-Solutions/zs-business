// BT-6: each (tenant, target) has its own browser profile, built only from the server-derived tenant
// and a target UUID. A value that is not a UUID never reaches the path.
import { isAbsolute, join } from "node:path";
import { uuidSchema, ValidationFailed } from "@zs/contracts";

export function profilePath(browserRoot: string, tenantId: string, targetId: string): string {
  if (!isAbsolute(browserRoot)) throw new ValidationFailed("BROWSER_ROOT must be an absolute path");
  const tenant = uuidSchema.safeParse(tenantId);
  const target = uuidSchema.safeParse(targetId);
  if (!tenant.success || !target.success) throw new ValidationFailed("A profile path needs a tenant UUID and a target UUID");
  return join(browserRoot, tenant.data.toLowerCase(), target.data.toLowerCase(), "profile");
}

/** BT-6: where a run's files go in object storage. */
export function artifactKey(tenantId: string, runId: string, artifactId: string, extension: "pdf" | "png"): string {
  return `tenants/${tenantId}/browser-runs/${runId}/${artifactId}.${extension}`;
}
