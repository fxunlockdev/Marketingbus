import { parseArgs } from "node:util";
import { reconcileBrandAnalysis } from "../src/lib/knowledge/reconcile";
import { db } from "../src/lib/db";
const { values } = parseArgs({ options: { analysis: { type: "string" }, "supplier-cost-micros": { type: "string" }, evidence: { type: "string" }, operator: { type: "string" } } });
void reconcileBrandAnalysis({ analysisId: values.analysis, supplierCostMicros: Number(values["supplier-cost-micros"]), evidence: values.evidence, operatorId: values.operator })
  .then(result => console.info(result))
  .catch(error => { console.error(error instanceof Error ? error.message : "Reconciliation failed"); process.exitCode = 1; })
  .finally(() => db.$disconnect());
