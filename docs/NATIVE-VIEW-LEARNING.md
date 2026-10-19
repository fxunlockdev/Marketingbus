# Instagram observations → reviewed planning experiments

## Implemented boundary

Instagram feed-image and Reel observations can now propose a reversible format experiment through the existing Publishing & analytics flow. They retain native `views` and `total_interactions`, each cohort's own definition version, exact publication/snapshot IDs and observation timestamps. Views are never copied into impressions. Facebook reactions remain excluded because they are not total interactions.

The policy requires the same business, current brand, connected account and API version; five independent posts and 1,000 views per format; observations aged 72–96 hours; publications within 45 days; similar cohort publication/observation timing; and no single post contributing over 40% of its cohort's views. At most 20 posts per cohort are retained. The difference threshold is only a proposal heuristic, not a statistical significance test.

Feed displays and Reel plays are **not equivalent exposures**. Repeat exposure, topics, audiences, timing and paid distribution can explain an apparent difference. The product explicitly labels the result as a format-test hypothesis, not a proven preference, causal improvement, conversion rate or completed-playback metric.

## Recall and customer control

- Evaluation does not activate the hypothesis or authorize production/publication.
- An authorized human reviews and promotes it using the existing seven-day evidence-validity window.
- The business knowledge graph includes the revalidated experiment and its evidence link in planning context only. Copy, image and video directions do not receive the hypothesis as a fact.
- Each recall rechecks retained metrics, immutable publication payload, definition, connection, current brand and evidence fingerprint. Changed/deleted/invalidated data or disconnection stops recall; the historical review remains recorded.
- Explicit reversal removes the active memory. Existing 30-day recall expiry remains.
- No schema migration, additional model call, separate graph server or recurring infrastructure service is introduced.

## Verification and outstanding gates

Local synthetic acceptance covers deterministic selection, zero/null handling, invalid counts, mismatched accounts/versions/formats, independent samples, timing, bounds, human promotion/reversal, tenant isolation, planning-only recall and evidence invalidation. Two real-browser journeys exercise LinkedIn and Instagram review, promotion, reversal, changed-metric rejection, viewer denial, mobile layout and automated accessibility. The browser fixture uses isolated local storage; no live social account or paid provider is called.

This is not live Instagram acceptance or proof that the suggested experiment improves results. Provider approvals, actual account consent, sufficient real matched-age observations, calibrated outcome evaluation and broader semantic/visual learning remain separate work. It does not automatically change content frequency, post without approval or train a foundation model.
