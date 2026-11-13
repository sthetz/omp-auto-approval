import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { configPath } from "./extension-config.js";
import { toRecord } from "./common.js";
import type { CallgateConfig, Reviewer } from "./types.js";

export type ReviewerSource = "state file" | "config.jsonc" | "default" | "invalid state file";

export interface ReviewerState {
  reviewer: Reviewer;
  source: ReviewerSource;
  path: string;
  problem?: string;
  mtimeMs: number | null;
  version: string | null;
}

export function reviewerStatePath(configFile = configPath()): string {
  return join(dirname(configFile), "reviewer-state.json");
}

function isReviewer(value: unknown): value is Reviewer {
  return value === "ai" || value === "manual" || value === "off";
}

function invalidState(path: string, mtimeMs: number | null, version: string | null, error: unknown): ReviewerState {
  const message = error instanceof Error ? error.message : String(error);
  return {
    reviewer: "manual",
    source: "invalid state file",
    path,
    mtimeMs,
    version,
    problem: `Failed to read reviewer state at '${path}': ${message}; using manual so review asks when possible and denies otherwise.`,
  };
}

/**
 * Read the shared reviewer on every call, but only re-read its contents when
 * the state file's mtime changes. Missing state uses config's starting value.
 */
export function loadReviewerState(
  config: CallgateConfig,
  reviewerConfigured: boolean,
  previous?: ReviewerState,
  path = reviewerStatePath(),
): ReviewerState {
  let mtimeMs: number | null = null;
  let version: string | null = null;
  try {
    const stats = statSync(path);
    mtimeMs = stats.mtimeMs;
    version = `${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}:${stats.size}`;
  } catch (error) {
    if (toRecord(error).code !== "ENOENT") {
      return invalidState(path, null, null, error);
    }
  }

  if (mtimeMs === null) {
    return {
      reviewer: reviewerConfigured ? config.reviewer : "off",
      source: reviewerConfigured ? "config.jsonc" : "default",
      path,
      mtimeMs,
      version,
    };
  }
  if (previous?.path === path && previous.version === version) {
    return previous;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
    const reviewer = toRecord(parsed).reviewer;
    if (!isReviewer(reviewer)) {
      throw new Error(`expected { "reviewer": "ai" | "manual" | "off" }`);
    }
    return { reviewer, source: "state file", path, mtimeMs, version };
  } catch (error) {
    return invalidState(path, mtimeMs, version, error);
  }
}

/** Persist one reviewer for every current and future OMP extension instance. */
export function saveReviewerState(
  reviewer: Reviewer,
  path = reviewerStatePath(),
): { success: boolean; error?: string } {
  const tmpPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify({ reviewer }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
    renameSync(tmpPath, path);
    return { success: true };
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup after a failed write or rename.
    }
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}
