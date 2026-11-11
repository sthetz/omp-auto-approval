import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { logPath } from "./extension-config.js";
import type {
  AuditEntry,
  ClearanceConfig,
  LspEditMismatchEntry,
  ResultWithheldEntry,
  ShellLatchEntry,
} from "./types.js";

export async function writeAudit(
  config: ClearanceConfig,
  entry: AuditEntry | LspEditMismatchEntry | ResultWithheldEntry | ShellLatchEntry,
): Promise<void> {
  if (!config.audit) {
    return;
  }
  const path = logPath();
  try {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(
      path,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        extension: "omp-clearance",
        ...entry,
      })}\n`,
      "utf-8",
    );
  } catch {
    // Audit logging must not affect approval handling.
  }
}
