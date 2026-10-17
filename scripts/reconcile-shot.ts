import { parseArgs } from "node:util";
import { reconcileShotGeneration } from "../src/lib/video/generation-reconcile";
import { db } from "../src/lib/db";
const { values } = parseArgs({ options: { shot: { type: "string" }, "supplier-cost-micros": { type: "string" }, evidence: { type: "string" }, operator: { type: "string" } } });
void reconcileShotGeneration({ generationId: values.shot, supplierCostMicros: Number(values["supplier-cost-micros"]), evidence: values.evidence, operatorId: values.operator })
  .then(result => console.info(result))
  .catch(error => { console.error(error instanceof Error ? error.message : "Reconciliation failed"); process.exitCode = 1; })
  .finally(() => db.$disconnect());
