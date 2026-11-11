import { isReadTarget, type ReadRoots } from "./tool-routing.js";

// How OMP 18.18.8's lsp tool prints a location (`definition`, `references`,
// `implementation`, `type_definition`): two spaces, the path (relative to
// the session directory inside it, absolute outside), line and column. The
// source lines around it follow, indented by four spaces and numbered.
const LOCATION_LINE = /^ {2}(\S.*):(\d+):(\d+)$/;
const SOURCE_LINE = /^ {4}\d+:( |$)/;

/**
 * The first path whose source lines an `lsp` result shows but a read without
 * review may not reach, or null when there is none.
 *
 * A language server answers from every file the workspace's code refers to,
 * and the agent can write that code without review, so `definition` on an
 * import of `../secret.ts` would print the secret's line. Source lines are
 * let through only right under a location whose path passes the read fast
 * path's checks; under no location they are withheld. A path with ` @ ` in
 * it is never trusted: that is how a symbol list prints
 * `name @ path:line:column`. Paths and names without source lines
 * (locations, previews, symbol lists) are let through; hover and
 * diagnostics text, which can show a constant's value with no path, is not
 * covered (docs/fast-paths.md says so).
 *
 * This reads OMP's text output, so it only recognises source lines printed
 * as above. If OMP changed that format, they would pass unchecked; the e2e
 * scenario for this (run on every OMP upgrade) fails in that case.
 */
export function unreadableLspLocation(content: unknown, roots: ReadRoots): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  for (const part of content) {
    const text: unknown = typeof part === "object" && part !== null ? (part as { text?: unknown }).text : undefined;
    if (typeof text !== "string") {
      continue;
    }
    // The location the next source lines belong to, if any.
    let location: { path: string; readable: boolean } | null = null;
    for (const line of text.split(/\r?\n/)) {
      const match = LOCATION_LINE.exec(line);
      if (match?.[1] !== undefined) {
        const path = match[1];
        location = { path, readable: !path.includes(" @ ") && isReadTarget(path, roots) };
      } else if (SOURCE_LINE.test(line)) {
        if (!location) {
          return "(source lines under no location)";
        }
        if (!location.readable) {
          return location.path;
        }
      } else {
        location = null;
      }
    }
  }
  return null;
}

/** What the agent gets instead of a withheld result. */
export function withheldLspResultText(path: string): string {
  return [
    `omp-clearance withheld this lsp result: it shows source lines from ${path},`,
    "which a read without review may not reach (outside the workspace and readRoots, or a sensitive path).",
    "If you need that file, read it with the read tool, which is reviewed.",
  ].join(" ");
}
