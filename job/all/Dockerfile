FROM maven:3.10.0-eclipse-temurin-27

ARG NODE_VERSION=26.5.0
ARG DOTNET_CHANNEL=10.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl gzip git jq libatomic1 pigz rsync tar unzip zip xz-utils \
        python3 python3-venv libicu-dev libgssapi-krb5-2 libssl-dev zlib1g \
    && curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && tar -xJf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C /usr/local --strip-components=1 \
    && rm "node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && python3 -m venv /opt/python \
    && /opt/python/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/python/bin/pip install --no-cache-dir pandas agent-framework \
    && curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && bash /tmp/dotnet-install.sh --channel "$DOTNET_CHANNEL" --install-dir /usr/share/dotnet \
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
    && rm /tmp/dotnet-install.sh \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/opt/python/bin:/usr/share/dotnet:$PATH"

COPY entrypoint.sh /usr/local/bin/terminal-entrypoint
RUN chmod 0555 /usr/local/bin/terminal-entrypoint

ENTRYPOINT ["/usr/local/bin/terminal-entrypoint"]