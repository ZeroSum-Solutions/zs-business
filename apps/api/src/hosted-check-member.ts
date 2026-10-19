// check:hosted's temporary tenant_members row: a staff member binding its tenant-A test user,
// so that user signs in like a real member. Added and removed as service_role.
import type { Pool } from "pg";
import { asService } from "@zs/db";
import { redactSecrets } from "./hosted.js";

export interface TemporaryMemberRemoval {
  readonly ok: boolean;
  readonly detail: { readonly memberId: string; readonly deleted: boolean; readonly absent: boolean | "unreadable"; readonly error: string | null };
}

/**
 * The member's id is fixed when this is made, and the member counts as added from the moment
 * the insert is sent: if the COMMIT's reply is lost, the insert throws but the row may exist,
 * so cleanup must still look for it. `remove` deletes the row and then reads back that it is
 * gone; `ok` only when no row remains, also when the insert never landed. Before any `add` it
 * returns null: there is nothing to clean up.
 */
export function temporaryMember(service: Pool, tenantId: string, generateId: () => string) {
  const memberId = generateId();
  let sent = false;
  const describe = (error: unknown) => redactSecrets(error instanceof Error ? error.message : String(error));
  return {
    memberId,
    async add(user: { readonly email: string; readonly userId: string }): Promise<void> {
      sent = true;
      await asService(service, (tx) => tx.query(
        "INSERT INTO tenant_members (tenant_id,id,email,user_id,role,created_at,updated_at) VALUES ($1,$2,$3,$4,'staff',now(),now())",
        [tenantId, memberId, user.email, user.userId]));
    },
    async remove(): Promise<TemporaryMemberRemoval | null> {
      if (!sent) return null;
      let deleted = false;
      let error: string | null = null;
      try {
        deleted = await asService(service, async (tx) =>
          (await tx.query("DELETE FROM tenant_members WHERE tenant_id=$1 AND id=$2", [tenantId, memberId])).rowCount === 1);
      } catch (caught) {
        error = describe(caught);
      }
      let absent: boolean | "unreadable";
      try {
        absent = await asService(service, async (tx) =>
          (await tx.query("SELECT 1 FROM tenant_members WHERE tenant_id=$1 AND id=$2", [tenantId, memberId])).rowCount === 0);
      } catch (caught) {
        absent = "unreadable";
        error ??= describe(caught);
      }
      return { ok: absent === true, detail: { memberId, deleted, absent, error } };
    },
  };
}
