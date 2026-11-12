import type { PreviewFiles } from "./lsp-edits.js";
import type { ClassifierDecision } from "./types.js";

const MAX_CACHED_DECISIONS = 1000;

export class SessionApprovalStore {
  private readonly approvedExactActions = new Set<string>();
  private readonly classifierDecisions = new Map<string, ClassifierDecision>();
  private consecutiveDenials = 0;
  // Why a session's shell may now run code on its own (see shellHook), by
  // session id: OMP keeps one shell per session.
  private readonly shellHooks = new Map<string, string>();
  // Preview-then-apply for lsp edits (see lsp-edits.ts). A preview counts
  // only if nothing that could change files ran while it ran or since:
  // `changes` counts every call allowed that could change files, and
  // `running` holds those whose result has not come back.
  private changes = 0;
  private readonly running = new Set<string>();
  // Previews being made, by call id: the `changes` count when each started.
  private readonly previewStarts = new Map<string, number>();
  // Usable previews by lspEditKey (session, directory, arguments). Any
  // change clears them all.
  private readonly lspPreviews = new Map<string, PreviewFiles>();
  // Applies let through on a preview, by call id: the preview's files.
  private readonly lspApplies = new Map<string, PreviewFiles>();
  // Sessions where lsp edits went back to review, and why. Kept by clear(),
  // like the shell latches.
  private readonly lspEditsOff = new Map<string, string>();

  approveExact(actionHash: string): void {
    this.approvedExactActions.add(actionHash);
    this.recordNonDenial();
  }

  isExactApproved(actionHash: string): boolean {
    return this.approvedExactActions.has(actionHash);
  }

  getCachedDecision(key: string): ClassifierDecision | undefined {
    return this.classifierDecisions.get(key);
  }

  cacheDecision(key: string, decision: ClassifierDecision): void {
    // Keys include the user's latest message, so older ones go stale; keep
    // the map from growing without bound in a long session.
    if (this.classifierDecisions.size >= MAX_CACHED_DECISIONS) {
      this.classifierDecisions.clear();
    }
    this.classifierDecisions.set(key, decision);
  }

  get consecutiveDenialCount(): number {
    return this.consecutiveDenials;
  }

  recordDenial(): number {
    this.consecutiveDenials += 1;
    return this.consecutiveDenials;
  }

  recordNonDenial(): void {
    this.consecutiveDenials = 0;
  }

  /**
   * Turn the bash fast path off for the rest of the session: an approved
   * command may have left the shell running code before later commands.
   * Return whether this call set it (an earlier latch stays as it was).
   */
  latchShell(session: string, reason: string): boolean {
    if (this.shellHooks.has(session)) {
      return false;
    }
    this.shellHooks.set(session, reason);
    return true;
  }

  unlatchShell(session: string): void {
    this.shellHooks.delete(session);
  }

  shellLatch(session: string): string | null {
    return this.shellHooks.get(session) ?? null;
  }

  /** A call that could change files was allowed; its result comes back under this id. */
  noteChange(toolCallId: string | undefined): void {
    this.changes += 1;
    this.lspPreviews.clear();
    if (toolCallId !== undefined) {
      this.running.add(toolCallId);
    }
  }

  /** Any call's result came back. */
  noteResult(toolCallId: string): void {
    this.running.delete(toolCallId);
  }

  /** A preview starts: it can count only if nothing that changes files is running. */
  startLspPreview(toolCallId: string): void {
    if (this.running.size === 0) {
      this.previewStarts.set(toolCallId, this.changes);
    }
  }

  /**
   * A preview's result: remember its files if nothing that changes files
   * ran since it started, or forget an earlier preview of the same call.
   */
  finishLspPreview(toolCallId: string, key: string, files: PreviewFiles | null): boolean {
    const started = this.previewStarts.get(toolCallId);
    this.previewStarts.delete(toolCallId);
    if (files && started === this.changes) {
      this.lspPreviews.set(key, files);
      return true;
    }
    this.lspPreviews.delete(key);
    return false;
  }

  hasLspPreview(session: string, key: string): boolean {
    return !this.lspEditsOff.has(session) && this.lspPreviews.has(key) && this.running.size === 0;
  }

  /**
   * Use up a preview for the apply that repeats it, whose result is then
   * checked against it. The apply changes files itself.
   */
  startLspApply(key: string, toolCallId: string): void {
    const preview = this.lspPreviews.get(key);
    this.noteChange(toolCallId);
    if (preview) {
      this.lspApplies.set(toolCallId, preview);
    }
  }

  /** The preview files an apply was let through on, once. */
  finishLspApply(toolCallId: string): PreviewFiles | undefined {
    const files = this.lspApplies.get(toolCallId);
    this.lspApplies.delete(toolCallId);
    return files;
  }

  /** Forget classifier verdicts: what they were based on changed (the rules files). */
  clearClassifierCache(): void {
    this.classifierDecisions.clear();
  }

  turnLspEditsOff(session: string, reason: string): void {
    if (!this.lspEditsOff.has(session)) {
      this.lspEditsOff.set(session, reason);
    }
    this.lspPreviews.clear();
  }

  lspEditsAreOff(session: string): boolean {
    return this.lspEditsOff.has(session);
  }

  /**
   * Forget approvals, cached decisions and lsp edit previews. Latches stay:
   * a shell outlives them, and a new session has its own id, so its own
   * latch. So do calls still running (see noteChange).
   */
  clear(): void {
    this.approvedExactActions.clear();
    this.classifierDecisions.clear();
    this.consecutiveDenials = 0;
    // Calls already running, and applies waiting for their result, may
    // still finish after this; their state stays, like the shell latches.
    this.lspPreviews.clear();
  }
}
