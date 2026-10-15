import { parseArgs } from "node:util";
import { resumePublicationLookup } from "../src/lib/social/recovery";
import { db } from "../src/lib/db";
const { values } = parseArgs({ options: { publication: { type: "string" }, operator: { type: "string" }, evidence: { type: "string" }, "resume-lookups": { type: "boolean", default: false } } });
if (!values["resume-lookups"]) throw Error("Explicit --resume-lookups is required. This operation does not publish a post.");
void resumePublicationLookup({ publicationId: values.publication, operatorId: values.operator, evidence: values.evidence })
  .then(result => console.info(result))
  .catch(error => { console.error(error instanceof Error ? error.message : "Lookup recovery failed"); process.exitCode = 1; })
  .finally(() => db.$disconnect());
