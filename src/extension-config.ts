import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClearanceConfig, Reviewer } from "./types.js";
import { toRecord } from "./common.js";

export const EXTENSION_ID = "omp-clearance";

export const DEFAULT_CONFIG: ClearanceConfig = {
  reviewer: "off",
  classifierModel: null,
  approvalTimeoutSeconds: 30,
  classifierTimeoutSeconds: 25,
  maxConsecutiveDenials: 3,
  readRoots: [],
  reviewExemptTools: [],
  allow: [],
  deny: [],
  environment: "",
  audit: true,
};

// OMP blocks a tool call whose extension handler runs past
// extensionHandlers.toolCallTimeoutMs (30 s by default).
const OMP_DEFAULT_HANDLER_TIMEOUT_SECONDS = 30;

export function extensionRoot(moduleUrl = import.meta.url): string {
  return join(dirname(fileURLToPath(moduleUrl)), "..");
}

export function configPath(): string {
  return process.env.CLEARANCE_CONFIG_PATH?.trim()
    || join(extensionRoot(), "config.jsonc");
}

export function logsDir(): string {
  return process.env.CLEARANCE_LOGS_DIR?.trim()
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

function normalizeReviewer(value: unknown): Reviewer {
  return value === "ai" || value === "manual" || value === "off" ? value : "off";
}

export function normalizeConfig(raw: unknown): ClearanceConfig {
  const record = toRecord(raw);
  return {
    reviewer: normalizeReviewer(record.reviewer),
    classifierModel: typeof record.classifierModel === "string" && record.classifierModel.trim()
      ? record.classifierModel.trim()
      : null,
    approvalTimeoutSeconds: positiveNumber(record.approvalTimeoutSeconds, DEFAULT_CONFIG.approvalTimeoutSeconds),
    classifierTimeoutSeconds: positiveNumber(record.classifierTimeoutSeconds, DEFAULT_CONFIG.classifierTimeoutSeconds),
    maxConsecutiveDenials: positiveNumber(record.maxConsecutiveDenials, DEFAULT_CONFIG.maxConsecutiveDenials),
    readRoots: stringArray(record.readRoots),
    reviewExemptTools: stringArray(record.reviewExemptTools),
    allow: stringArray(record.allow),
    deny: stringArray(record.deny),
    environment: typeof record.environment === "string" ? record.environment : "",
    audit: record.audit !== false,
  };
}

/** Top-level keys that normalizeConfig would silently drop, e.g. typos. */
// Settings that moved to rules.jsonc in 0.4.0, as the kind of rule that replaces each.
const MOVED_TO_RULES: Record<string, string> = { safeCommandAllowlist: "allow", blockCommands: "block" };

export function unknownConfigKeys(raw: unknown): string[] {
  const known = new Set([...Object.keys(DEFAULT_CONFIG), "$schema", "enabled", "mode", ...Object.keys(MOVED_TO_RULES)]);
  return Object.keys(toRecord(raw)).filter((key) => !known.has(key));
}

/**
 * The config as written to disk: only values that differ from the defaults,
 * so later default changes reach existing installs.
 */
export function serializeConfig(config: ClearanceConfig): string {
  const normalized = normalizeConfig(config);
  const saved: Partial<Record<keyof ClearanceConfig, unknown>> = {};
  for (const key of Object.keys(DEFAULT_CONFIG) as Array<keyof ClearanceConfig>) {
    if (JSON.stringify(normalized[key]) !== JSON.stringify(DEFAULT_CONFIG[key])) {
      saved[key] = normalized[key];
    }
  }
  return `${JSON.stringify(saved, null, 2)}\n`;
}

function configNotices(path: string, raw: unknown, config: ClearanceConfig): string[] {
  const notices: string[] = [];
  const unknownKeys = unknownConfigKeys(raw);
  if (unknownKeys.length > 0) {
    notices.push(`omp-clearance config at '${path}' has unknown key(s) that are ignored: ${unknownKeys.join(", ")}.`);
  }
  for (const key of ["enabled", "mode"]) {
    if (Object.prototype.hasOwnProperty.call(toRecord(raw), key)) {
      notices.push(`${key} is no longer read: set reviewer in config.jsonc only as the starting value, and use /clearance ai, /clearance manual, or /clearance off for the shared session reviewer.`);
    }
  }
  if (toRecord(raw).reviewer !== undefined && !["ai", "manual", "off"].includes(String(toRecord(raw).reviewer))) {
    notices.push(`reviewer must be "ai", "manual", or "off"; the invalid value is ignored and the default "off" is used while no reviewer-state.json exists.`);
  }
  for (const [key, kind] of Object.entries(MOVED_TO_RULES)) {
    const value = toRecord(raw)[key];
    if (Array.isArray(value) && value.length > 0) {
      notices.push(`${key} is no longer read and its ${value.length} entr${value.length === 1 ? "y is" : "ies are"} ignored: write them as ${kind} rules in rules.jsonc (see config/rules.example.jsonc).`);
    }
  }
  if (config.classifierTimeoutSeconds >= OMP_DEFAULT_HANDLER_TIMEOUT_SECONDS) {
    notices.push(
      `classifierTimeoutSeconds is ${config.classifierTimeoutSeconds}s, but OMP blocks a tool call whose extension handler runs longer than `
      + `extensionHandlers.toolCallTimeoutMs (${OMP_DEFAULT_HANDLER_TIMEOUT_SECONDS}s by default). Raise that OMP setting above it, or slow reviews are blocked before the classifier answers and the user cannot be asked.`,
    );
  }
  return notices;
}

export function loadConfig(path = configPath()): { config: ClearanceConfig; reviewerConfigured: boolean; warning?: string; notice?: string; created: boolean } {
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
      reviewerConfigured: parsed.reviewer === "ai" || parsed.reviewer === "manual" || parsed.reviewer === "off",
      created,
      ...(notices.length > 0 ? { notice: notices.join("\n") } : {}),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      config: { ...DEFAULT_CONFIG },
      reviewerConfigured: false,
      created,
      warning: `Failed to read omp-clearance config at '${path}': ${message}; using defaults.`,
    };
  }
}

export function saveConfig(config: ClearanceConfig, path = configPath()): { success: boolean; error?: string } {
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
