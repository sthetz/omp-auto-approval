/**
 * A fake OpenAI-compatible model server for the end-to-end runs. It plays two
 * parts, told apart by the system prompt:
 *
 * - the agent: it replays a scripted list of tool calls, one per turn, and
 *   then says "done";
 * - the approval classifier: it answers with a fixed verdict.
 *
 * Every request is recorded, so a scenario can check what the classifier was
 * shown and which tool results the agent got back.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface FakeModelOptions {
  /** The agent's tool calls, in order: step n is answered after n tool results. */
  steps: ToolCall[];
  /** Optional separate script for a child identified by its system prompt. */
  subagent?: { systemMarker: string; steps: ToolCall[] };
  /** The classifier's answer to every review. */
  verdict: "allow" | "deny";
  /** Optional classifier latency for lifecycle regression tests. */
  classifierDelayMs?: number;
}

export interface FakeModelLog {
  /** The text of the user-role messages of each classifier request. */
  classifier: string[];
  /** The tool results the agent had seen at each of its turns. */
  toolResults: string[][];
  subagentToolResults: string[][];
}

export interface FakeModel {
  url: string;
  log: FakeModelLog;
  close(): Promise<void>;
}

const CLASSIFIER_MARKER = "automatic approval reviewer";

function textOf(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        const text: unknown = part && typeof part === "object" ? (part as { text?: unknown }).text : undefined;
        return typeof text === "string" ? text : "";
      })
      .join("");
  }
  return "";
}

function chunk(delta: Record<string, unknown>, finish: string | null): string {
  const body = {
    id: "fake",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "fake-model",
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } } : {}),
  };
  return `data: ${JSON.stringify(body)}\n\n`;
}

export async function startFakeModel(options: FakeModelOptions): Promise<FakeModel> {
  const log: FakeModelLog = { classifier: [], toolResults: [], subagentToolResults: [] };
  let calls = 0;
  const server: Server = createServer((request, response) => {
    if (request.method === "GET") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
      return;
    }
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    const handleEnd = async (): Promise<void> => {
      const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as {
        messages?: { role: string; content: unknown }[];
      };
      const messages = body.messages ?? [];
      const system = messages
        .filter((message) => message.role === "system" || message.role === "developer")
        .map((message) => textOf(message.content))
        .join(" ");
      let text: string | undefined;
      let tool: ToolCall | undefined;
      if (system.includes(CLASSIFIER_MARKER)) {
        log.classifier.push(
          messages
            .filter((message) => message.role === "user")
            .map((message) => textOf(message.content))
            .join("\n"),
        );
        text = JSON.stringify({ outcome: options.verdict, rationale: `fake-${options.verdict}` });
        if (options.classifierDelayMs) await delay(options.classifierDelayMs);
      } else {
        const results = messages.filter((message) => message.role === "tool").map((message) => textOf(message.content));
        if (options.subagent && system.includes(options.subagent.systemMarker)) {
          log.subagentToolResults.push(results);
          tool = options.subagent.steps[results.length];
        } else {
          log.toolResults.push(results);
          tool = options.steps[results.length];
        }
        text = tool ? undefined : "done";
      }
      const delta: Record<string, unknown> = { role: "assistant" };
      if (text) {
        delta.content = text;
      }
      if (tool) {
        calls += 1;
        delta.tool_calls = [
          {
            index: 0,
            id: `call_${calls}`,
            type: "function",
            function: { name: tool.name, arguments: JSON.stringify(tool.arguments) },
          },
        ];
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(chunk(delta, null));
      response.write(chunk({}, tool ? "tool_calls" : "stop"));
      response.end("data: [DONE]\n\n");
    };
    request.on("end", () => {
      void handleEnd();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    log,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
