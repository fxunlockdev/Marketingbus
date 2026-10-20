import { describe, expect, it } from "vitest";
import { selectAutofillSources } from "../src/lib/onboarding/autofill-sources";
const website = "https://example.test/", social = "https://www.instagram.com/example";
const source = (id: string, sourceUrl = "", status = "PROPOSED") => ({ id, sourceUrl, status });
describe("setup evidence selection", () => {
  it.each(["QUEUED", "FETCHING"])("waits for a %s website before spending on an already uploaded document", status => {
    expect(selectAutofillSources([source("web", website, status), source("book")], website, []))
      .toEqual({ status: "WAITING", sourceIds: [] });
  });
  it("includes one website, book and saved public profile within the three-source allowance", () => {
    expect(selectAutofillSources([source("book"), source("book2"), source("web", website), source("social", social)], website, [social]))
      .toEqual({ status: "READY", sourceIds: ["web", "book", "social"] });
  });
  it("does not include a foreign or no-longer-selected profile URL", () => {
    expect(selectAutofillSources([source("other", "https://www.instagram.com/other"), source("web", website)], website, [social]))
      .toEqual({ status: "READY", sourceIds: ["web"] });
  });
  it("uses available public profile evidence after website failure without inventing missing facts", () => {
    expect(selectAutofillSources([source("web", website, "FAILED"), source("social", social)], website, [social]))
      .toEqual({ status: "READY", sourceIds: ["social"] });
  });
  it("does not substitute an old successful website or profile after a newer failure", () => {
    expect(selectAutofillSources([source("new", website, "FAILED"), source("new-social", social, "FAILED"), source("old", website), source("old-social", social)], website, [social]))
      .toEqual({ status: "IMPORT_REQUIRED", sourceIds: [] });
  });
  it("does not block valid website evidence on an optional inaccessible profile", () => {
    expect(selectAutofillSources([source("web", website), source("social", social, "FETCHING")], website, [social]))
      .toEqual({ status: "READY", sourceIds: ["web"] });
  });
  it("waits for the only available pending profile, and excludes failed documents", () => {
    expect(selectAutofillSources([source("book", "", "FAILED"), source("social", social, "QUEUED")], website, [social]))
      .toEqual({ status: "WAITING", sourceIds: [] });
  });
  it("deduplicates repeated profile URLs and never exceeds three sources", () => {
    expect(selectAutofillSources([source("web", website), source("social", social), ...Array.from({ length: 4 }, (_, i) => source(`book${i}`))], website, [social, social, website]).sourceIds)
      .toEqual(["web", "book0", "social"]);
  });
});
