FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl gzip git jq libatomic1 pigz rsync tar unzip zip \
    && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /usr/local/bin/terminal-entrypoint
RUN chmod 0555 /usr/local/bin/terminal-entrypoint

ENTRYPOINT ["/usr/local/bin/terminal-entrypoint"]