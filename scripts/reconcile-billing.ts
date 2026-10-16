import { parseArgs } from "node:util";
import { reconcileBillingEvent } from "../src/lib/billing/reconcile";
import { db } from "../src/lib/db";
const { values } = parseArgs({ options: { id: { type: "string" }, event: { type: "string" }, operator: { type: "string" }, evidence: { type: "string" }, confirm: { type: "boolean" } } });
void reconcileBillingEvent({ id: values.id, eventId: values.event, operatorId: values.operator, evidence: values.evidence, confirm: values.confirm })
  .then(result => console.info(result))
  .catch(error => { console.error(error instanceof Error ? error.message : "Payment reconciliation failed"); process.exitCode = 1; })
  .finally(() => db.$disconnect());
