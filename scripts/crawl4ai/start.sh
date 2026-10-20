#!/usr/bin/env bash
set -euo pipefail
# Refuse accidental public/unauthenticated or unsandboxed operation.
: "${CRAWL4AI_API_TOKEN:?A dedicated scraper token is required}"
test "${CRAWL4AI_CHROMIUM_SANDBOX}" = true
test "${CRAWL4AI_ALLOW_INTERNAL_URLS}" = false
test "${CRAWL4AI_ALLOW_INSECURE_TLS}" = false
test "${CRAWL4AI_HOOKS_ENABLED}" = false
test "${CRAWL4AI_EXECUTE_JS_ENABLED}" = false
test "${CRAWL4AI_ALLOW_DEEP_CRAWL}" = false
ulimit -c 0
exec bash /app/entrypoint.sh
