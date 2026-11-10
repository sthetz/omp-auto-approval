import type { ReviewDecision } from "./types.js";

export class SessionApprovalStore {
  private readonly approvedExactActions = new Set<string>();
  private readonly classifierDecisions = new Map<string, ReviewDecision>();
  private consecutiveDenials = 0;
  // Why the session's shell may now run code on its own (see shellHook).
  private shellHookReason: string | null = null;

  approveExact(actionHash: string): void {
    this.approvedExactActions.add(actionHash);
    this.recordNonDenial();
  }

  isExactApproved(actionHash: string): boolean {
    return this.approvedExactActions.has(actionHash);
  }

  getCachedDecision(actionHash: string): ReviewDecision | undefined {
    return this.classifierDecisions.get(actionHash);
  }

  cacheDecision(actionHash: string, decision: ReviewDecision): void {
    this.classifierDecisions.set(actionHash, decision);
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
   */
  latchShell(reason: string): void {
    this.shellHookReason ??= reason;
  }

  shellLatch(): string | null {
    return this.shellHookReason;
  }

  /** Forget approvals and cached decisions. The shell, and so its latch, outlives them. */
  clear(): void {
    this.approvedExactActions.clear();
    this.classifierDecisions.clear();
    this.consecutiveDenials = 0;
  }

  /** A new session, with a new shell. */
  reset(): void {
    this.clear();
    this.shellHookReason = null;
  }
}
