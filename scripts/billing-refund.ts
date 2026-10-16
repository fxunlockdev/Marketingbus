import { parseArgs } from "node:util";
import { requestBillingRefund, lookupBillingRefund } from "../src/lib/billing/refunds";
import { db } from "../src/lib/db";
const { values } = parseArgs({ options: { id: { type: "string" }, payment: { type: "string" }, workspace: { type: "string" }, "amount-minor": { type: "string" }, operator: { type: "string" }, evidence: { type: "string" }, confirm: { type: "boolean" }, lookup: { type: "boolean" } } });
void (values.lookup ? lookupBillingRefund(values.id || "") : requestBillingRefund({ id: values.id, paymentId: values.payment, organizationId: values.workspace, amountMinor: Number(values["amount-minor"]), operatorId: values.operator, evidence: values.evidence, confirm: values.confirm }))
  .then(result => console.info(result))
  .catch(error => { console.error(error instanceof Error ? error.message : "Refund operation failed"); process.exitCode = 1; })
  .finally(() => db.$disconnect());
