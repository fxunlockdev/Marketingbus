import { parseArgs } from "node:util";
import { db } from "../src/lib/db";
import { readCreditReport } from "./operations/credit-report";

async function main() {
  const { values } = parseArgs({ options: { organization: { type: "string" }, check: { type: "boolean" } } });
  if (!values.organization) throw Error("Choose --organization ID.");
  const report = await readCreditReport(db, values.organization);
  console.info(JSON.stringify(report, null, 2));
  if (values.check && report.needsAttention) process.exitCode = 2;
}
void main().catch(() => {
  console.error("Credit report failed. Check explicit workspace, database access and schema. No accounting change was made.");
  process.exitCode = 1;
}).finally(() => db.$disconnect());
