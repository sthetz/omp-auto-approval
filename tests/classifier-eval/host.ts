import { completeSimple } from "@oh-my-pi/pi-ai";
import type { ClassifierClient } from "../../src/classifier.js";
import { canonicalContext } from "../../src/omp-host.js";
import { executeEval } from "./cli.js";

interface HostApi {
  on(event: "session_start", handler: (event: unknown, context: unknown) => Promise<void>): void;
}

// The launcher starts a disposable print-mode session. Exit from session_start,
// before OMP can submit its prompt to an agent model.
export default function classifierEvalHost(omp: HostApi): void {
  omp.on("session_start", async (_event, context) => {
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
  });
}
