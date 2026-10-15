# Static exports, social orchestration and measured experiments

## Static composition

Design studio builds an editable JSON layer document from a current copy revision and approved assets only. Placement uses the original normalized raster bytes, checked against their stored SHA-256. It does not ask an image model to redraw logos or products. Layout versions are immutable; editing supersedes the preceding version. Copy approval and visual approval are separate. Brand/version changes or asset revocation block future export. Stale edits fail rather than overwrite another editor's work.

Saved draft previews are permitted before approval. Final PNG/SVG/JSON exports require approved current copy, approved current composition, current confirmed brand and still-approved assets. Every render rechecks permissions after asynchronous storage work. PNG is rasterized by Sharp; SVG escapes text and embeds trusted raster bytes only, with no remote URLs or scripts. Text fitting is conservative approximate wrapping, not professional font measurement; overflow refuses export. Sizes: 1080×1080, 1080×1350, 1080×1920 and 1200×628. These are canvas presets, not a guarantee of every platform's current media rules. Downloads cannot be recalled after revocation.

Exports currently stream to the authenticated user rather than create immutable media assets for social publishing. Gemini generation and social media transfer remain unimplemented. No provider call or credit is consumed by deterministic composition.

## Social safety boundary

`configuredSocialAdapters()` intentionally returns no adapters. Adding keys or setting `SOCIAL_EXECUTION_ENABLED=true` does not activate fake publishing. Actual adapters and OAuth must be implemented and tested before the gate is enabled. Account records are only created through the internal verified-connection contract; there is no public arbitrary-token ingestion endpoint.

Scheduling binds an exact approved current revision, frozen payload/hash, account and timezone. The initial text contract accepts Facebook/LinkedIn copy only; Instagram and media-dependent formats fail closed until immutable media export delivery exists. At execution, the worker rechecks brand, approval, payload, account and permissions before marking SUBMITTING. Safe retries require the adapter to establish that no publication occurred, with a maximum of three attempts. Timeouts, process death and malformed receipts become NEEDS_RECONCILIATION, never blind retries. The reconciliation contract is lookup-only and does not create posts. Unknown outcomes remain on hold; an operator UI/automatic lookup loop is still pending.

New copy versions, rejection, unscheduling and brand changes invalidate queued publication. Edits/disconnect are blocked during uncertain or in-flight submission so they cannot imply cancellation of a remote write already made. Disconnection otherwise cancels queued work and erases the local token. Platform-level token revocation requires its future adapter.

## Metrics and learning

Snapshots preserve unsupported metrics as null, not zero, and are deduplicated by publication/observation/definition. Dashboard totals use only the latest lifetime reading for each of at most 500 recent published posts, separately grouped by account and metric definition. They are not date-range increments. Coverage/staleness is visible; summed reach is not unique people and engagement is not conversions. Metric sync is leased, bounded, age-aware and stops after repeated failures or thirty days; actual platform mapping remains unimplemented.

An experiment proposal requires two formats on one account/definition, at least five mature posts per format and 1,000 impressions each. A relative/absolute observed engagement-rate difference only produces a hypothesis. Nonrandomized audience/topic/timing differences may explain it; it is not statistically validated causal learning. Promotion requires explicit human confirmation for the current brand, creates one scoped experiment memory and invalidates offered generation quotes. Reverting removes exactly that memory. It does not train model weights, rewrite skills or initiate publication/spending. Recurring planning and bounded autopilot remain unimplemented.
