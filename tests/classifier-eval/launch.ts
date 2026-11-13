import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
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
// Keep normal extension discovery: providers such as llm-gw are registered by
// user extensions. The explicit eval host still exits before an agent turn.
const args = ["--no-session", "--no-skills", "--no-rules", "--no-context-files", "-e", host];
const bootstrapModel = process.env.OMP_CLASSIFIER_EVAL_MODEL || requestedModel;
if (bootstrapModel) {
  args.push("--model", bootstrapModel);
}
args.push("--mode", "rpc", "--no-ui");
const child = spawn(process.env.OMP || "omp", args, {
  // Keep RPC stdin open without sending a prompt or any other command.
  stdio: ["pipe", "pipe", "inherit"],
  env: { ...process.env, OMP_CLASSIFIER_EVAL_ARGS: JSON.stringify(process.argv.slice(2)) },
});
const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
lines.on("line", (line) => {
  // OMP's JSONL protocol shares stdout with the eval host's report.
  if (!line.startsWith('{"type":')) process.stdout.write(`${line}\n`);
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
