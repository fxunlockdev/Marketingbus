import { parseArgs } from "node:util";
import { db } from "../src/lib/db";
import { stopUnsubmittedImage } from "../src/lib/social/prepost-recovery";

async function main() {
  const { values } = parseArgs({ options: {
    organization: { type: "string" }, business: { type: "string" }, publication: { type: "string" },
    operator: { type: "string" }, apply: { type: "boolean" }, "expected-state-hash": { type: "string" }, evidence: { type: "string" },
  } });
  const result = await stopUnsubmittedImage({ organizationId: values.organization, businessId: values.business,
    publicationId: values.publication, operatorId: values.operator, apply: values.apply ?? false,
    expectedStateHash: values["expected-state-hash"], evidence: values.evidence,
  });
  console.info(JSON.stringify(result, null, 2));
}
void main().catch(() => {
  // Never print raw DB errors, credentials, payloads or provider identifiers.
  console.error("Recovery refused or unavailable. Verify exact scope, inactive state, unchanged preview and absence of a post-submission fence. Do not retry publishing or clear the journal manually.");
  process.exitCode = 1;
}).finally(() => db.$disconnect());
