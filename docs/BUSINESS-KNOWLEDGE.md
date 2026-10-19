# Business knowledge graph — no Graphiti

The application projects a bounded, typed graph from existing PostgreSQL records. There is no graph database, Graphiti dependency, background embedding bill or extra service. Source records remain authoritative; exact task snapshots are persisted with generation requests so the result can be traced to the knowledge used.

Connections: confirmed business → versioned facts; business → explicit preferences; business → activated skills → revalidated correction evidence; business → approved experiments → observational evidence; image/video task → selected asset IDs and byte hashes. A relation is included only because an existing scoped record establishes it, never because an LLM guessed it. Facts are hash-bound to the full approved brief, not truncated into new factual claims.

## Active workflow

1. A customer's explicit saved preference is available to copy, image and video tasks. Corrected-and-approved examples can propose the three supported learned copy rules; a customer must activate each rule.
2. Task/channel filtering recalls only applicable knowledge. Copy rules do not leak into image/video directions. Observational experiments remain planning hypotheses, not brand facts or proof of causation.
3. New copy/image/footage requests retain the exact graph snapshot and relevant prompt guidance. Weekly plan briefs also retain their planning snapshot. The fixed weekly cadence and spending consent are not silently changed by an experiment.
4. Accepting a quote, submitting work and delivering new output recheck relevant knowledge. Changed/deleted preferences or invalid learning evidence stop stale work. A provider charge already incurred remains accounted for; it is never retried automatically. Completed media remains available for explicit review rather than being retroactively deleted when preferences change.
5. A retired/expired lesson disappears from future retrieval. Existing historical request snapshots remain audit records under their original retention policy; removing a preference is not a promise to erase every historical request record.

The projection is bounded: 100 candidate memories, at most 30 applicable preferences/lessons and 6,000 guidance characters, up to ten selected assets, fixed typed edges. Excess applicable context fails closed with consolidation guidance rather than silently dropping requirements. Raw website/document text, secrets, unrelated clients and unapproved feedback never become graph instructions. Existing media permissions, factual checks, credit reservations and approval gates retain authority.

Authenticated read-only endpoint: `/api/businesses/:id/knowledge-graph?task=copy&channel=LinkedIn`. Tasks: `copy`, `image`, `video`, `planning`. Only configured channels and accessible businesses are allowed; responses are not cached. This is an inspection API, not an endpoint for arbitrary graph writes or model training.

## Boundaries

This is a working graph-backed context and provenance layer, not autonomous semantic learning or model fine-tuning. General feedback-to-skill distillation, contradiction resolution, learned visual procedures, controlled quality experiments and automatic promotion/rollback based on measured outcomes still need implementation/evaluation. Prompt inclusion is not evidence of improved creative quality. No “top 1% agency” guarantee is claimed. Graphiti is explicitly excluded from the requested architecture.
