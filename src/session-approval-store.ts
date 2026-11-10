import type { ClassifierDecision } from "./types.js";

export class SessionApprovalStore {
  private readonly approvedExactActions = new Set<string>();
  private readonly classifierDecisions = new Map<string, ClassifierDecision>();
  private consecutiveDenials = 0;
  // Why a session's shell may now run code on its own (see shellHook), by
  // session id: OMP keeps one shell per session.
  private readonly shellHooks = new Map<string, string>();

  approveExact(actionHash: string): void {
    this.approvedExactActions.add(actionHash);
    this.recordNonDenial();
  }

  isExactApproved(actionHash: string): boolean {
    return this.approvedExactActions.has(actionHash);
  }

  getCachedDecision(actionHash: string): ClassifierDecision | undefined {
    return this.classifierDecisions.get(actionHash);
  }

  cacheDecision(actionHash: string, decision: ClassifierDecision): void {
    this.classifierDecisions.set(actionHash, decision);
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

  /**
   * Forget approvals and cached decisions. Latches stay: a shell outlives
   * them, and a new session has its own id, so its own latch.
   */
  clear(): void {
    this.approvedExactActions.clear();
    this.classifierDecisions.clear();
    this.consecutiveDenials = 0;
  }
}
