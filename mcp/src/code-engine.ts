import { spawn } from "node:child_process";
import { config, resourceProfiles, type ResourceProfile } from "./config.ts";

export interface CliResult {
  stdout: string;
  stderr: string;
}

export class CodeEngineError extends Error {
  constructor(message: string, readonly exitCode: number | null) {
    super(message);
    this.name = "CodeEngineError";
  }
}

export function runCli(args: string[]): Promise<CliResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("ibmcloud", args, {
      shell: false,
      windowsHide: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => stdout += chunk);
    child.stderr.on("data", chunk => stderr += chunk);
    child.once("error", error => reject(new CodeEngineError(`Unable to start IBM Cloud CLI: ${error.message}`, null)));
    
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new CodeEngineError(stderr.trim() || stdout.trim() || "IBM Cloud CLI command failed", exitCode));
      }
    });
  });
}

function parseJsonOutput(stdout: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(stdout);

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object");
    }

    return parsed as Record<string, unknown>;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    
    throw new Error(`IBM Cloud CLI returned invalid JSON: ${detail}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRunStatus(result: Record<string, unknown>, terminalId: string): Record<string, unknown> {
  const metadata = isRecord(result.metadata) ? result.metadata : {};
  const runStatus = isRecord(result.status) ? result.status : {};
  const conditions = Array.isArray(runStatus.conditions) ? runStatus.conditions.filter(isRecord) : [];
  
  const trueConditions = new Set(conditions
    .filter((condition) => String(condition.status).toLowerCase() === "true")
    .map((condition) => String(condition.type).toLowerCase()));
  
  const status = typeof result.status === "string" ? result.status.toLowerCase() : 
    trueConditions.has("failed") ? "failed" : 
    trueConditions.has("complete") ? "completed" : 
    trueConditions.has("running") ? "running" : 
    trueConditions.has("pending") ? "pending" : "unknown";

  return {
    terminalId,
    status,
    createdAt: result.created_at ?? metadata.creationTimestamp,
    startedAt: result.started_at ?? runStatus.startTime,
    finishedAt: result.finished_at ?? runStatus.completionTime ?? runStatus.finishedAt
  };
}

export interface SubmitRunOptions {
  terminalId: string;
  script?: string;
  scriptPath?: string;
  image?: string;
  bucketPath?: string;
  runners?: number;
  retryCount?: number;
  timeout?: number;
  resourceProfile?: ResourceProfile;
  env: Record<string, string>;
}

function normalizeBucketPrefix(prefix: string): string {
  const normalized = prefix.replace(/^\/+/, "").replace(/\/+$/, "");

  if (!normalized) {
    throw new Error("Bucket prefix must contain a path");
  }

  return `${normalized}/`;
}

function resolveDataStoreIdentity(mapping: string, env: Record<string, string>, terminalId: string): string {
  return mapping.replace(/\$(USER|EMAIL|TERMINAL_ID)\b/g, (_match, key: string) => {
    switch (key) {
      case "USER": {
        const user = env.TERMINAL_USER;

        if (!user) {
          throw new Error("Disk mapping uses $USER, but TERMINAL_USER is missing");
        }

        return user.replace(/\s/g, ".");
      }
      case "EMAIL": {
        const email = env.TERMINAL_EMAIL;

        if (!email) {
          throw new Error("Disk mapping uses $EMAIL, but TERMINAL_EMAIL is missing");
        }

        return email;
      }
      case "TERMINAL_ID":
        return terminalId;
      default:
        return _match;
    }
  });
}

export async function submitRun(options: SubmitRunOptions): Promise<Record<string, unknown>> {
  const name = config.getJobrunName(options.terminalId);
  const image = config.resolveImageReference(options.image ?? "shell");
  
  const args = [
    "ce", "jobrun", "submit",
    "--name", name,
    "--image", image,
    "--retrylimit", String(options.retryCount ?? 0),
    "--output", "json"
  ];

  if (options.runners !== undefined) {
    args.push("--array-size", String(options.runners));
  }

  if (options.timeout !== undefined) {
    args.push("--timeout", String(options.timeout));
  }

  if (image.startsWith("private.icr.io/") && config.registrySecret) {
    args.push("--registry-secret", config.registrySecret);
  }

  const resourceProfile = options.resourceProfile ?? "cpu-1-mem-4g";
  const { cpu, memory, ephemeralStorage } = resourceProfiles[resourceProfile];

  args.push(
    "--cpu", cpu,
    "--memory", memory,
    "--ephemeral-storage", ephemeralStorage);

  if (options.bucketPath !== undefined && !config.dataStore) {
    throw new Error("DATA_STORE must be configured to use bucketPath");
  }

  if (config.dataStore) {
    const separatorIndex = config.dataStore.indexOf(":");
    const storeName = separatorIndex === -1 ? config.dataStore : config.dataStore.slice(0, separatorIndex);
    const rootPrefix = separatorIndex === -1 ? "" : config.dataStore.slice(separatorIndex + 1);
    const bucketPrefixes = rootPrefix ? [normalizeBucketPrefix(rootPrefix)] : [];

    if (options.bucketPath !== undefined) {
      bucketPrefixes.push(normalizeBucketPrefix(options.bucketPath));
    }

    const bucketPrefix = bucketPrefixes.map(prefix => prefix.replace(/\/$/, "")).join("/");
    const dataStore = bucketPrefix ? `${storeName}:${bucketPrefix}/` : storeName;
    const diskMapping = resolveDataStoreIdentity(`/mnt/data=${dataStore}`, options.env, options.terminalId);

    args.push("--mount-data-store", diskMapping);
  }

  if ("TERMINAL_ID" in options.env) {
    throw new Error("TERMINAL_ID is reserved for the generated terminal ID");
  }

  args.push("--env", `TERMINAL_ID=${options.terminalId}`);
  
  for (const [name, value] of Object.entries(options.env)) {
    args.push("--env", `${name}=${value}`);
  }

  if (options.scriptPath) {
    args.push(
      "--env", "TERMINAL_SCRIPT_MODE=path",
      "--argument", options.scriptPath);
  } else {
    args.push(
      "--env", "TERMINAL_SCRIPT_MODE=inline",
      "--argument", options.script!);
  }

  await runCli(args);
  
  return { terminalId: options.terminalId, status: "pending" };
}

export async function getRun(terminalId: string): Promise<Record<string, unknown>> {
  const name = config.getJobrunName(terminalId);
  const result = await runCli(["ce", "jobrun", "get", "--name", name, "--output", "json"]);
  
  return parseRunStatus(parseJsonOutput(result.stdout), terminalId);
}

export async function getRunOutput(terminalId: string, top?: number, count?: number): Promise<string> {
  const name = config.getJobrunName(terminalId);
  
  count ??= top === undefined ? 100 : undefined;
  
  const args = ["ce", "jobrun", "logs", "--jobrun", name, "--quiet", "--raw"];

  if (top === undefined && count !== undefined) {
    args.push("--tail", String(count));
  }

  const result = await runCli(args);

  if (top === undefined) {
    return result.stdout;
  }

  const outputLines = result.stdout === "" ? [] : result.stdout.split(/\r?\n/);
  const start = Math.min(top - 1, outputLines.length);
  const end = count === undefined ? outputLines.length : Math.min(start + count, outputLines.length);
  const selectedLines = outputLines.slice(start, end);

  return selectedLines.join("\n");
}

export async function deleteRun(terminalId: string): Promise<Record<string, unknown>> {
  const name = config.getJobrunName(terminalId);
  
  await runCli(["ce", "jobrun", "delete", "--name", name, "--force"]);

  return { terminalId, accepted: true };
}

export async function deleteCompletedRuns(cutoffMinutes = 60): Promise<Record<string, unknown>> {
  if (!Number.isFinite(cutoffMinutes) || cutoffMinutes < 0) {
    throw new Error("cutoffMinutes must be a non-negative finite number");
  }

  const result = await runCli(["ce", "jobrun", "list", "--output", "json"]);
  let parsed: unknown;

  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);

    throw new Error(`IBM Cloud CLI returned invalid JSON: ${detail}`);
  }

  const jobruns = Array.isArray(parsed)
    ? parsed.filter(isRecord)
    : isRecord(parsed) && Array.isArray(parsed.items)
      ? parsed.items.filter(isRecord)
      : [];
  const prefix = `${config.jobName}-`;
  const cutoff = Date.now() - cutoffMinutes * 60 * 1000;
  const deleted: string[] = [];

  for (const jobrun of jobruns) {
    const metadata = isRecord(jobrun.metadata) ? jobrun.metadata : {};
    const name = typeof metadata.name === "string" ? metadata.name : jobrun.name;

    if (typeof name !== "string" || !name.startsWith(prefix)) {
      continue;
    }

    const terminalId = name.slice(prefix.length);

    try {
      if (config.getJobrunName(terminalId) !== name) {
        continue;
      }
    } catch {
      continue;
    }

    const status = parseRunStatus(jobrun, terminalId);
    const finishedAt = typeof status.finishedAt === "string" ? Date.parse(status.finishedAt) : NaN;

    if (status.status !== "completed" || !Number.isFinite(finishedAt) || finishedAt > cutoff) {
      continue;
    }

    await runCli(["ce", "jobrun", "delete", "--name", name, "--force"]);
    deleted.push(name);
  }

  return { deleted, count: deleted.length };
}

export async function initializeIbmCloud(): Promise<void> {
  const { ibmcloudApiKey, projectId, region, resourceGroup } = config;
  
  await runCli(["config", "--check-version=false"]);    
  await runCli(["login", "--apikey", ibmcloudApiKey, "-r", region, "-g", resourceGroup]);
  await runCli(["ce", "project", "select", "--id", projectId]);
}
