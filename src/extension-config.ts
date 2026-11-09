import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AutoReviewConfig, AutoReviewMode } from "./types.js";
import { toRecord } from "./common.js";
import { allowlistEntryProblem } from "./safe-command.js";

export const EXTENSION_ID = "omp-auto-approval";

export const DEFAULT_CONFIG: AutoReviewConfig = {
  enabled: false,
  mode: "fallback",
  classifierModel: null,
  approvalTimeoutSeconds: 30,
  classifierTimeoutSeconds: 25,
  maxConsecutiveDenials: 3,
  safeCommandAllowlist: [],
  blockCommands: [],
  readRoots: [],
  reviewExemptTools: [],
  allow: [],
  deny: [],
  environment: "",
  audit: true,
};

// Versions before 0.3.0 wrote every default into the config file, so the old
// 90 s classifier timeout is frozen into existing installs. OMP blocks a tool
// call whose extension handler runs past extensionHandlers.toolCallTimeoutMs
// (30 s by default), so read that value as "use the default".
const LEGACY_DEFAULT_CLASSIFIER_TIMEOUT_SECONDS = 90;
const OMP_DEFAULT_HANDLER_TIMEOUT_SECONDS = 30;

// Always written, so the file shows the current state at a glance.
const ALWAYS_SAVED_KEYS: Array<keyof AutoReviewConfig> = ["enabled", "mode"];

export function extensionRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export function configPath(): string {
  return process.env.PI_AUTO_APPROVAL_CONFIG_PATH?.trim()
    || process.env.PI_AUTO_REVIEW_CONFIG_PATH?.trim()
    || join(extensionRoot(), "config.jsonc");
}

export function logsDir(): string {
  return process.env.PI_AUTO_APPROVAL_LOGS_DIR?.trim()
    || process.env.PI_AUTO_REVIEW_LOGS_DIR?.trim()
    || join(extensionRoot(), "logs");
}

export function logPath(): string {
  return join(logsDir(), `${EXTENSION_ID}.jsonl`);
}

function stripJsonComments(input: string): string {
  return input
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function positiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeMode(value: unknown): AutoReviewMode {
  return value === "auto" ? "auto" : "fallback";
}

export function normalizeConfig(raw: unknown): AutoReviewConfig {
  const record = toRecord(raw);
  return {
    enabled: record.enabled === true,
    mode: normalizeMode(record.mode),
    classifierModel: typeof record.classifierModel === "string" && record.classifierModel.trim()
      ? record.classifierModel.trim()
      : null,
    approvalTimeoutSeconds: positiveNumber(record.approvalTimeoutSeconds, DEFAULT_CONFIG.approvalTimeoutSeconds),
    classifierTimeoutSeconds: record.classifierTimeoutSeconds === LEGACY_DEFAULT_CLASSIFIER_TIMEOUT_SECONDS
      ? DEFAULT_CONFIG.classifierTimeoutSeconds
      : positiveNumber(record.classifierTimeoutSeconds, DEFAULT_CONFIG.classifierTimeoutSeconds),
    maxConsecutiveDenials: positiveNumber(record.maxConsecutiveDenials, DEFAULT_CONFIG.maxConsecutiveDenials),
    safeCommandAllowlist: stringArray(record.safeCommandAllowlist),
    blockCommands: stringArray(record.blockCommands),
    readRoots: stringArray(record.readRoots),
    reviewExemptTools: stringArray(record.reviewExemptTools),
    allow: stringArray(record.allow),
    deny: stringArray(record.deny),
    environment: typeof record.environment === "string" ? record.environment : "",
    audit: record.audit !== false,
  };
}

/** Top-level keys that normalizeConfig would silently drop, e.g. typos. */
export function unknownConfigKeys(raw: unknown): string[] {
  const known = new Set([...Object.keys(DEFAULT_CONFIG), "$schema"]);
  return Object.keys(toRecord(raw)).filter((key) => !known.has(key));
}

/**
 * The config as written to disk: only values that differ from the defaults,
 * plus ALWAYS_SAVED_KEYS, so later default changes reach existing installs.
 */
export function serializeConfig(config: AutoReviewConfig): string {
  const normalized = normalizeConfig(config);
  const saved: Partial<Record<keyof AutoReviewConfig, unknown>> = {};
  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof AutoReviewConfig>) {
    if (ALWAYS_SAVED_KEYS.includes(key) || JSON.stringify(normalized[key]) !== JSON.stringify(DEFAULT_CONFIG[key])) {
      saved[key] = normalized[key];
    }
  }
  return `${JSON.stringify(saved, null, 2)}\n`;
}

function configNotices(path: string, raw: unknown, config: AutoReviewConfig): string[] {
  const notices: string[] = [];
  const unknownKeys = unknownConfigKeys(raw);
  if (unknownKeys.length > 0) {
    notices.push(`omp-auto-approval config at '${path}' has unknown key(s) that are ignored: ${unknownKeys.join(", ")}.`);
  }
  for (const entry of config.safeCommandAllowlist) {
    const problem = allowlistEntryProblem(entry);
    if (problem) {
      notices.push(`safeCommandAllowlist entry "${entry}" is ignored: ${problem}.`);
    }
  }
  if (config.classifierTimeoutSeconds >= OMP_DEFAULT_HANDLER_TIMEOUT_SECONDS) {
    notices.push(
      `classifierTimeoutSeconds is ${config.classifierTimeoutSeconds}s, but OMP blocks a tool call whose extension handler runs longer than `
      + `extensionHandlers.toolCallTimeoutMs (${OMP_DEFAULT_HANDLER_TIMEOUT_SECONDS}s by default). Raise that OMP setting above it, or slow reviews are blocked before the classifier answers and fallback mode never asks you.`,
    );
  }
  return notices;
}

export function loadConfig(path = configPath()): { config: AutoReviewConfig; warning?: string; notice?: string; created: boolean } {
  let created = false;
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serializeConfig(DEFAULT_CONFIG), "utf-8");
    created = true;
  }

  try {
    const parsed = JSON.parse(stripJsonComments(readFileSync(path, "utf-8")));
    const config = normalizeConfig(parsed);
    const notices = configNotices(path, parsed, config);
    return {
      config,
      created,
      ...(notices.length > 0 ? { notice: notices.join("\n") } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: { ...DEFAULT_CONFIG },
      created,
      warning: `Failed to read omp-auto-approval config at '${path}': ${message}; using defaults.`,
    };
  }
}

export function saveConfig(config: AutoReviewConfig, path = configPath()): { success: boolean; error?: string } {
  const tmpPath = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(tmpPath, serializeConfig(config), "utf-8");
    renameSync(tmpPath, path);
    return { success: true };
  } catch (error) {
    try {
      if (existsSync(tmpPath)) {
        unlinkSync(tmpPath);
      }
    } catch {
      // ignore cleanup
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
