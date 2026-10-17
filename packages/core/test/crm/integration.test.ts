import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createOrFindContactCommandSchema } from "@zs/contracts";
import { createTwoTenantFixture, withTestDatabase } from "@zs/db/testing";
import { createDispatcher, createOrFindContact, crmHandlers, type DispatchContext } from "../../src/index.js";

it("C-23/C-24: creates a contact through the registered handler and runtime database", async () => {
  await withTestDatabase(async (database) => {
    const fixture = await createTwoTenantFixture(database);
    const tenantId = fixture.a.tenantId;
    const contactId = randomUUID();
    const pipelineId = randomUUID();
    const command = createOrFindContactCommandSchema.parse({
      actionType: "crm.contact.create-or-find",
      target: { tenantId, type: "contact", id: contactId },
      payload: {
        contactId, displayName: "Example Person", email: "person@example.test", phone: null,
        mode: "interactive", consent: { email: null, sms: null },
      },
      approvalReference: { tenantId, id: randomUUID() },
      idempotencyKey: randomUUID(),
    });
    const dispatch = createDispatcher(crmHandlers);
    const ctx: DispatchContext = {
      tenantId, actor: { tenantId, id: randomUUID() }, db: database.db,
      clock: { now: () => new Date("2026-10-19T08:00:00.000Z") },
      config: {}, generateId: randomUUID,
      resolveApproval: async () => ({
        tenantId, actorId: ctx.actor.id, actionType: command.actionType,
        target: command.target, payload: command.payload, approvalReference: command.approvalReference,
      }),
    };
    const actual = await createOrFindContact(command, {
      dispatch: async (parsed) => {
        // Defer setup until the wrapper dispatches: this scaffold has no feature tables yet.
        await fixture.service(async (tx) => {
          await tx.query("INSERT INTO crm_pipelines (tenant_id,id,name) VALUES ($1,$2,$3)",
            [tenantId, pipelineId, "Example pipeline"]);
          await tx.query(
            `INSERT INTO crm_stages (tenant_id,id,pipeline_id,name,position)
             VALUES ($1,$2,$3,$4,0),($1,$5,$3,$6,1)`,
            [tenantId, randomUUID(), pipelineId, "New", randomUUID(), "Won"],
          );
        });
        return dispatch(ctx, parsed);
      },
    });
    expect(actual.result).toMatchObject({ created: true, contact: { id: contactId, tenantId, email: "person@example.test" } });
    const stored = await fixture.service((tx) => tx.query(
      "SELECT id,normalized_email FROM crm_contacts WHERE tenant_id=$1 AND id=$2", [tenantId, contactId],
    ));
    expect(stored.rows).toEqual([{ id: contactId, normalized_email: "person@example.test" }]);
  });
});
