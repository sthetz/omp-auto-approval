import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseArgs, USAGE } from "./cli.js";

let requestedModel: string | undefined;
try {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed) {
    console.log(USAGE);
    process.exit(0);
  }
  requestedModel = parsed.model;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

const host = fileURLToPath(new URL("./host.ts", import.meta.url));
const args = ["--no-session", "--no-extensions", "--no-skills", "--no-rules", "--no-context-files", "-e", host];
const bootstrapModel = process.env.OMP_CLASSIFIER_EVAL_MODEL || requestedModel;
if (bootstrapModel) {
  args.push("--model", bootstrapModel);
}
args.push("-p", "classifier evaluation");
const child = spawn(process.env.OMP || "omp", args, {
  stdio: "inherit",
  env: { ...process.env, OMP_CLASSIFIER_EVAL_ARGS: JSON.stringify(process.argv.slice(2)) },
});
child.on("error", (error) => {
  console.error(`Could not start OMP: ${error.message}`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`OMP terminated by ${signal}`);
    process.exitCode = 1;
  } else if (code !== null) {
    process.exitCode = code;
  }
});
