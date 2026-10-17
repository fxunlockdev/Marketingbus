import { parseArgs } from "node:util";
import { db } from "../src/lib/db";
import { readQueueReport } from "./operations/queue-report";

async function main() {
  const { values } = parseArgs({ options: { all: { type: "boolean" }, organization: { type: "string" }, business: { type: "string" }, limit: { type: "string" }, "overdue-minutes": { type: "string" }, cursor: { type: "string" }, check: { type: "boolean" } } });
  if ((!values.all && !values.organization) || (values.all && (values.organization || values.business)))
    throw Error("Choose --all or --organization ID [--business ID].");
  if (values.check && values.cursor) throw Error("Monitoring checks must start on the first page.");
  const report = await readQueueReport(db, {
    scope: values.all ? { kind: "all" } : { kind: "organization", organizationId: values.organization!, ...(values.business ? { businessId: values.business } : {}) },
    ...(values.limit ? { limit: Number(values.limit) } : {}), ...(values["overdue-minutes"] ? { overdueMinutes: Number(values["overdue-minutes"]) } : {}),
    ...(values.cursor ? { cursor: values.cursor } : {}),
  });
  console.info(JSON.stringify(report, null, 2));
  if (values.check && report.items.length) process.exitCode = 2;
}
void main().catch(() => {
  // Database errors can contain URLs, bind values or server details. Never print raw exceptions.
  console.error("Queue report failed. Check explicit scope, cursor, database access and schema. No recovery action was taken.");
  process.exitCode = 1;
}).finally(() => db.$disconnect());
