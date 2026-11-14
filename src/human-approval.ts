import type { ExtensionContextLike, ClassifierDecision, ReviewSubject } from "./types.js";
import type { CommandRule } from "./command-rules.js";
import { getString, stableStringify, toRecord } from "./common.js";
import { getPathFromInput } from "./tool-routing.js";

export type HumanDecision =
  | { approved: true; persistence: "once" | "exact" }
  | { approved: false; reason?: string; state: "reject" | "stop" | "timeout" | "unavailable" };

const ALLOW_ONCE = "Allow Once";
const ALLOW_EXACT = "Allow Always This Exact Action";
const REJECT = "Reject";
const REJECT_WITH_REASON = "Reject With Reason";
const REJECT_AND_STOP = "Reject and Stop the Turn";

/**
 * Quote supplied text for the terminal, not for execution or classifier input.
 * Bound the escaped content, without cutting an escape or a Unicode code point.
 */
function displayValue(value: string, maxLength = 240): string {
  let rendered = "";
  for (const character of value) {
    let escaped: string;
    switch (character) {
      case '"':
      case "\\":
        escaped = `\\${character}`;
        break;
      case "\n":
        escaped = "\\n";
        break;
      case "\r":
        escaped = "\\r";
        break;
      case "\t":
        escaped = "\\t";
        break;
      default: {
        // Includes ANSI/OSC introducers, bidi and invisible format controls,
        // Unicode line separators, and lone surrogates.
        // for...of yields nonempty strings, so the first code point exists.
        const code = character.codePointAt(0) as number;
        escaped = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Cs}]/u.test(character)
          ? code <= 0xffff
            ? `\\u${code.toString(16).padStart(4, "0")}`
            : `\\u{${code.toString(16)}}`
          : character;
      }
    }
    if (rendered.length + escaped.length > maxLength) {
      return `"${rendered}" [truncated]`;
    }
    rendered += escaped;
  }
  return `"${rendered}"`;
}

function displayAction(subject: ReviewSubject): string {
  // The shared summary has already collapsed whitespace and is also sent to
  // the classifier. Render from the original arguments so filenames retain
  // visible newlines/tabs, without changing that summary or approval hashes.
  const command = subject.toolName === "bash" ? getString(toRecord(subject.input).command) : undefined;
  return displayValue(command ?? getPathFromInput(subject.input) ?? stableStringify(subject.input), 512);
}

function formatDecision(decision?: ClassifierDecision): string {
  if (!decision) {
    return "";
  }
  return [
    decision.risk_level ? `Risk: ${displayValue(decision.risk_level)}` : null,
    decision.user_authorization ? `Authorization: ${displayValue(decision.user_authorization)}` : null,
    decision.rationale ? `Reason: ${displayValue(decision.rationale, 512)}` : null,
  ]
    .filter(Boolean)
    .join("\n");
}

export async function requestHumanApproval(
  ctx: ExtensionContextLike,
  subject: ReviewSubject,
  options: {
    title?: string;
    classifierDecision?: ClassifierDecision;
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
      : rule?.outcome === "ask"
        ? "A command rule asks you to approve this action."
        : "This action needs your approval.";
  const details = [
    intro,
    "",
    `Tool: ${displayValue(subject.toolName)}`,
    `Action: ${displayAction(subject)}`,
    rule ? `Rule: ${displayValue(rule.id)} (${displayValue(rule.outcome)}, ${displayValue(rule.source)})` : null,
    rule?.why ? `Why: ${displayValue(rule.why, 512)}` : null,
    options.failureReason ? `Failure: ${displayValue(options.failureReason, 512)}` : null,
    formatDecision(options.classifierDecision),
    "",
    options.classifierDecision || options.failureReason ? "Override this decision?" : "Allow it?",
  ]
    .filter((line) => line !== null)
    .join("\n");

  const choices = [ALLOW_ONCE, ALLOW_EXACT, REJECT, REJECT_WITH_REASON, ...(ctx.abort ? [REJECT_AND_STOP] : [])];
  // The cursor starts on Reject, so Enter without reading rejects. When
  // OMP's selector times out it chooses the highlighted option, whichever the
  // user moved to; it calls onTimeout first, so an answer after that is the
  // timeout's, not the user's, and rejects.
  // Set by onTimeout while select() waits; typed boolean, since the compiler
  // can't see a callback's assignment and would treat it as always false.
  let timedOut = false as boolean;
  const title = options.title === undefined ? "omp-callgate" : displayValue(options.title, 120);
  const selected = await ctx.ui.select(`${title}\n${details}`, choices, {
    timeout: options.timeoutSeconds * 1000,
    onTimeout: () => {
      timedOut = true;
    },
    initialIndex: choices.indexOf(REJECT),
  });

  if (timedOut || !selected) {
    return { approved: false, state: "timeout", reason: "Manual approval timed out." };
  }
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
  return { approved: false, state: "reject" };
}
