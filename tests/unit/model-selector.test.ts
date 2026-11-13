import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ompCallgateExtension from "../../index.js";
import { loadConfig } from "../../src/extension-config.js";
import { type ExtensionContextLike } from "../../src/types.js";
import { test } from "node:test";
import { ctx } from "./helpers.js";

await test("callgate model command opens model selector and persists selection", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-config-"));
  const previousConfigPath = process.env.CALLGATE_CONFIG_PATH;
  process.env.CALLGATE_CONFIG_PATH = join(dir, "config.jsonc");
  const commandHandlers = new Map<string, (args: string, context: ExtensionContextLike) => Promise<void> | void>();
  ompCallgateExtension({
    on: () => {},
    registerCommand: (name, definition) => {
      commandHandlers.set(name, definition.handler);
    },
  });

  let title = "";
  const selectedOptions: string[][] = [];
  await commandHandlers.get("callgate")?.(
    "model",
    ctx({
      ui: {
        notify: () => {},
        select: async (nextTitle, options) => {
          title = nextTitle;
          selectedOptions.push(options);
          return "review-provider/review-model";
        },
      },
      modelRegistry: {
        getAvailable: () => [
          { provider: "review-provider", id: "review-model" },
          { provider: "other-provider", id: "other-model" },
        ],
      },
    }),
  );

  assert.match(title, /Select approval classifier model/);
  assert.deepEqual(selectedOptions[0], ["current", "other-provider/other-model", "review-provider/review-model"]);
  assert.equal(loadConfig(process.env.CALLGATE_CONFIG_PATH).config.classifierModel, "review-provider/review-model");
  rmSync(dir, { recursive: true, force: true });
  if (previousConfigPath === undefined) {
    delete process.env.CALLGATE_CONFIG_PATH;
  } else {
    process.env.CALLGATE_CONFIG_PATH = previousConfigPath;
  }
});

await test("callgate model command uses the OMP custom selector in TUI mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-config-"));
  const previousConfigPath = process.env.CALLGATE_CONFIG_PATH;
  process.env.CALLGATE_CONFIG_PATH = join(dir, "config.jsonc");
  const commandHandlers = new Map<string, (args: string, context: ExtensionContextLike) => Promise<void> | void>();
  ompCallgateExtension({
    on: () => {},
    registerCommand: (name, definition) => {
      commandHandlers.set(name, definition.handler);
    },
  });

  let rendered: string[] = [];
  let usedCustom = false;
  let usedSelect = false;
  await commandHandlers.get("callgate")?.(
    "model",
    ctx({
      mode: "tui",
      ui: {
        notify: () => {},
        select: async () => {
          usedSelect = true;
          return undefined;
        },
        custom: async (factory) =>
          new Promise((resolve) => {
            usedCustom = true;
            const component = factory(
              { requestRender: () => {} },
              { fg: (_name: string, text: string) => text },
              {},
              resolve,
            ) as { render: (width: number) => string[]; handleInput: (data: string) => void };
            rendered = component.render(80);
            component.handleInput("review-provider/review-model");
            component.handleInput("\n");
          }),
      },
      modelRegistry: {
        getAvailable: () => [
          { provider: "review-provider", id: "review-model", name: "Review Model" },
          { provider: "other-provider", id: "other-model", name: "Other Model" },
        ],
      },
    }),
  );

  assert.equal(usedCustom, true);
  assert.equal(usedSelect, false);
  assert.equal(
    rendered.some((line) => line.includes("Search:")),
    true,
  );
  assert.equal(
    rendered.some((line) => line.includes("current [callgate]")),
    true,
  );
  assert.equal(
    rendered.some((line) => line.includes("review-model [review-provider]")),
    true,
  );
  assert.equal(loadConfig(process.env.CALLGATE_CONFIG_PATH).config.classifierModel, "review-provider/review-model");
  rmSync(dir, { recursive: true, force: true });
  if (previousConfigPath === undefined) {
    delete process.env.CALLGATE_CONFIG_PATH;
  } else {
    process.env.CALLGATE_CONFIG_PATH = previousConfigPath;
  }
});

await test("model selector truncates every rendered line to the terminal width", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-config-"));
  const previousConfigPath = process.env.CALLGATE_CONFIG_PATH;
  process.env.CALLGATE_CONFIG_PATH = join(dir, "config.jsonc");
  const commandHandlers = new Map<string, (args: string, context: ExtensionContextLike) => Promise<void> | void>();
  ompCallgateExtension({
    on: () => {},
    registerCommand: (name, definition) => {
      commandHandlers.set(name, definition.handler);
    },
  });

  let rendered: string[] = [];
  await commandHandlers.get("callgate")?.(
    "model",
    ctx({
      mode: "tui",
      ui: {
        notify: () => {},
        custom: async (factory) =>
          new Promise((resolve) => {
            const component = factory(
              { requestRender: () => {} },
              { fg: (_name: string, text: string) => text },
              {},
              resolve,
            ) as { render: (width: number) => string[]; handleInput: (data: string) => void };
            // A model id long enough that the rendered row would overflow a
            // narrow terminal if lines were not truncated.
            rendered = component.render(20);
            // Resolve the custom UI promise (select the current item) so the
            // command handler can finish; otherwise the test hangs forever.
            component.handleInput("\n");
          }),
      },
      modelRegistry: {
        getAvailable: () => [
          {
            provider: "review-provider",
            id: "a-very-long-model-name-that-would-overflow-the-terminal-width",
            name: "A Very Long Model Name That Would Overflow",
          },
          { provider: "other-provider", id: "other-model", name: "Other Model" },
        ],
      },
    }),
  );

  // Wide East Asian ranges count two columns, everything else one.
  const columnWidth = (char: string): number => {
    const code = char.codePointAt(0) ?? 0;
    const wide: [number, number][] = [
      [0x1100, 0x115f],
      [0x2e80, 0xa4cf],
      [0xac00, 0xd7a3],
      [0xf900, 0xfaff],
      [0xfe30, 0xfe4f],
      [0xff00, 0xff60],
      [0xffe0, 0xffe6],
      [0x20000, 0x2fffd],
      [0x30000, 0x3fffd],
    ];
    return wide.some(([low, high]) => code >= low && code <= high) ? 2 : 1;
  };
  const lineWidth = (line: string): number => {
    let width = 0;
    for (const part of line.split(/\x1b\[[0-9;]*m/)) {
      for (const char of part) {
        width += columnWidth(char);
      }
    }
    return width;
  };
  // Regression: pi crashes with "Rendered line exceeds terminal width" when
  // a custom TUI component emits a line wider than the terminal.
  for (const line of rendered) {
    assert.ok(lineWidth(line) <= 20, `rendered line exceeds width: ${JSON.stringify(line)}`);
  }
  assert.equal(
    rendered.some((line) => line.includes("...")),
    true,
  );

  rmSync(dir, { recursive: true, force: true });
  if (previousConfigPath === undefined) {
    delete process.env.CALLGATE_CONFIG_PATH;
  } else {
    process.env.CALLGATE_CONFIG_PATH = previousConfigPath;
  }
});

await test("callgate model command does not accept model IDs as arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-callgate-config-"));
  const previousConfigPath = process.env.CALLGATE_CONFIG_PATH;
  process.env.CALLGATE_CONFIG_PATH = join(dir, "config.jsonc");
  const commandHandlers = new Map<string, (args: string, context: ExtensionContextLike) => Promise<void> | void>();
  ompCallgateExtension({
    on: () => {},
    registerCommand: (name, definition) => {
      commandHandlers.set(name, definition.handler);
    },
  });

  const notifications: string[] = [];
  const command = commandHandlers.get("callgate");
  const commandContext = ctx({ ui: { notify: (message) => notifications.push(message) } });
  await command?.("model review-model", commandContext);
  await command?.("model review-provider/review-model", commandContext);

  assert.equal(loadConfig(process.env.CALLGATE_CONFIG_PATH).config.classifierModel, null);
  assert.deepEqual(
    notifications.filter((message) => message.includes("Use /callgate model")),
    [
      "Use /callgate model to select an approval classifier model.",
      "Use /callgate model to select an approval classifier model.",
    ],
  );

  rmSync(dir, { recursive: true, force: true });
  if (previousConfigPath === undefined) {
    delete process.env.CALLGATE_CONFIG_PATH;
  } else {
    process.env.CALLGATE_CONFIG_PATH = previousConfigPath;
  }
});
