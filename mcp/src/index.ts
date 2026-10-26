import { createServer } from "node:http";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import type { ServerContext } from "@modelcontextprotocol/server";
import { z } from "zod";
import { config, resourceProfiles, resourceProfileValues, validateConfiguration } from "./config.ts";
import { deleteCompletedRuns, deleteRun, getRun, getRunOutput, initializeIbmCloud, submitRun } from "./code-engine.ts";

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(entry => typeof entry === "string");
}

function getRunEnvironment(ctx: ServerContext): Record<string, string> {
  const meta = ctx.mcpReq._meta as Record<string, unknown> | undefined;
  const requested = meta?.[config.terminalEnvKey];

  if (requested !== undefined && !isStringRecord(requested)) {
    throw new Error(`${config.terminalEnvKey} must be a map of string values`);
  }

  const env: Record<string, string> = requested === undefined ? {} : { ...requested };

  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`Invalid environment variable name: ${name}`);
    }

    env[name] = value;
  }

  const request = ctx.http?.req;

  for (const [header, name] of Object.entries(config.trustedGatewayHeaders)) {
    const value = request?.headers.get(header);

    if (!value) {
      continue;
    }

    if (name in env) {
      throw new Error(`Conflicting values target ${name}`);
    }

    env[name] = value;
  }

  const prefix = config.terminalEnvHeaderPrefix;

  if (request && prefix) {
    request.headers.forEach((value, header) => {
      if (!header.startsWith(prefix) || !value) {
        return;
      }

      const name = header.slice(prefix.length).replace(/-/g, "_").toUpperCase();

      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error(`Invalid job environment header: ${header}`);
      }

      if (name in env) {
        throw new Error(`Conflicting values target ${name}`);
      }

      env[name] = value;
    });
  }

  return env;
}

function textResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

const resourceProfileDescription = [
  "Select a supported CPU/RAM profile for the expected workload.",
  "If omitted, the job uses cpu-1-mem-4g.",
  "The enum values map to:",
  ...Object.entries(resourceProfiles).map(
    ([name, resources]) =>
      `  ${name}: ${resources.cpu} vCPU, ${resources.memory} RAM, ${resources.ephemeralStorage} ephemeral storage`,
  ),
  "The selected profile is always passed to Code Engine.",
].join("\n");

const resourceProfileInput = z
  .enum(resourceProfileValues)
  .optional()
  .describe(resourceProfileDescription);

const shellInputSchema = z.object({
  script: z
    .string()
    .min(1)
    .optional()
    .describe(
`Inline Bash script text. Provide exactly one of script or scriptPath.
Inline scripts count toward Code Engine's 10 KiB jobrun configuration limit.`),
  scriptPath: z
    .string()
    .min(1)
    .optional()
    .describe(
`Path to a script file readable inside the job container,
for example on a mounted data store.
Provide exactly one of script or scriptPath.`),
  image: z
    .string()
    .min(1)
    .optional()
    .describe(
`Container image URL, or one of: shell, java, node, python, dotnet, all.
If omitted, defaults to the shell image.
Language names resolve under private.icr.io/$RESOURCE_GROUP/$CE_APP-TYPE-job:latest.
Every run is submitted with an image.`),
  bucketPath: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe("Optional bucket prefix appended to the configured persistent data-store path."),
  runners: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Optional Code Engine job array size; when omitted, Code Engine's default is used."),
  retryCount: z
    .number()
    .int()
    .min(0)
    .default(0)
    .describe("Maximum retries for each job runner. Defaults to 0."),
  timeout: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Optional maximum job execution time in seconds."),
  resourceProfile: resourceProfileInput,
});

const terminalIdInput = z
  .string()
  .min(1)
  .describe("Opaque terminal ID returned by shell.");

function registerTools(server: McpServer): void {
  server.registerTool(
    "shell",
    {
      description: 
`Submit a shell script for execution and return its terminal ID.
The script is always executed by Bash, regardless of the selected image; the image
only determines which runtimes and tools are available to the script.
When image is omitted, the shell image is used. When resourceProfile is omitted,
cpu-1-mem-4g is used. A configured persistent data store is mounted at /mnt/data;
bucketPath is appended to its configured subpath. Optional runners sets the job
array size, retryCount defaults to 0, and timeout is an optional duration in
seconds. The resolved disk mapping supports $USER and $EMAIL from trusted
gateway headers, and $TERMINAL_ID from the generated job ID.`,
      inputSchema: shellInputSchema,
    },
    async (input, ctx) => {
      const hasScript = input.script !== undefined;
      const hasScriptPath = input.scriptPath !== undefined;

      if (hasScript === hasScriptPath) {
        throw new Error("Provide exactly one of script or scriptPath");
      }

      if (input.script !== undefined && input.script.length === 0) {
        throw new Error("script must not be empty");
      }

      if (input.scriptPath !== undefined && input.scriptPath.length === 0) {
        throw new Error("scriptPath must not be empty");
      }

      const result = await submitRun({
        terminalId: config.createJobrunId(),
        script: input.script,
        scriptPath: input.scriptPath,
        image: input.image,
        bucketPath: input.bucketPath,
        runners: input.runners,
        retryCount: input.retryCount,
        timeout: input.timeout,
        resourceProfile: input.resourceProfile,
        env: getRunEnvironment(ctx),
      });

      deleteCompletedRuns(config.jobrunCleanupCutoffMinutes).catch(error => {
        console.error("Failed to clean up completed Code Engine jobruns:", error);
      });

      return textResult(result);
    },
  );

  server.registerTool(
    "status",
    {
      description:
`Get the current Code Engine jobrun state by terminal ID.
Poll periodically while the jobrun is active to check its status.`,
      inputSchema: z.object({ terminalId: terminalIdInput }),
      annotations: { readOnlyHint: true },
    },
    async ({ terminalId }) => textResult(await getRun(terminalId)),
  );

  server.registerTool(
    "output",
    {
      description: 
`Get jobrun logs by terminal ID.
Specify top to return from that 1-based line; optionally set count to limit rows.
With count only, return the last count rows. With neither option, return the last 100 rows.
Poll periodically while it runs; call status if output is unchanged.`,
      inputSchema: z.object({
        terminalId: terminalIdInput,
        top: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("1-based starting line for top output."),
        count: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Maximum number of lines to return."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ terminalId, top, count }) => {
      return { content: [ { type: "text" as const, text: await getRunOutput(terminalId, top, count) } ]};
    },
  );

  server.registerTool(
    "stop",
    {
      description: "Delete the Code Engine jobrun associated with the terminal ID.",
      inputSchema: z.object({ terminalId: terminalIdInput }),
      annotations: { destructiveHint: true, idempotentHint: false },
    },
    async ({ terminalId }) => textResult(await deleteRun(terminalId)),
  );
}

function makeMcpServer(): McpServer {
  const server = new McpServer({ name: "terminal", version: "0.1.0" });

  registerTools(server);
  
  return server;
}

validateConfiguration();
await initializeIbmCloud();

const handler = createMcpHandler(() => makeMcpServer(), { responseMode: "json" });
const nodeHandler = toNodeHandler(handler);

const httpServer = createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: "ok", server: "terminal" }));

    return;
  }

  if (request.url !== "/mcp") {
    response.writeHead(404);
    response.end();

    return;
  }

  nodeHandler(request, response);
});

httpServer.listen(config.port, "0.0.0.0", () => {
  console.log(`terminal MCP listening on port ${config.port}`);
});

for(const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => httpServer.close(() => handler.close().finally(() => process.exit(0))));
}
