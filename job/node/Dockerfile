FROM debian:bookworm-slim

ARG NODE_VERSION=26.5.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl gzip git jq libatomic1 pigz rsync tar unzip zip xz-utils \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 \
    && rm "node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/terminal-entrypoint
RUN chmod 0555 /usr/local/bin/terminal-entrypoint

ENTRYPOINT ["/usr/local/bin/terminal-entrypoint"]