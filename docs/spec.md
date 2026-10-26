# Terminal MCP on IBM Cloud Code Engine

## Purpose

Provide an MCP server that offers a remote terminal backed by IBM Cloud Code
Engine jobs. The server accepts shell scripts, starts jobs to execute them, and
exposes their output and lifecycle controls to MCP clients.

## Components

### MCP app

- Implemented in TypeScript and exposed as a Node.js MCP server.
- Runs on Node.js 26 using native TypeScript type stripping.
- Uses the official TypeScript SDK `@modelcontextprotocol/server` v2 and
  stateless Streamable HTTP. Each request is handled independently and does not
  depend on server-side MCP session state or session affinity.
- Uses the IBM Cloud CLI (`ibmcloud`) to communicate with Code Engine.
- The Code Engine application and job name are configured with `CE_APP`.
- Generates an opaque terminal ID and reconstructs the Code Engine jobrun name
  internally for subsequent CLI operations.

### Execution images

- Build separate image folders named `shell`, `java`, `node`, `python`,
  `dotnet`, and `all`, each with its own Dockerfile.
- Every image includes `curl`, `jq`, `git`, `rsync`, `gzip`, `pigz`, `tar`,
  and `zip`/`unzip`.
- The Python and `all` images include `pandas` and Microsoft's
  `agent-framework` Python package.
- An image may be supplied to `shell` as a full image reference or one of the
  six image names. The client infers a suitable image type from the requested
  script and workload, asking for clarification if ambiguous. Names resolve to
  `private.icr.io/$RESOURCE_GROUP/$CE_APP-$TYPE-job:latest`.
- A Code Engine jobrun executes the submitted script in its selected image.
- The script is supplied either as inline text or as a path readable by the job
  container.
## MCP operations

The server exposes tools equivalent to the following.

### `shell`

Submit a script for execution. The app starts a Code Engine jobrun through the
IBM Cloud CLI and returns an opaque terminal ID. It reconstructs the Code Engine
jobrun name internally for subsequent operations.

Inputs:

- Exactly one script source:
  - `script`: inline shell script text to execute.
  - `scriptPath`: path to a shell script inside the job container.
- Optional `image`: full container image reference or a language name. When
  omitted, the `shell` image is used. The client may infer another suitable
  image type from the script and workload.
- Optional `resourceProfile`: supported CPU/RAM profile. When omitted,
  `cpu-1-mem-4g` is used. The selected profile is always passed to Code Engine.
- Optional `bucketPath`: bucket prefix appended after the root prefix, if any,
  in the configured `DATA_STORE`. The configured root is retained. Leading
  slashes are removed and a trailing slash is added. Requires `DATA_STORE`.
- Optional `runners`: Code Engine job array size. When omitted, the Code Engine
  default is used.
- Optional `retryCount`: maximum retries for each runner. Defaults to `0`.
- Optional `timeout`: maximum job execution time in seconds. When omitted, the
  Code Engine default is used.
- The resolved disk mapping may use `$USER`, `$EMAIL`, and `$TERMINAL_ID`
  placeholders. `$USER` and `$EMAIL` are expanded from trusted
  `x-forwarded-user` and `x-forwarded-email` headers; `$EMAIL` expands to the
  complete email address, and spaces in `$USER` are replaced with periods.
  `$TERMINAL_ID` expands to the generated ID for the job. A matching identity
  header is required when its placeholder is used;
  unresolved placeholders are errors. This applies to the configured
  `DATA_STORE` path and the appended `bucketPath`.
- Optional command and argument overrides used to invoke the script. The app
  passes command and argument values as separate process arguments.
- Optional execution-context values from the namespaced MCP `_meta` entry
  `code-engine.terminal/env`. This is a map of allowed job environment-variable
  names to string values.
- Gateway-verified identity values from fixed HTTP header mappings, including
  `X-Forwarded-User` to `TERMINAL_USER` and `X-Forwarded-Email` to
  `TERMINAL_EMAIL`. These mappings apply to Streamable HTTP requests. The
  gateway must remove client-supplied copies and set the headers from
  authenticated identity context; the app accepts them only from the trusted
  gateway path.
- `TERMINAL_ENV_HEADER_PREFIX` maps gateway HTTP headers beginning with that
  prefix into job environment variables. It defaults to `x-terminal-`. The
  suffix is uppercased and hyphens become underscores; for example,
  `x-terminal-api-key` maps to `API_KEY`.
  Invalid names and collisions are rejected. The gateway must strip
  client-supplied headers with this prefix and inject only authenticated or
  otherwise approved values.
- Metadata values and gateway identity values have distinct purposes and
  mappings. Reject a request if both target the same job environment-variable
  name. Do not forward other metadata or HTTP headers outside the explicitly
  configured trusted prefix mapping.

Code Engine limits the combined job/jobrun configuration size to 10 KiB. Inline
script content counts toward this limit when carried in command or argument
values; use `scriptPath` for larger scripts.

The tool does not wait for a long-running script to finish. A synchronous wait
mode, if later required, must have an explicit timeout and retain the same
terminal ID semantics.

Output:

- The opaque terminal ID used for subsequent operations. The Code Engine
  jobrun name is reconstructed internally using the configured job name prefix.
- An initial state or submission error.

### `output`

Fetch available output from Code Engine jobrun logs for a terminal ID. Support
optional `top` and `count` parameters. `top` is a 1-based starting line. With
`top` and `count`, return up to `count` lines starting at `top`; with `top`
alone, return all available lines from `top`. With `count` alone, return the
last `count` lines. With neither parameter, return the last 100 lines. Return
only the selected log text, without line statistics or metadata.

### `status`

Return the Code Engine jobrun state and relevant timestamps. Map the documented
`pending`, `running`, `completed`, and `failed` states, and report unknown or
unavailable when the resource cannot be found or queried. Code Engine does not
expose a durable `stopped` state for jobruns.

### `stop`

Delete the Code Engine jobrun associated with the terminal ID using the
documented jobrun delete operation. Return whether the asynchronous delete
request was accepted; acceptance does not confirm that a running instance has
already terminated. Deletion removes the jobrun resource, so later status and
output requests may return not found. A repeated stop for an already deleted run
may also return not found.

## Job lifecycle

1. The client calls `shell` with either inline script text or a script path,
   plus optional execution settings.
2. The app submits a Code Engine jobrun against the configured Code Engine job definition
  when `image` is omitted. When `image` is provided, the app submits directly
  with that image. In both cases it passes command, arguments, environment
  variables and resources through supported `jobrun submit` options. For
  `scriptPath`, the container executes the file at that path.
3. The app generates an opaque terminal ID. Code Engine creates a jobrun using
  the `CE_APP` prefix and that ID; the app returns only the ID.
4. The job executes the submitted script.
5. For each subsequent request, the client supplies the terminal ID. The app
   uses the IBM Cloud CLI to query or retrieve logs from the corresponding Code
   Engine jobrun, or to delete it when `stop` is requested.
6. Code Engine jobrun and log retention follows Code Engine policies.

The app distinguishes transient IBM Cloud CLI or Code Engine failures from a
confirmed terminal job state.

## Configuration

Deployment configuration supports:

- IBM Cloud authentication for Code Engine CLI operations, including target
  account, region, resource group, and project. `CE_PROJECT_ID`, `CE_REGION`,
  and `RESOURCE_GROUP` are required.
- API Gateway routing for the MCP endpoint. The gateway authenticates and
  authorizes clients before forwarding requests.
- IBM Cloud CLI executable/runtime availability and the configured Code Engine
  job.
- `CE_APP`, the Code Engine job name, which defaults to `terminal`.
- `REGISTRY_SECRET`, an optional registry secret used for private registry
  images.
- `TERMINAL_ENV_HEADER_PREFIX`, the prefix for gateway headers mapped into job
  environment variables; defaults to `x-terminal-`.
- `DATA_STORE`, an optional store name with optional `:bucket-subpath`, which
  configures a persistent data store mounted read/write at `/mnt/data`.
- The default image (`shell`) and resource profile (`cpu-1-mem-4g`), with
  per-run overrides.
- Allow-listed job environment-variable names accepted from
  `code-engine.terminal/env`, and fixed mappings from gateway-verified identity
  headers to job environment-variable names.

CPU, memory, image, and mount values must be supported by Code Engine. Every
jobrun is submitted directly with an explicit image and CPU, memory, and
ephemeral-storage settings.

## Implementation decisions

1. Use `code-engine.terminal/env` as the single MCP `_meta` entry for
   caller-provided execution context. Deployment configuration defines the
   environment-variable names this map may set.
2. Map only gateway-verified identity headers through fixed
  header-to-environment-variable mappings. The gateway overwrites or removes
  client-supplied copies. `X-Forwarded-User` maps to `TERMINAL_USER` and
  `X-Forwarded-Email` maps to `TERMINAL_EMAIL`.
3. Reject conflicting assignments from metadata and identity mappings. Do not
  forward other `_meta` entries or HTTP headers outside the explicitly
  configured trusted prefix mapping.

## Acceptance criteria

- An MCP client can submit a script and receive an opaque terminal ID without
  waiting for the job to complete.
- The client can submit inline script text within Code Engine's 10 KiB
  configuration limit or a script path accessible to the job, including through
  a mounted COS persistent data store.
- The client can retrieve available jobrun logs and query status by terminal ID.
- The client can request deletion by terminal ID and receive the delete
  acceptance result; subsequent requests may report the terminal ID as not
  found.
- Job CPU, memory, and ephemeral storage can be overridden per run using a
  Code Engine-supported combination. Per-run image selection works for direct
  jobrun submissions.
- Allow-listed metadata values and fixed gateway-verified identity values are
  passed to the job as mapped environment variables. Other metadata and headers
  are not forwarded, and conflicting assignments are rejected.
