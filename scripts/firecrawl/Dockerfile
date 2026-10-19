# Dedicated browser/proxy build context: scripts/firecrawl, never the app root.
FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS dependencies
WORKDIR /opt/scraper
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund
COPY public-egress-proxy.mjs browser-service.mjs ./

FROM dependencies AS proxy
USER node
ENV NODE_ENV=production SCRAPER_PROXY_HOST=0.0.0.0
EXPOSE 8899
CMD ["node", "public-egress-proxy.mjs"]

FROM dependencies AS browser
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN ./node_modules/.bin/playwright install --with-deps chromium --only-shell \
    && chmod -R a+rX /opt/playwright
USER node
ENV NODE_ENV=production SCRAPER_BROWSER_HOST=0.0.0.0
EXPOSE 3003
CMD ["node", "browser-service.mjs"]
