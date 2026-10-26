# Code Engine Terminal

AI agents are good at connecting steps. But some steps need more than a local
shell: a particular runtime, more CPU or memory, or a place to keep working files
between runs. We wanted flexible compute environments that can be selected to
fit each task, while still being callable through the same MCP workflow.

Azure, AWS, and Google Cloud all have ways to run this kind of workload. As
IBMers, though, IBM Cloud was our first choice; we also like its comparatively
close-to-the-metal feel. Within IBM Cloud, Code Engine fits the execution model:
each request can run in an isolated container, with its own image and CPU/memory
profile. Its jobrun lifecycle gives us the operations we need: submit work,
check its state, read logs, and request deletion.

MCP v2 protocol version `2025-07-28` that transitions the core architecture to be 
completely stateless made it possible to host implementation in Code Engine Application. 
A client submits a script and may choose an image and resource profile; a job can also use persistent data
from a mapped COS store. The Application starts the job and returns its terminal
ID to the client. That ID identifies the job in later requests to check its
status, retrieve logs, or request deletion. Code Engine runs the work
independently of the Application.

## Tools and options

- `shell` starts a job from inline Bash or a script path, with an optional image
  (`shell`, `java`, `node`, `python`, `dotnet`, `all`, or a full image reference)
  and supported CPU/memory profile.
- `status` checks the job state using its terminal ID.
- `output` retrieves logs by terminal ID, optionally selecting range or tail lines.
- `stop` requests job deletion; use it only when you need to abort a long-running
  job.

The bundled images include common tools and dependencies so many tasks can run
without additional setup. Resource profiles must be supported by Code Engine
and fit the project's quotas.

For larger scripts or data that should persist across jobruns, configure a Code
Engine persistent data store backed by Cloud Object Storage (COS). It is mounted
read/write at `/mnt/data`, so jobs can share persistent files and callers can
pass a script path there instead of sending a large script inline.

## Security

The terminal service must run behind an API Gateway that authenticates callers.
The service can start jobs that execute arbitrary shell scripts, so exposing it
without authentication would let unauthenticated users consume compute, run
untrusted commands, and access any persistent storage available to those jobs.

The gateway must forward the authenticated user's name and email as trusted
identity headers, and must remove client-supplied versions of those headers
before setting its own. The service uses these values to populate job identity
and resolve storage paths; accepting caller-supplied identity would allow one
user to impersonate another.

If persistent storage is configured, its bucket prefix must include `$USER`,
for example `terminal-store:users/$USER`. The service expands that placeholder
from the gateway-verified username, keeping each user's files in a separate
path. Without a user-specific prefix, concurrent callers can share or overwrite
files, and one user's job may read data written by another user's job.

Forwarding the email also gives jobs a verified contact identity for auditing
and user-aware workflows. Only gateway-verified identity should be used for
these purposes; other request headers are not a substitute for authentication.

Secrets needed by a job can be supplied as MCP HTTP headers instead of script
text or tool arguments. For example, with the default `x-terminal-` header
prefix, `x-terminal-api-key` becomes the job's `API_KEY` environment variable.
In VS Code, define the header using a password-protected input:

```json
{
  "servers": {
    "code-engine-terminal": {
      "url": "https://api.<project-id>.<region>.codeengine.appdomain.cloud/terminal/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer ${input:terminal-token}",
        "x-terminal-api-key": "${input:job-api-key}"
      }
    }
  },
  "inputs": [
    {
      "id": "terminal-token",
      "type": "promptString",
      "description": "Authentication token for the terminal MCP gateway",
      "password": true
    },
    {
      "id": "job-api-key",
      "type": "promptString",
      "description": "API key to expose to the job as API_KEY",
      "password": true
    }
  ]
}
```

The MCP client adds these values to the HTTP request; they are not part of the
agent's shell-tool arguments or prompt. The gateway must still authenticate the
caller, remove untrusted copies of privileged headers, and forward only
explicitly approved secret headers. Secrets become available to the job process
as environment variables, so scripts should not print them and logs or child
processes must be handled accordingly. Prefer short-lived, least-privilege
credentials.

## Example: Analyze a dataset

This conversation shows an agent analyzing `/mnt/data/sales.csv` with the Python
image: it starts a job, checks its status, and retrieves the result using the
returned terminal ID.

**User:** I uploaded `/sales.csv` to the mounted COS store. Can you
report the row count, total revenue, and revenue by region?

**AI:** I’ll run a short Python analysis against the mounted file, then check
the job output.

```json
{
  "tool": "shell",
  "arguments": {
    "script": "python - <<'PY'\nimport pandas as pd\ndf = pd.read_csv('/mnt/data/sales.csv')\nprint(f'Rows: {len(df)}')\nprint(f'Total revenue: {df[\"revenue\"].sum():.2f}')\nprint('Revenue by region:')\nprint(df.groupby('region')['revenue'].sum().to_string())\nPY",
    "image": "python",
    "resourceProfile": "cpu-1-mem-4g"
  }
}
```

**AI:** The job is running. Its terminal ID is `k4m2...`

```json
{
  "tool": "status",
  "arguments": { "terminalId": "k4m2..." }
}
```

**AI:** The job completed. I’ll fetch the report.

```json
{
  "tool": "output",
  "arguments": { "terminalId": "k4m2..." }
}
```

**AI:** The file contains 1,248 rows with total revenue of 84,392.50. The
largest regional total is West at 29,410.00.

## Run it in your account

Deploy the MCP service as a Code Engine Application with its own container
image, and register the job images (`shell`, `java`, `node`, `python`, `dotnet`,
and `all`) in a container registry the project can access.

The service does not authenticate or authorize callers, so place it behind an
API Gateway that does.

For example, the Application might be reachable inside the project at
`http://terminal.<project-id>.svc.cluster.local/mcp`. Clients would connect
through a public gateway URL such as
`https://api.<project-id>.<region>.codeengine.appdomain.cloud/terminal/mcp`.

In VS Code, add the gateway endpoint to the project's `.vscode/mcp.json` and
prompt for the gateway token:

```json
{
  "servers": {
    "code-engine-terminal": {
      "url": "https://api.<project-id>.<region>.codeengine.appdomain.cloud/terminal/mcp",
      "type": "http",
      "headers": {
        "Authorization": "Bearer ${input:terminal-token}"
      }
    }
  },
  "inputs": [
    {
      "id": "terminal-token",
      "type": "promptString",
      "description": "Authentication token for the terminal MCP gateway",
      "password": true
    }
  ]
}
```

## A terminal shaped around the task

Different jobs need different tools, compute, and working data. By combining
selectable execution images and resource profiles with a simple MCP interface,
the terminal lets an agent run each task in an environment suited to the work.
