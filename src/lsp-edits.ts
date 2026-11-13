import { closeSync, openSync, readSync, statSync } from "node:fs";
import { isRecord, resolvePathForCwd, stableStringify } from "./common.js";
import { isExecutableFile, startsAsProgram, workspaceWriteTarget } from "./tool-routing.js";

// Preview-then-apply for OMP's lsp `rename` and `rename_file`. The language
// server decides which files an applied edit changes, after this extension
// decides on the call, and OMP writes them without a path check. A preview
// (`apply: false`) lists those files without changing anything. When every
// file it lists could be written without review anyway, an apply with the
// same arguments, in the same session and directory, may skip review too,
// as long as no call that could change files ran in between: the server
// then sees the same code and gives the same answer. (Even a write the
// agent may make without review could make the same arguments mean another
// symbol, one declared outside the workspace.) After the apply, its result
// is compared with the preview; any difference, or a result that cannot be
// read, is reported and turns this fast path off for the session.
//
// Everything here reads the text OMP 18.18.8's lsp tool prints, so an
// unknown line makes a preview unusable and an apply's result unverified.

const EDIT_ACTIONS = new Set(["rename", "rename_file"]);
const EDIT_FIELDS = new Set(["action", "file", "line", "symbol", "new_name", "apply", "timeout"]);

// A new symbol name: letters, digits, `_` and `$`, not starting with a
// digit. A rename writes it at every reference, so any other text could
// put code there.
const IDENTIFIER = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;

export function isLspEdit(input: unknown): input is Record<string, unknown> & { action: string } {
  return isRecord(input) && typeof input.action === "string" && EDIT_ACTIONS.has(input.action);
}

/** A file an lsp edit may change without review: one the write fast path accepts. */
export function lspWritable(cwd: string, protectedFiles: string[]): (path: string) => boolean {
  return workspaceWriteTarget(cwd, protectedFiles);
}

/** What a preview and its apply share, as one string: session, directory, arguments. */
export function lspEditKey(input: unknown, session: string, cwd: string): string | null {
  if (!isLspEdit(input)) {
    return null;
  }
  const { action, file, line, symbol, new_name: newName } = input;
  return stableStringify({ session, cwd, action, file, line, symbol, new_name: newName });
}

export function isLspEditPreview(input: unknown): boolean {
  return isLspEdit(input) && input.apply === false;
}

/**
 * The checks on an apply call itself: the lsp tool's own fields only, an
 * identifier as the new symbol name, and for `rename_file` a move of one
 * ordinary file that is not a program (no execute bit, no `#!`) between
 * paths the write fast path accepts.
 */
export function isLspEditApply(input: unknown, cwd: string, protectedFiles: string[]): boolean {
  if (!isLspEdit(input)) {
    return false;
  }
  if (Object.keys(input).some((key) => !EDIT_FIELDS.has(key) && input[key] !== undefined)) {
    return false;
  }
  const { action, file, new_name: newName, apply } = input;
  if (apply !== undefined && apply !== true) {
    return false;
  }
  if (typeof file !== "string" || typeof newName !== "string") {
    return false;
  }
  const writable = lspWritable(cwd, protectedFiles);
  if (action === "rename") {
    return IDENTIFIER.test(newName) && writable(file);
  }
  return writable(file) && writable(newName) && isPlainFile(file, cwd);
}

function isPlainFile(path: string, cwd: string): boolean {
  try {
    if (!statSync(resolvePathForCwd(path, cwd)).isFile() || isExecutableFile(path, cwd)) {
      return false;
    }
    const file = openSync(resolvePathForCwd(path, cwd), "r");
    try {
      const start = Buffer.alloc(3);
      const read = readSync(file, start, 0, 3, 0);
      return !startsAsProgram(start.subarray(0, read).toString("latin1"));
    } finally {
      closeSync(file);
    }
  } catch {
    return false;
  }
}

// `  src/a.ts: 2 edits` (rename) or `    src/a.ts: 1 edit` (rename_file,
// under a server name).
const PREVIEW_RENAME_EDIT = /^ {2}(\S.*): (\d+) edits?$/;
const PREVIEW_FILE_EDIT = /^ {4}(\S.*): (\d+) edits?$/;
const PREVIEW_FILE_SERVER = /^ {2}[\w.@/-]+:$/;
const PREVIEW_FILE_HEADER = /^Rename preview: .+ → .+$/;
// A directory move: OMP lists the files moved as "N files under dir".
const PREVIEW_FILE_DIRECTORY = /^Rename preview: \d+ files? under /;
const PREVIEW_FILE_NONE = "  No LSP edits would be applied";

/** The files a preview lists, each with the number of edits it would make there. */
export type PreviewFiles = Map<string, number>;

/**
 * The files a preview says the edit would change, when it lists only text
 * edits, every one in a file `writable` accepts; otherwise null. Lines for
 * created, renamed or deleted files, server notes, and anything unknown
 * make the preview unusable.
 */
export function cleanPreviewFiles(
  action: string,
  text: string,
  writable: (path: string) => boolean,
): PreviewFiles | null {
  const [header, ...lines] = text.replace(/\n+$/, "").split(/\r?\n/);
  const files: PreviewFiles = new Map();
  const add = (match: RegExpExecArray | null): boolean => {
    const path = match?.[1];
    if (path === undefined || !writable(path)) {
      return false;
    }
    // rename_file lists each server's edits; OMP applies them together.
    files.set(path, (files.get(path) ?? 0) + Number(match?.[2]));
    return true;
  };
  if (action === "rename") {
    if (header !== "Rename preview:" || lines.length === 0) {
      return null;
    }
    return lines.every((line) => add(PREVIEW_RENAME_EDIT.exec(line))) ? files : null;
  }
  if (header === undefined || !PREVIEW_FILE_HEADER.test(header) || PREVIEW_FILE_DIRECTORY.test(header)) {
    return null;
  }
  if (lines.length === 1 && lines[0] === PREVIEW_FILE_NONE) {
    return files;
  }
  const known = lines.every((line) => PREVIEW_FILE_SERVER.test(line) || add(PREVIEW_FILE_EDIT.exec(line)));
  return known ? files : null;
}

const APPLIED_RENAME_EDIT = /^ {2}Applied (\d+) edit\(s\) to (.+)$/;
const APPLIED_FILE_EDIT = /^ {2}[\w.@/-]+: applied (\d+) edit\(s\) to (.+)$/;
const APPLIED_FILE_NOTE = /^ {4}note: discarded \d+ overlapping edit\(s\) from /;
// A note from a server after the move: its name, then one line of text.
const APPLIED_FILE_SERVER_NOTE = /^ {2}[\w.@/-]+: .*$/;
// Results after which OMP has changed nothing: no edits, or a check that
// failed before the server was asked ("Error: destination already exists",
// "Error: aborted rename; …", "No language server found for this action").
const NOTHING_APPLIED = /^(Rename returned no edits|Error: .*|No language server found for this .*)$/;

/**
 * Why an applied edit's result does not match its preview, or null when it
 * does: the first line that changes a file the preview did not list, makes
 * more edits there than the preview counted (OMP drops duplicate and
 * overlapping edits, so fewer is fine), or that this does not recognise. A
 * failed apply ("LSP error: …", or an error result) may have changed some
 * files before failing, so it does not match either.
 */
export function appliedEditMismatch(
  action: string,
  text: string,
  isError: boolean,
  previewFiles: PreviewFiles,
): string | null {
  const [header = "", ...lines] = text.replace(/\n+$/, "").split(/\r?\n/);
  if (isError) {
    return `the apply failed: ${header}`;
  }
  if (lines.length === 0 && NOTHING_APPLIED.test(header)) {
    return null;
  }
  const listed = (match: RegExpExecArray | null) => {
    const previewed = match?.[2] !== undefined ? previewFiles.get(match[2]) : undefined;
    return previewed !== undefined && Number(match?.[1]) <= previewed;
  };
  if (action === "rename") {
    if (header !== "Applied rename:") {
      return header;
    }
    return lines.find((line) => !listed(APPLIED_RENAME_EDIT.exec(line))) ?? null;
  }
  if (!/^Renamed .+ → .+$/.test(header)) {
    return header;
  }
  // OMP prints the edits, the move itself again, then any server notes.
  const move = `  ${header}`;
  let moved = false;
  let notes = false;
  for (const line of lines) {
    const edit = APPLIED_FILE_EDIT.exec(line);
    if (edit) {
      if (!listed(edit) || moved) {
        return line;
      }
    } else if (!moved && APPLIED_FILE_NOTE.test(line)) {
      continue;
    } else if (!moved && line === move) {
      moved = true;
    } else if (moved && !notes && line === "  Server notes:") {
      notes = true;
    } else if (!notes || !APPLIED_FILE_SERVER_NOTE.test(line)) {
      return line;
    }
  }
  return moved ? null : `${header} (no move line)`;
}

export const PREVIEW_NOTE =
  "omp-callgate: every file this edit would change can be written without review, so repeating this exact call with apply: true (same file, line, symbol and new_name) skips review once.";
