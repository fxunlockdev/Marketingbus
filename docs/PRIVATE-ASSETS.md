# Private brand assets — pilot implementation

Brand page uploads genuine PNG, JPEG and WebP images only. The server authenticates business membership, requires edit permission and same-origin writes, checks rights confirmation, rate-limits uploads, counts streamed bytes, checks file signatures and decodes with a 16-megapixel limit. Animated files, SVG, HTML, PDFs and arbitrary documents are not supported.

Images are orientation-corrected, converted losslessly to WebP and stripped of embedded metadata. Both input and output are capped at 5 MB. Transparency is retained. The pilot allowance is 25 MB or 100 images per business; pending and failed uploads consume quota to prevent ambiguous storage writes from bypassing it. Same-business READY-image hashes deduplicate uploads by purpose; there is no cross-tenant deduplication or shared media cache.

PostgreSQL records owner/business, label, purpose, digest, dimensions, rights attestation and state. A transaction locks the business before reserving quota. S3 upload happens outside the database transaction. Only confirmed READY records can be served. Timeout/uncertain writes become FAILED and require operator reconciliation; they are not exposed or silently retried. Asset foreign keys restrict business deletion until objects are explicitly handled, preventing silent metadata deletion that strands private blobs.

Objects are private in marketingbus-assets, with random keys under organization/business prefixes. Browser requests go through an authenticated same-origin endpoint; raw object keys and storage credentials are never returned in the asset list. Downloads are no-store, nosniff image/webp responses. This server-proxy approach supports immediate access revocation but incurs service bandwidth; a later short-lived signed-link optimization must preserve authorization and bound expiry.

## Configuration

Set web-service variables to Railway bucket references:

- ASSET_S3_ENDPOINT → marketingbus-assets.ENDPOINT
- ASSET_S3_BUCKET → marketingbus-assets.BUCKET
- ASSET_S3_REGION → marketingbus-assets.REGION
- ASSET_S3_ACCESS_KEY_ID → marketingbus-assets.ACCESS_KEY_ID
- ASSET_S3_SECRET_ACCESS_KEY → marketingbus-assets.SECRET_ACCESS_KEY

Use Railway's reference syntax in its private variables panel. Never NEXT_PUBLIC, source control or browser forms. New buckets use virtual-hosted URL style. The worker now needs the same private storage references for retention deletion, independent of paid copy execution.

## Approval and retention

Uploads are initially unapproved for generation. An editor can explicitly approve/revoke use. Approval does not make a provider call, and asset-aware image generation is not implemented yet. Removal immediately makes the asset unavailable through the app, revokes permission and supersedes offered quotes. There is a seven-day restore window; restoration never automatically re-approves use. After that window, the worker leases the object, requests idempotent storage deletion, and only releases quota after confirmed deletion. Ambiguous deletion remains private and retries after its lease expires. Previously downloaded/provider-held copies and backups are not recalled. Failed uploads cannot be restored as verified images.

## Verification and limits

`npx tsx scripts/check-asset-storage.ts` creates one synthetic random operator-probe object, verifies exact read-back and deletes it. It never uses customer keys or data. The browser asset suite additionally requires RUN_ASSET_STORAGE_E2E=true, explicit localhost test database variables and configured private storage; it cleans only objects belonging to its synthetic local test organization.

The 15 October deterministic composition workflow selects only approved original assets and exports reviewed PNG/SVG/JSON files; see [composition operations](SOCIAL-AND-COMPOSITION.md). Remaining before public launch: generated-media exports and persistent delivery to social platforms, failed-upload reconciliation UI, upload concurrency/resource load tests, storage backup/export rehearsal, document/media quarantine pipeline, and versioned asset selection inside model generation briefs. Uploading an image does not yet send it to an AI model, approve a claim, or modify confirmed brand facts.

Storage is not a malware-scanning certification. Decode/re-encode and a small allowlist reduce exposure, but do not justify an enterprise-security claim.
