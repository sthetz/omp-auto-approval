import { dictionary } from "./common.js";
/**
 * JSON with comments (`//`, `/* … *\/`) and trailing commas, for files people
 * write by hand. Stricter than JSON.parse in one way: a key repeated in an
 * object is an error, not silently the last value, so a rule written twice
 * cannot hide the first.
 */

export class JsoncError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} at line ${line}, column ${column}`);
  }
}

export function parseJsonc(text: string): unknown {
  let index = 0;

  const fail = (message: string): never => {
    const before = text.slice(0, index).split("\n");
    throw new JsoncError(message, before.length, (before.at(-1) ?? "").length + 1);
  };

  const skip = () => {
    while (index < text.length) {
      const char = text[index];
      if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "﻿") {
        index += 1;
      } else if (text.startsWith("//", index)) {
        const end = text.indexOf("\n", index);
        index = end < 0 ? text.length : end + 1;
      } else if (text.startsWith("/*", index)) {
        const end = text.indexOf("*/", index + 2);
        if (end < 0) {
          fail("unterminated comment");
        }
        index = end + 2;
      } else {
        break;
      }
    }
  };

  const string = (): string => {
    const start = index;
    index += 1;
    while (index < text.length && text[index] !== '"') {
      if (text[index] === "\n") {
        fail("line break in a string");
      }
      index += text[index] === "\\" ? 2 : 1;
    }
    if (index >= text.length) {
      fail("unterminated string");
    }
    index += 1;
    try {
      return JSON.parse(text.slice(start, index)) as string;
    } catch {
      index = start;
      return fail("invalid string");
    }
  };

  const value = (): unknown => {
    skip();
    const char = text[index];
    if (char === "{") {
      index += 1;
      const object = dictionary<unknown>();
      skip();
      while (text[index] !== "}") {
        if (text[index] !== '"') {
          fail("expected a key in double quotes");
        }
        const keyStart = index;
        const key = string();
        if (Object.hasOwn(object, key)) {
          index = keyStart;
          fail(`duplicate key "${key}"`);
        }
        skip();
        if (text[index] !== ":") {
          fail("expected ':'");
        }
        index += 1;
        object[key] = value();
        skip();
        if (text[index] === ",") {
          index += 1;
          skip();
        } else if (text[index] !== "}") {
          fail("expected ',' or '}'");
        }
      }
      index += 1;
      return object;
    }
    if (char === "[") {
      index += 1;
      const array: unknown[] = [];
      skip();
      while (text[index] !== "]") {
        array.push(value());
        skip();
        if (text[index] === ",") {
          index += 1;
          skip();
        } else if (text[index] !== "]") {
          fail("expected ',' or ']'");
        }
      }
      index += 1;
      return array;
    }
    if (char === '"') {
      return string();
    }
    const literal = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(
      text.slice(index, index + 64),
    );
    if (!literal) {
      return fail(index >= text.length ? "unexpected end of file" : `unexpected '${char}'`);
    }
    index += literal[0].length;
    return JSON.parse(literal[0]);
  };

  const result = value();
  skip();
  if (index < text.length) {
    fail(`unexpected '${text[index]}'`);
  }
  return result;
}
