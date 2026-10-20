import { parseArgs } from "node:util";
import { db } from "../src/lib/db";
import { readSupplierReport } from "./operations/supplier-report";

async function main() {
  const { values } = parseArgs({ options: { all: { type: "boolean" }, check: { type: "boolean" } } });
  if (values.all !== true) throw Error("Choose --all explicitly.");
  const report = await readSupplierReport(db, { all: true });
  console.info(JSON.stringify(report, null, 2));
  if (values.check && report.needsAttention) process.exitCode = 2;
}
void main().catch(() => {
  console.error("Supplier exposure report failed. Check explicit global scope, database access and schema. No budget or accounting change was made.");
  process.exitCode = 1;
}).finally(() => db.$disconnect());
