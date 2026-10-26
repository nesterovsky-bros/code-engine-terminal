import { randomBytes } from "node:crypto";

const terminalEnvKey = "code-engine.terminal/env";
const terminalIdPattern = /^[0-9a-z]{1,25}$/;
const jobrunNameMaxLength = 53;
const languageImages = new Set(["shell", "java", "node", "python", "dotnet", "all"]);

export const resourceProfiles = {
  "cpu-0.125-mem-250m": { cpu: "0.125", memory: "250M", ephemeralStorage: "400M" },
  "cpu-0.125-mem-500m": { cpu: "0.125", memory: "500M", ephemeralStorage: "500M" },
  "cpu-0.125-mem-1g": { cpu: "0.125", memory: "1G", ephemeralStorage: "1G" },
  "cpu-0.25-mem-500m": { cpu: "0.25", memory: "500M", ephemeralStorage: "500M" },
  "cpu-0.25-mem-1g": { cpu: "0.25", memory: "1G", ephemeralStorage: "1G" },
  "cpu-0.25-mem-2g": { cpu: "0.25", memory: "2G", ephemeralStorage: "2G" },
  "cpu-0.5-mem-1g": { cpu: "0.5", memory: "1G", ephemeralStorage: "1G" },
  "cpu-0.5-mem-2g": { cpu: "0.5", memory: "2G", ephemeralStorage: "2G" },
  "cpu-0.5-mem-4g": { cpu: "0.5", memory: "4G", ephemeralStorage: "4G" },
  "cpu-1-mem-2g": { cpu: "1", memory: "2G", ephemeralStorage: "2G" },
  "cpu-1-mem-4g": { cpu: "1", memory: "4G", ephemeralStorage: "4G" },
  "cpu-1-mem-8g": { cpu: "1", memory: "8G", ephemeralStorage: "8G" },
  "cpu-2-mem-4g": { cpu: "2", memory: "4G", ephemeralStorage: "4G" },
  "cpu-2-mem-8g": { cpu: "2", memory: "8G", ephemeralStorage: "8G" },
  "cpu-2-mem-16g": { cpu: "2", memory: "16G", ephemeralStorage: "16G" },
  "cpu-4-mem-8g": { cpu: "4", memory: "8G", ephemeralStorage: "8G" },
  "cpu-4-mem-16g": { cpu: "4", memory: "16G", ephemeralStorage: "16G" },
  "cpu-4-mem-32g": { cpu: "4", memory: "32G", ephemeralStorage: "32G" },
  "cpu-6-mem-12g": { cpu: "6", memory: "12G", ephemeralStorage: "12G" },
  "cpu-6-mem-24g": { cpu: "6", memory: "24G", ephemeralStorage: "24G" },
  "cpu-6-mem-48g": { cpu: "6", memory: "48G", ephemeralStorage: "48G" },
  "cpu-8-mem-16g": { cpu: "8", memory: "16G", ephemeralStorage: "16G" },
  "cpu-8-mem-32g": { cpu: "8", memory: "32G", ephemeralStorage: "32G" },
  "cpu-10-mem-20g": { cpu: "10", memory: "20G", ephemeralStorage: "20G" },
  "cpu-10-mem-40g": { cpu: "10", memory: "40G", ephemeralStorage: "40G" },
  "cpu-12-mem-24g": { cpu: "12", memory: "24G", ephemeralStorage: "24G" },
  "cpu-12-mem-48g": { cpu: "12", memory: "48G", ephemeralStorage: "48G" },
} as const;

export type ResourceProfile = keyof typeof resourceProfiles;
export const resourceProfileValues = Object.keys(resourceProfiles) as ResourceProfile[];

export function isResourceProfile(value: string): value is ResourceProfile {
  return Object.hasOwn(resourceProfiles, value);
}

function requireEnvironmentValue(name: string): string {
  const value = process.env[name]?.trim();

  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function parsePositiveInteger(rawValue: string | undefined, fallback: number, settingName: string): number {
  if (!rawValue) {
    return fallback;
  }
  
  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${settingName} must be a positive integer`);
  }
  
  return value;
}

function parseNonNegativeNumber(rawValue: string | undefined, fallback: number, settingName: string): number {
  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${settingName} must be a non-negative number`);
  }

  return value;
}

const resourceGroup = requireEnvironmentValue("RESOURCE_GROUP");

export const config = {
  jobName: process.env.CE_APP ?? "terminal",
  projectId: requireEnvironmentValue("CE_PROJECT_ID"),
  region: requireEnvironmentValue("CE_REGION"),
  resourceGroup,
  registrySecret: process.env.REGISTRY_SECRET?.trim(),
  dataStore: process.env.DATA_STORE?.trim(),
  terminalEnvHeaderPrefix: process.env.TERMINAL_ENV_HEADER_PREFIX?.trim().toLowerCase() || "x-terminal-",
  ibmcloudApiKey: requireEnvironmentValue("API_KEY_ID"),
  port: parsePositiveInteger(process.env.PORT, 8080, "PORT"),
  jobrunCleanupCutoffMinutes: parseNonNegativeNumber(
    process.env.JOBRUN_CLEANUP_CUTOFF_MINUTES,
    60,
    "JOBRUN_CLEANUP_CUTOFF_MINUTES"),

  resolveImageReference(image: string): string {
    if (!languageImages.has(image)) {
      return image;
    }

    return `private.icr.io/${resourceGroup}/${this.jobName}-${image}-job:latest`;
  },

  trustedGatewayHeaders: {
    "x-gateway-subject": "TERMINAL_USER_ID",
    "x-gateway-client-id": "TERMINAL_CLIENT_ID",
    "x-forwarded-user": "TERMINAL_USER",
    "x-forwarded-email": "TERMINAL_EMAIL",
  },

  terminalEnvKey,

  createJobrunId(): string {
    const id = BigInt(`0x${randomBytes(16).toString("hex")}`).toString(36);

    if (this.jobName.length + (this.jobName ? 1 : 0) + id.length > jobrunNameMaxLength) {
      const maxLength = jobrunNameMaxLength - 25 - 1;
    
      throw new Error(`CE_APP must be at most ${maxLength} characters for compact terminal IDs`);
    }

    if (!terminalIdPattern.test(id)) {
      throw new Error("Generated jobrun name is invalid");
    }
    
    return id;
  },

  getJobrunName(id: string): string {
    if (!terminalIdPattern.test(id)) {
      throw new Error("Terminal ID is invalid for a Code Engine jobrun name");
    }

    const name = `${this.jobName}-${id}`;
    
    if (name.length > jobrunNameMaxLength) {
      throw new Error("Terminal ID is invalid for a Code Engine jobrun name");
    }
    
    return name;
  },
};

export function validateConfiguration(): void {
}
