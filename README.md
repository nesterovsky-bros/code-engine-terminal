# Terminal

Stateless Streamable HTTP MCP service that runs scripts as IBM Cloud Code Engine
jobruns. This project contains two components:

- `mcp/`: TypeScript MCP service compiled to JavaScript for local execution and
  deployment on Node.js 26+.
- `job/`: six independent execution image folders: `shell`, `java`, `node`,
  `python`, `dotnet`, and `all`.

## Code Engine resources and naming

Set the Code Engine application and job name with `CE_APP`, which defaults to
`terminal`. The service returns an opaque terminal ID and reconstructs the
jobrun name internally.

## Build images

Build each image from its self-contained directory under `terminal/job`. For
example:

```powershell
docker build --tag "private.icr.io/$env:RESOURCE_GROUP/$env:CE_APP-shell-job:latest" --file job/shell/Dockerfile job/shell
docker build --tag "private.icr.io/$env:RESOURCE_GROUP/$env:CE_APP-java-job:latest" --file job/java/Dockerfile job/java
docker build --tag "private.icr.io/$env:RESOURCE_GROUP/$env:CE_APP-node-job:latest" --file job/node/Dockerfile job/node
docker build --tag "private.icr.io/$env:RESOURCE_GROUP/$env:CE_APP-python-job:latest" --file job/python/Dockerfile job/python
docker build --tag "private.icr.io/$env:RESOURCE_GROUP/$env:CE_APP-dotnet-job:latest" --file job/dotnet/Dockerfile job/dotnet
docker build --tag "private.icr.io/$env:RESOURCE_GROUP/$env:CE_APP-all-job:latest" --file job/all/Dockerfile job/all
```

Each image includes `curl`, `jq`, `git`, `rsync`, `gzip`, `pigz`, `tar`, `zip`,
and `unzip`. The Python and `all` images also include `pandas` and Microsoft's
`agent-framework` package.

Build the MCP service image from `mcp/`:

```powershell
docker build --tag terminal-mcp:latest --file mcp/Dockerfile mcp
```

The MCP image compiles TypeScript to `dist/` in a build stage and installs only
production dependencies in the runtime stage. The Code Engine CLI and Code
Engine plugin are included. Provide IBM Cloud CLI authentication and the current
Code Engine project context through the deployment environment/configuration.

Push the images to a registry accessible to the Code Engine project. Passing an
image URL or one of `shell`, `java`, `node`, `python`, `dotnet`, or `all`
selects the image for the jobrun; shorthand names resolve to
`private.icr.io/$RESOURCE_GROUP/$CE_APP-TYPE-job:latest`.

## Configure and run locally

Use Node.js 26 or newer. Copy `mcp/.env.example` to `mcp/.env`, fill in the IBM
Cloud values, then start the local run from `mcp/`:

```sh
npm ci
npm run build
npm run dev
```

The VS Code launch profile builds the JavaScript and then debugs `dist/`,
loading `mcp/.env`. `npm run dev` builds before starting. Code Engine
applications inject `CE_REGION` and `CE_PROJECT_ID`; local debug supplies these
through `.env`. Code Engine does not inject an API key or select a resource
group. Configure both explicitly, preferably storing the API key in a Code
Engine secret. Startup runs `ibmcloud login` with the API key, target region,
and target resource group, then selects the target project by ID. Keep `.env`
private and use a development API key with only the access needed.

Required configuration:

- `CE_PROJECT_ID` is required and selects the Code Engine project. It is
  automatically injected in Code Engine applications; provide it in `.env` for
  local debug.
- `CE_REGION`: project region. Automatically injected in Code Engine
  applications; provide it in `.env` for local debug.
- `RESOURCE_GROUP`: target IBM Cloud resource-group name or ID. Code Engine does
  not inject it.
- IBM Cloud CLI and the Code Engine plugin installed and available on `PATH`.

Optional configuration:

- `CE_APP`: application and job name; defaults to `terminal`.
- `REGISTRY_SECRET`: optional Code Engine registry secret passed for image
  references beginning with `private.icr.io/`.
- `DATA_STORE`: optional Code Engine persistent data store, formatted as
  `store-name` or `store-name:bucket-subpath`, mounted read/write at `/mnt/data`.
- `PORT`: HTTP listen port; defaults to `8080`.
- `API_KEY_ID`: IBM Cloud API key used to log in at startup. Not
  automatically injected; configure it through a secret in deployment.

The MCP endpoint is `/mcp`; `/health` is a liveness endpoint. Tools are `shell`,
`status`, `output`, and `stop`.

The MCP service does not authenticate or authorize callers. Deploy it behind
the API Gateway, which must authenticate and authorize clients before forwarding
requests to `/mcp`. IBM Cloud authentication configured for the MCP service is
used for its Code Engine operations, not for authenticating MCP callers.

## Tools

`shell` accepts exactly one script source: `script` for inline Bash text or
`scriptPath` for a file readable in the job container. It returns a compact
terminal ID without waiting for completion. Inline text passed as
command/argument values counts toward Code Engine's 10 KiB job/jobrun
configuration limit; use a mounted path for larger scripts. The app passes
command-line values as distinct process arguments. The same ID is available in
the job as the `TERMINAL_ID` environment variable; callers cannot override it.
The configured bucket subpath in `DATA_STORE` is always retained as the root.
The resolved disk mapping supports `$USER`, `$EMAIL`, and `$TERMINAL_ID`.
`$USER` and `$EMAIL` expand to the complete trusted `x-forwarded-user` and
`x-forwarded-email` values; spaces in `$USER` are replaced with periods.
`$TERMINAL_ID` expands to the generated job ID.
Missing required identity headers and unresolved placeholders are errors.
The optional `bucketPath` is appended after the configured path; leading
slashes are removed and a trailing slash is added. `bucketPath` requires
`DATA_STORE` to be set.

`status` returns the Code Engine jobrun state and available timestamps. The
documented states are `pending`, `running`, `completed`, and `failed`. `output`
retrieves available jobrun logs. Optional `top` selects a 1-based starting line,
and optional `count` limits the number of returned lines. With `top` only, all
available lines from that point are returned. With `count` only, the last
`count` lines are returned. With neither, the last 100 lines are returned. The
tool returns only the selected log text. `stop` requests
asynchronous jobrun deletion;
acceptance does not confirm immediate termination, and subsequent status/output
calls can return not found.

Resource profiles must use Code Engine-supported CPU/RAM combinations and
respect project quotas. `shell.image` accepts an image URL or one of `shell`,
`java`, `node`, `python`, `dotnet`, and `all`; it defaults to `shell`. Named
images resolve as `private.icr.io/$RESOURCE_GROUP/$CE_APP-TYPE-job:latest`.
Every run submits a jobrun with an explicit image and resource profile; the
default profile is `cpu-1-mem-4g`.

## COS and data retention

Code Engine exposes IBM Cloud Object Storage buckets to job containers through
persistent data stores. Set `DATA_STORE` to a Code Engine persistent data store
name, optionally followed by `:bucket-subpath`. The store is mounted read/write
at `/mnt/data`. The job accesses COS as a filesystem path; the MCP app
does not access COS directly. Configure any backing COS credentials/secret on
the Code Engine data store itself. Jobrun and
log retention follows Code Engine policies. Output objects written to a mounted
bucket follow that bucket's storage and lifecycle configuration.

## Caller context and secrets

Caller-provided execution context uses MCP `_meta` entry
`code-engine.terminal/env`, a map of valid environment-variable names to string
values. Gateway identity uses fixed mappings from trusted HTTP headers, including
`X-Forwarded-User` to `TERMINAL_USER` and `X-Forwarded-Email` to
`TERMINAL_EMAIL` (also `X-Gateway-Subject` to `TERMINAL_USER_ID` and
`X-Gateway-Client-Id` to `TERMINAL_CLIENT_ID`). The
gateway must replace or remove client-supplied copies. Conflicting assignments
are rejected; other metadata and headers are not forwarded.

`TERMINAL_ENV_HEADER_PREFIX` maps gateway headers into job environment
variables. It defaults to `x-terminal-`; for example, `x-terminal-api-key`
maps to `API_KEY`. Configure the gateway to remove any client-supplied headers
with this prefix and inject only approved values from authenticated context or
secret storage. The service rejects invalid variable names and collisions with
other job environment values.

Provide credentials through approved secret management or Code Engine secrets.
Avoid putting secrets in scripts, command arguments, or logs.
