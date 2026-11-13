import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type { ClassifierClient } from "../../src/classifier.js";
import { DEFAULT_CONFIG, extensionRoot } from "../../src/extension-config.js";
import { buildSystemPrompt } from "../../src/prompt.js";
import type { ExtensionContextLike } from "../../src/types.js";
import { runClassifierEval, type ClassifierEvalMetrics, type ClassifierEvalSummary } from "./run.js";
import { adaptTsBenchShortlist, parseTsBenchShortlist } from "./ts-bench.js";

export const USAGE = "Usage: npm run eval:classifier -- --cases <path> --output <path> [--model <provider/id>]";

export function parseArgs(args: string[]): { cases: string; output: string; model?: string } | null {
  if (args.length === 1 && args[0] === "--help") return null;
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag || !["--cases", "--output", "--model"].includes(flag) || values[flag] !== undefined) {
      throw new Error(`Invalid argument: ${flag ?? ""}\n${USAGE}`);
    }
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${flag}\n${USAGE}`);
    values[flag] = value;
  }
  if (!values["--cases"] || !values["--output"]) throw new Error(`--cases and --output are required\n${USAGE}`);
  return {
    cases: values["--cases"],
    output: values["--output"],
    ...(values["--model"] ? { model: values["--model"] } : {}),
  };
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function counts(m: ClassifierEvalMetrics): string {
  const ids = (items: string[]) => `${items.length}${items.length ? ` [${items.join(", ")}]` : ""}`;
  return `cases ${m.caseIds.length}; raw false allows ${ids(m.rawFalseAllows)}; final false allows ${ids(m.falseAllows)}; false denies ${ids(m.falseDenies)}; failures ${ids(m.failures)}; correct allows ${m.correctAllows.length}; correct denies ${m.correctDenies.length}; missing risk_level ${m.missing.risk_level}, user_authorization ${m.missing.user_authorization}, rationale ${m.missing.rationale}; latency median ${m.latencyMs.median ?? "n/a"} ms, p90 ${m.latencyMs.p90 ?? "n/a"} ms`;
}

export function formatSummary(summary: ClassifierEvalSummary): string {
  return [
    `Classifier eval: ${counts(summary)}`,
    "Source configuration:",
    ...Object.entries(summary.bySourceConfiguration).map(([name, m]) => `  ${name}: ${counts(m)}`),
    "Tags:",
    ...Object.entries(summary.byTag).map(([name, m]) => `  ${name}: ${counts(m)}`),
  ].join("\n");
}

interface EvalHost {
  model: unknown;
  modelRegistry?: ExtensionContextLike["modelRegistry"];
  client: ClassifierClient;
}

export async function executeEval(
  args: string[],
  host: EvalHost,
  hooks: { now?: () => Date; clock?: () => number; print?: (text: string) => void } = {},
): Promise<void> {
  const parsed = parseArgs(args);
  const print = hooks.print ?? console.log;
  if (!parsed) {
    print(USAGE);
    return;
  }
  const modelRecord = host.model && typeof host.model === "object" ? (host.model as Record<string, unknown>) : {};
  const activeRef =
    typeof modelRecord.provider === "string" && typeof modelRecord.id === "string"
      ? `${modelRecord.provider}/${modelRecord.id}`
      : null;
  const modelRef = parsed.model ?? activeRef;
  if (!modelRef) throw new Error("No active model; specify --model <provider/id>.");
  const slash = modelRef.indexOf("/");
  if (slash <= 0 || slash === modelRef.length - 1) throw new Error("Model must be a provider/id reference.");
  const model = parsed.model
    ? host.modelRegistry?.find?.(modelRef.slice(0, slash), modelRef.slice(slash + 1))
    : host.model;
  if (!model) throw new Error(`Model not found in OMP registry: ${modelRef}`);

  const dataset = readFileSync(parsed.cases);
  const cases = parseTsBenchShortlist(dataset.toString("utf8"));
  // Source metadata comes from the input file, not the runtime or model registry.
  const allowedSourceKeys = [
    "configuration",
    "dataset",
    "id",
    "license",
    "original_score",
    "revision",
    "source_file",
    "source_row",
    "source_sha256",
  ];
  for (const item of cases) {
    item.source = Object.fromEntries(
      Object.entries(item.source).filter(
        ([key, value]) => allowedSourceKeys.includes(key) && (typeof value === "string" || typeof value === "number"),
      ),
    );
  }
  const revisions = [
    ...new Set(cases.map((item) => item.source.revision).filter((value): value is string => typeof value === "string")),
  ].sort();
  const config = { ...DEFAULT_CONFIG, classifierModel: null };
  const inputs = adaptTsBenchShortlist(cases);
  const registry = host.modelRegistry;
  for (const input of inputs) {
    if (registry?.getApiKeyAndHeaders) {
      const resolveAuth = registry.getApiKeyAndHeaders;
      input.ctx.modelRegistry = {
        getApiKeyAndHeaders: async (selected) => {
          try {
            const auth = await resolveAuth.call(registry, selected);
            return auth.ok ? auth : { ok: false, error: "auth resolution failed" };
          } catch {
            return { ok: false, error: "auth resolution failed" };
          }
        },
      };
    }
  }
  const secrets = new Set<string>();
  const client: ClassifierClient = async (selected, context, options) => {
    const collect = (value: unknown) => {
      if (typeof value === "string" && value.length > 0) secrets.add(value);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    };
    collect(options.apiKey);
    collect(options.headers);
    collect(options.env);
    return host.client(selected, context, options);
  };
  const { results, summary } = await runClassifierEval(inputs, config, {
    model,
    clientForCase: () => client,
    clock: hooks.clock ?? (() => performance.now()),
  });
  const root = extensionRoot();
  const git = (...argv: string[]) => execFileSync("git", argv, { cwd: root, encoding: "utf8" }).trim();
  const artifact = {
    metadata: {
      datasetSha256: sha256(dataset),
      sourceRevisions: revisions,
      codeRevision: git("rev-parse", "HEAD"),
      treeDirty: Boolean(git("status", "--porcelain", "--untracked-files=normal")),
      systemPromptSha256: sha256(buildSystemPrompt(config)),
      model: modelRef,
      temperature: 0,
      timeoutSeconds: config.classifierTimeoutSeconds,
      timestamp: (hooks.now ?? (() => new Date()))().toISOString(),
      inferenceSettings: { temperature: 0, timeoutSeconds: config.classifierTimeoutSeconds },
    },
    results,
    summary,
  };
  // Provider error text or model output can echo request credentials. Keep the
  // raw response except for credentials actually passed to the client.
  const redact = (text: string) =>
    [...secrets].sort((a, b) => b.length - a.length).reduce((s, secret) => s.split(secret).join("[REDACTED]"), text);
  mkdirSync(dirname(resolve(parsed.output)), { recursive: true });
  const json = JSON.stringify(
    artifact,
    (_key, value: unknown) => (typeof value === "string" ? redact(value) : value),
    2,
  );
  writeFileSync(parsed.output, `${json}\n`, "utf8");
  print(redact(formatSummary(summary)));
}
