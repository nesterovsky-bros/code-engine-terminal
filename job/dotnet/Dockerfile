FROM debian:bookworm-slim

ARG DOTNET_CHANNEL=10.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        bash ca-certificates curl gzip git jq libatomic1 pigz rsync tar unzip zip \
        libicu72 libgssapi-krb5-2 libssl3 zlib1g \
    && curl -fsSL https://dot.net/v1/dotnet-install.sh -o /tmp/dotnet-install.sh \
    && bash /tmp/dotnet-install.sh --channel "$DOTNET_CHANNEL" --install-dir /usr/share/dotnet \
    && ln -s /usr/share/dotnet/dotnet /usr/local/bin/dotnet \
    && rm /tmp/dotnet-install.sh \
    && rm -rf /var/lib/apt/lists/*

ENV PATH="/usr/share/dotnet:$PATH"

COPY entrypoint.sh /usr/local/bin/terminal-entrypoint
RUN chmod 0555 /usr/local/bin/terminal-entrypoint

ENTRYPOINT ["/usr/local/bin/terminal-entrypoint"]