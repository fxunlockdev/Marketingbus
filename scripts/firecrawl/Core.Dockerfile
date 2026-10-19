FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS source
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git
WORKDIR /source
RUN curl -fsSL https://codeload.github.com/firecrawl/firecrawl/tar.gz/ef12eb36b2f3382838dfe0a0c1a5add3d5df7fe5 -o upstream.tar.gz \
    && echo 'b7c6df0b8b692397c8a19e84f94b85ce0a2d961b36fc1d5ff78088db88819f59  upstream.tar.gz' | sha256sum -c - \
    && tar -xzf upstream.tar.gz --strip-components=1
COPY standalone-browser.patch /source/marketingbus.patch
RUN git apply --check marketingbus.patch && git apply marketingbus.patch
COPY core-Cargo.lock /source/apps/api/native/Cargo.lock

FROM golang:1.24@sha256:d2d2bc1c84f7e60d7d2438a3836ae7d0c847f4888464e7ec9ba3a1339a1ee804 AS go-build
WORKDIR /go-build
COPY --from=source /source/apps/api/sharedLibs/go-html-to-md ./
RUN go mod download && go build -mod=readonly -o libhtml-to-markdown.so -buildmode=c-shared html-to-markdown.go

FROM source AS build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential pkg-config python3
ENV RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo PATH=/usr/local/cargo/bin:$PATH CI=true HUSKY=0
RUN curl --proto '=https' --tlsv1.2 -fsSL https://sh.rustup.rs -o /tmp/rustup-init.sh \
    && sh /tmp/rustup-init.sh -y --profile minimal --default-toolchain 1.99.1 --no-modify-path
RUN corepack enable && corepack prepare pnpm@10.16.1 --activate
RUN ARCH=$(dpkg --print-architecture) && case "$ARCH" in arm64) FDB_ARCH=aarch64 ;; amd64) FDB_ARCH=amd64 ;; *) exit 1 ;; esac \
    && curl -fsSL "https://github.com/apple/foundationdb/releases/download/7.3.63/foundationdb-clients_7.3.63-1_${FDB_ARCH}.deb" -o /tmp/fdb.deb \
    && dpkg -i /tmp/fdb.deb
WORKDIR /source/apps/api
# Reject native dependency drift instead of silently changing the supplied lock.
RUN sha256sum native/Cargo.lock > /tmp/native-lock.sha256 \
    && pnpm install --frozen-lockfile \
    && sha256sum -c /tmp/native-lock.sha256 \
    && pnpm run build \
    && pnpm prune --prod --ignore-scripts
RUN mkdir -p /runtime/native && cp native/index.js native/package.json native/*.node /runtime/native/

FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS adapters
WORKDIR /opt/intake
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM node:22-slim@sha256:c3de60bf2f9dd0ac6370e6117950ff62d6e339527e7472301c9c78a017978392 AS runtime
WORKDIR /opt/firecrawl
COPY --from=build /source/apps/api/node_modules ./node_modules
COPY --from=build /source/apps/api/dist ./dist
COPY --from=build /runtime/native ./native
COPY --from=build /usr/lib/libfdb_c.so /usr/lib/libfdb_c.so
COPY --from=build /usr/lib/libfdb_c_shim.so /usr/lib/libfdb_c_shim.so
COPY --from=go-build /go-build/libhtml-to-markdown.so ./sharedLibs/go-html-to-md/libhtml-to-markdown.so
COPY --from=source /source/LICENSE /opt/notices/FIRECRAWL-LICENSE
COPY --from=source /source/upstream.tar.gz /opt/notices/upstream-source.tar.gz
COPY standalone-browser.patch core-Cargo.lock Core.Dockerfile /opt/notices/
WORKDIR /opt/intake
COPY --from=adapters /opt/intake/node_modules ./node_modules
COPY core-gateway.mjs core-job.cjs browser-service.mjs public-egress-proxy.mjs ./
USER node
ENV NODE_ENV=production FIRECRAWL_CORE_ROOT=/opt/firecrawl SCRAPER_GATEWAY_HOST=0.0.0.0
EXPOSE 3002
CMD ["node", "core-gateway.mjs"]
