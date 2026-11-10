import type { ExtensionContextLike, ReviewDecision, ReviewSubject } from "./types.js";
import { RULES_PROBLEM_ID, type CommandRule } from "./command-rules.js";

export type HumanDecision =
  | { approved: true; persistence: "once" | "exact" }
  | { approved: false; reason?: string; state: "reject" | "stop" | "timeout" | "unavailable" };

const ALLOW_ONCE = "Allow Once";
const ALLOW_EXACT = "Allow Always This Exact Action";
const REJECT = "Reject";
const REJECT_WITH_REASON = "Reject With Reason";
const REJECT_AND_STOP = "Reject and Stop the Turn";

function formatDecision(decision?: ReviewDecision): string {
  if (!decision) {
    return "";
  }
  return [
    decision.risk_level ? `Risk: ${decision.risk_level}` : null,
    decision.user_authorization ? `Authorization: ${decision.user_authorization}` : null,
    decision.rationale ? `Reason: ${decision.rationale}` : null,
  ].filter(Boolean).join("\n");
}

export async function requestHumanApproval(
  ctx: ExtensionContextLike,
  subject: ReviewSubject,
  options: {
    title?: string;
    classifierDecision?: ReviewDecision;
    failureReason?: string;
    // The command rule that sent this action here.
    rule?: CommandRule;
    timeoutSeconds: number;
  },
): Promise<HumanDecision> {
  if (!ctx.hasUI || !ctx.ui?.select) {
    return { approved: false, state: "unavailable", reason: "Interactive approval is unavailable." };
  }

  const { rule } = options;
  const intro = options.classifierDecision
    ? "AI review recommends blocking this action."
    : options.failureReason
      ? "AI review could not complete."
      : rule?.id === RULES_PROBLEM_ID
        ? "The command rules could not be loaded, so every bash command needs your approval until they are fixed."
        : rule?.outcome === "ask"
        ? "A command rule asks you to approve this action."
        : "This action needs your approval.";
  const details = [
    intro,
    "",
    `Tool: ${subject.toolName}`,
    `Action: ${subject.actionSummary}`,
    rule ? `Rule: ${rule.id} (${rule.outcome}, ${rule.source})` : null,
    rule?.why ? `Why: ${rule.why}` : null,
    options.failureReason ? `Failure: ${options.failureReason}` : null,
    formatDecision(options.classifierDecision),
    "",
    options.classifierDecision || options.failureReason ? "Override this decision?" : "Allow it?",
  ].filter((line) => line !== null).join("\n");

  const choices = [ALLOW_ONCE, ALLOW_EXACT, REJECT, REJECT_WITH_REASON, ...(ctx.abort ? [REJECT_AND_STOP] : [])];
  const selected = await ctx.ui.select(
    `${options.title ?? "Auto Approval"}\n${details}`,
    choices,
    { timeout: options.timeoutSeconds * 1000 },
  );

  if (selected === ALLOW_ONCE) {
    return { approved: true, persistence: "once" };
  }
  if (selected === ALLOW_EXACT) {
    return { approved: true, persistence: "exact" };
  }
  if (selected === REJECT_AND_STOP) {
    return { approved: false, state: "stop" };
  }
  if (selected === REJECT_WITH_REASON && ctx.ui.input) {
    const reason = await ctx.ui.input("Reject With Reason", "Reason shown back to the agent");
    return { approved: false, state: "reject", reason: reason?.trim() || undefined };
  }
  if (!selected) {
    return { approved: false, state: "timeout", reason: "Manual approval timed out." };
  }
  return { approved: false, state: "reject" };
}
