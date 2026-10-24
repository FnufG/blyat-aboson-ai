# syntax=docker/dockerfile:1.7
FROM livekit/livekit-server@sha256:89ca9ce0791e18d6e03bf6e2c49ceb27e1c754eae8bd50c989386c1a5963791a AS livekit
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node

FROM node AS web-build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json .npmrc ./
# Optional corporate CA is used only while building, never stored in the image.
RUN --mount=type=secret,id=build_ca,mode=0444 \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70 AS python-build
WORKDIR /app
COPY voice/requirements.lock voice/requirements.lock
RUN --mount=type=secret,id=build_ca,mode=0444 \
    if [ -s /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca SSL_CERT_FILE=/run/secrets/build_ca; fi; \
    python -m pip install --no-cache-dir uv==0.12.23 && \
    uv venv --python /usr/local/bin/python3.12 voice/.venv && \
    UV_NO_CACHE=1 uv pip sync --python voice/.venv/bin/python voice/requirements.lock

FROM python:3.12-slim-bookworm@sha256:6a0e06f5ba0b373d051aabd3fffb9b873f27f9a2a3a14bcbe37dee6f0e3bbc70 AS runtime
# Both official language images use Debian Bookworm. Copying /usr/local keeps
# Node/npm alongside Python without a third-party package installation script.
COPY --from=node /usr/local/ /usr/local/
RUN --mount=type=secret,id=build_ca,mode=0444 \
    sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && \
    if [ -s /run/secrets/build_ca ]; then export SSL_CERT_FILE=/run/secrets/build_ca; set -- -o Acquire::https::CaInfo=/run/secrets/build_ca; fi; \
    apt-get "$@" update && \
    apt-get "$@" install -y --no-install-recommends ca-certificates espeak-ng libgomp1 libportaudio2 libstdc++6 libssl3 libzstd1 && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --gid 1000 liniya && useradd --uid 1000 --gid 1000 --create-home liniya
WORKDIR /app
COPY --from=web-build --chown=1000:1000 /app/ /app/
COPY --from=python-build --chown=1000:1000 /app/voice/.venv/ /app/voice/.venv/
COPY --from=livekit --chmod=755 /livekit-server /opt/liniya/livekit-server
RUN mkdir -p /app/.local && chown 1000:1000 /app/.local && chmod 755 scripts/docker-entrypoint.sh
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PYTHONUNBUFFERED=1 \
    ESPEAK_BINARY=/usr/bin/espeak-ng
USER 1000:1000
EXPOSE 3000 7880 7881 50000-50100/udp
ENTRYPOINT ["bash", "/app/scripts/docker-entrypoint.sh"]
