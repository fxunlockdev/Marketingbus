import { parseArgs } from "node:util";
import { reconcileFailedJob } from "../src/lib/production/reconcile";
import { db } from "../src/lib/db";
async function main() {
  const { values } = parseArgs({ options: { job: { type: "string" }, "supplier-cost-micros": { type: "string" }, evidence: { type: "string" }, operator: { type: "string" }, confirm: { type: "boolean", default: false } } });
  if (!values.confirm || !values["supplier-cost-micros"]) throw Error("Explicit confirmation and verified supplier cost are required.");
  const result = await reconcileFailedJob({ jobId: values.job, supplierCostMicros: Number(values["supplier-cost-micros"]), evidence: values.evidence, operatorId: values.operator });
  console.info(JSON.stringify(result));
}
void main().catch(error => { console.error(error instanceof Error && error.name === "Error" ? error.message : "Reconciliation failed. Verify job state and inputs; no automatic retry performed."); process.exitCode = 1; }).finally(() => db.$disconnect());
