# syntax=docker/dockerfile:1.7

FROM node:20.19.5-bookworm-slim AS web-build
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:20.19.5-bookworm-slim AS server-build
WORKDIR /src/server
COPY server/package.json server/package-lock.json ./
RUN npm ci
COPY server/ ./
RUN npm run build && npm prune --omit=dev

FROM debian:bookworm-slim AS otto-build
RUN apt-get update && apt-get install -y --no-install-recommends build-essential make \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src/otto
COPY vendor/otto/ .
RUN make -C shared lib \
    && make ralph \
    && make -C arbor lib \
    && make -C surge surge_solve \
    && make -C velo NOMP=1 matrix_build \
    && make -C nexus nx_pipeline

FROM node:20.19.5-bookworm-slim AS runtime
ARG OTTO_REVISION=unknown
LABEL org.opencontainers.image.title="Cursus" \
      org.opencontainers.image.source="https://github.com/artalis-io/cursus" \
      io.artalis.otto.revision="$OTTO_REVISION"
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 tini \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 cursus \
    && useradd --uid 10001 --gid 10001 --no-create-home --home-dir /nonexistent cursus
WORKDIR /app
COPY --from=server-build --chown=cursus:cursus /src/server/dist ./server/dist
COPY --from=server-build --chown=cursus:cursus /src/server/node_modules ./server/node_modules
COPY --from=server-build --chown=cursus:cursus /src/server/package.json ./server/package.json
COPY --from=server-build --chown=cursus:cursus /src/server/scripts ./server/scripts
COPY --from=web-build --chown=cursus:cursus /src/web/dist ./web/dist
COPY --from=otto-build --chown=cursus:cursus /src/otto/surge/surge_solve /opt/otto/surge/surge_solve
COPY --from=otto-build --chown=cursus:cursus /src/otto/velo/matrix_build /opt/otto/velo/matrix_build
COPY --from=otto-build --chown=cursus:cursus /src/otto/nexus/nx_pipeline /opt/otto/nexus/nx_pipeline
COPY --from=otto-build --chown=cursus:cursus /src/otto/nexus/scripts /opt/otto/nexus/scripts
COPY --from=otto-build --chown=cursus:cursus /src/otto/nexus/schemas /opt/otto/nexus/schemas
COPY --chown=cursus:cursus deploy/entrypoint.sh /app/deploy/entrypoint.sh
ENV NODE_ENV=production OTTO_ROOT=/opt/otto WEB_DIST=/app/web/dist \
    SURGE_BIN=/opt/otto/surge/surge_solve MATRIX_BUILD_BIN=/opt/otto/velo/matrix_build \
    NEXUS_DIR=/opt/otto/nexus
EXPOSE 8091
USER cursus
ENTRYPOINT ["/usr/bin/tini", "--", "/app/deploy/entrypoint.sh"]
CMD ["node", "/app/server/dist/server.js"]
