FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl gzip git jq libatomic1 pigz rsync tar unzip zip python3 python3-venv \
    && python3 -m venv /opt/python \
    && /opt/python/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/python/bin/pip install --no-cache-dir pandas agent-framework \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/python/bin:$PATH"

COPY entrypoint.sh /usr/local/bin/terminal-entrypoint
RUN chmod 0555 /usr/local/bin/terminal-entrypoint

ENTRYPOINT ["/usr/local/bin/terminal-entrypoint"]