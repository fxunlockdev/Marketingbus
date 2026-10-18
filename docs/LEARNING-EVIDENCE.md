# Learning evidence and production memory

Marketingbus proposes reversible experiments from observed performance. It does not train model weights, claim a causal result or automatically publish an experiment. A human decision is required, and the resulting preference is used only while its evidence remains eligible.

## Comparable observations

The current policy compares static and video formats within one business, current confirmed brand, social account, provider and metric definition. Each post must have a published receipt and an intact frozen payload. Its account must remain connected.

Detected upstream content/distribution drift permanently excludes that publication's observations through `metricsInvalidatedAt`. LinkedIn learning requires the source-bound v2 reading definition; older v1 snapshots remain audit history only. Exclusion also applies when revalidating already-promoted memory. Restoring account access or resuming a stopped metric poll does not re-approve an invalidated creative.

- Use one earliest metric snapshot per post taken 72–96 hours after publication, not its latest lifetime total.
- Use posts published within 45 days of evaluation. Each format contributes the latest 5–20 eligible posts and at least 1,000 observed impressions; each post needs at least 100 impressions.
- No post may supply more than 40% of its cohort's impressions. Mean publication dates must be within seven days and mean observation ages within twelve hours.
- The candidate format must exceed the comparison's engagement-per-impression ratio by both 10% relatively and 0.001 absolutely. These are conservative product-policy thresholds, not a significance test or a validated causal-effect estimate.
- Reads stop at 1,001 in-window snapshot rows. More than 1,000 rows or 500 distinct posts fail closed rather than silently treating a truncated sample as complete evidence. Larger-window pagination is a future extension.

The proposal stores exact publication/snapshot IDs, observed counts, times, cohort totals, policy version and an integrity fingerprint. Duplicate posts cannot inflate sample size. Audience, topic, paid distribution and timing can still confound the result; there is no randomized holdout or attribution model in this policy.

## Human decisions

Evaluation, approval, rejection and revert check the current workspace role under the business lock. Only owners, administrators and editors may decide. Approving a proposal re-reads its exact original snapshots and reconstructs the hypothesis and fingerprint. It rejects altered metrics, changed definitions or payloads, missing posts/snapshots, disconnected accounts, old brands, changed hypotheses and proposals older than seven days.

Old `OBSERVATIONAL_V1` or malformed proposals cannot be promoted. A new evaluation may replace an expired pending proposal. Concurrent evaluation reuses a valid pending proposal, and concurrent approval cannot create duplicate experiment memory. At most 20 promoted experiments are allowed. Revert removes only the memory belonging to that experiment, preserving explicit user preferences.

## Production safeguards

Before compiling new copy, the app selects explicit preferences and only those experiment memories that have a matching promoted proposal, exact hypothesis, current brand and still-valid evidence. Experiment influence expires 30 days after evaluation. Historical records remain available; a `PROMOTED` status records the human decision, not a perpetual guarantee of production eligibility.

The effective preference set is fingerprinted into the quote. It is checked again before credit reservation, immediately before the provider call and before delivering its result. A change before submission releases held customer credits without calling the provider. A change during submission withholds the obsolete output, records known supplier expense and releases customer credits. Unknown provider outcomes retain the existing reconciliation safeguards.

Legacy quotes without a preference fingerprint require a fresh quote; already queued legacy work stops safely before submission. Deploy web and worker together at runtime `studio-v15-evidence-memory`. No schema migration or deletion of historical evidence is required.

## Acceptance boundary

Automated tests use synthetic metrics in an explicitly local database and injected reasoning responses. The application has no fake production social adapter. Actual platform ingestion, paid/organic metric mappings, randomized outcome trials, mixed-media autopilot and professional creative-quality acceptance remain separate unfinished work.
