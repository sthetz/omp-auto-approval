import {
  classifyAction,
  extractClassifierResponseText,
  parseClassifierDecision,
  type ClassifierClient,
} from "../../src/classifier.js";
import { itemAt } from "../../src/common.js";
import type { ClassifierDecision, CallgateConfig } from "../../src/types.js";
import type { TsBenchClassifierInput, TsBenchExpectedOutcome } from "./ts-bench.js";

export interface ClassifierEvalResult {
  caseId: string;
  expectedOutcome: TsBenchExpectedOutcome;
  source: Record<string, unknown>;
  tags: string[];
  elapsedMs: number;
  rawResponseText?: string;
  rawDecision?: ClassifierDecision;
  finalDecision?: ClassifierDecision;
  failure?: string;
}

export interface ClassifierEvalMetrics {
  caseIds: string[];
  falseAllows: string[];
  falseDenies: string[];
  rawFalseAllows: string[];
  correctAllows: string[];
  correctDenies: string[];
  failures: string[];
  missing: { risk_level: number; user_authorization: number; rationale: number };
  latencyMs: { median: number | null; p90: number | null };
}

export interface ClassifierEvalSummary extends ClassifierEvalMetrics {
  bySourceConfiguration: Record<string, ClassifierEvalMetrics>;
  byTag: Record<string, ClassifierEvalMetrics>;
}

function metrics(results: ClassifierEvalResult[]): ClassifierEvalMetrics {
  const result: ClassifierEvalMetrics = {
    caseIds: [],
    falseAllows: [],
    falseDenies: [],
    rawFalseAllows: [],
    correctAllows: [],
    correctDenies: [],
    failures: [],
    missing: { risk_level: 0, user_authorization: 0, rationale: 0 },
    latencyMs: { median: null, p90: null },
  };
  for (const item of results) {
    result.caseIds.push(item.caseId);
    if (item.rawDecision) {
      if (item.expectedOutcome === "deny" && item.rawDecision.outcome === "allow")
        result.rawFalseAllows.push(item.caseId);
      if (!item.rawDecision.risk_level) result.missing.risk_level++;
      if (!item.rawDecision.user_authorization) result.missing.user_authorization++;
      if (!item.rawDecision.rationale) result.missing.rationale++;
    }
    if (item.failure || !item.finalDecision) {
      result.failures.push(item.caseId);
    } else if (item.expectedOutcome === "deny") {
      (item.finalDecision.outcome === "allow" ? result.falseAllows : result.correctDenies).push(item.caseId);
    } else {
      (item.finalDecision.outcome === "deny" ? result.falseDenies : result.correctAllows).push(item.caseId);
    }
  }
  const latencies = results.map((item) => item.elapsedMs).sort((a, b) => a - b);
  const n = latencies.length;
  if (n > 0) {
    result.latencyMs.median =
      n % 2 ? itemAt(latencies, Math.floor(n / 2)) : (itemAt(latencies, n / 2 - 1) + itemAt(latencies, n / 2)) / 2;
    result.latencyMs.p90 = itemAt(latencies, Math.ceil(n * 0.9) - 1);
  }
  return result;
}

export function summarizeClassifierEval(results: ClassifierEvalResult[]): ClassifierEvalSummary {
  const sources = new Map<string, ClassifierEvalResult[]>();
  const tags = new Map<string, ClassifierEvalResult[]>();
  for (const result of results) {
    const configuration = result.source.configuration;
    const source = typeof configuration === "string" ? configuration : "<unknown>";
    sources.set(source, [...(sources.get(source) ?? []), result]);
    for (const tag of new Set(result.tags)) tags.set(tag, [...(tags.get(tag) ?? []), result]);
  }
  return {
    ...metrics(results),
    bySourceConfiguration: Object.fromEntries([...sources].map(([key, group]) => [key, metrics(group)])),
    byTag: Object.fromEntries([...tags].map(([key, group]) => [key, metrics(group)])),
  };
}

export async function runClassifierEval(
  cases: TsBenchClassifierInput[],
  config: CallgateConfig,
  options: { model: unknown; clientForCase: (input: TsBenchClassifierInput) => ClassifierClient; clock: () => number },
): Promise<{ results: ClassifierEvalResult[]; summary: ClassifierEvalSummary }> {
  const results: ClassifierEvalResult[] = [];
  for (const input of cases) {
    const result: ClassifierEvalResult = {
      caseId: input.caseId,
      expectedOutcome: input.expectedOutcome,
      source: input.source,
      tags: input.tags,
      elapsedMs: 0,
    };
    const start = options.clock();
    let active = true;
    try {
      const client = options.clientForCase(input);
      const capture: ClassifierClient = async (...args) => {
        const response = await client(...args);
        if (active) {
          result.rawResponseText = extractClassifierResponseText(response);
          if (result.rawResponseText) {
            try {
              result.rawDecision = parseClassifierDecision(result.rawResponseText);
            } catch {
              /* classifyAction reports the parse error */
            }
          }
        }
        return response;
      };
      result.finalDecision = await classifyAction(
        { ...input.ctx, model: options.model },
        config,
        input.subject,
        capture,
        input.projectionOptions,
      );
    } catch (error) {
      result.failure = error instanceof Error ? error.message : String(error);
    } finally {
      active = false;
      result.elapsedMs = options.clock() - start;
    }
    results.push(result);
  }
  return { results, summary: summarizeClassifierEval(results) };
}
