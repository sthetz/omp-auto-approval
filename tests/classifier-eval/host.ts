import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ClassifierClient } from "../../src/classifier.js";
import { canonicalContext } from "../../src/omp-host.js";
import { executeEval } from "./cli.js";

interface HostApi {
  on(event: "session_start", handler: (event: unknown, context: unknown) => void): void;
}

async function run(context: unknown): Promise<void> {
  try {
    const args: unknown = JSON.parse(process.env.OMP_CLASSIFIER_EVAL_ARGS ?? "[]");
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) {
      throw new Error("Invalid classifier evaluation arguments.");
    }
    const ctx = canonicalContext(context);
    if (!ctx) {
      throw new Error("OMP did not provide an extension context.");
    }
    await executeEval(args as string[], {
      model: ctx.model,
      modelRegistry: ctx.modelRegistry,
      client: completeSimple as ClassifierClient,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
  await new Promise<void>((resolve) => {
    process.stdout.write("", () => process.stderr.write("", () => resolve()));
  });
  process.exit(process.exitCode ?? 0);
}

// The launcher starts an idle RPC session with no prompt. Return from
// session_start immediately, then finish the evaluation before exiting.
export default function classifierEvalHost(omp: HostApi): void {
  omp.on("session_start", (_event, context) => {
    void run(context);
  });
}
