/**
 * A recognizer for a small, safe subset of bash (5.3, non-interactive).
 *
 * It does not try to parse bash. It accepts only commands whose meaning it can
 * state exactly, and returns null for anything else, which callers send to
 * review. Accepted: simple commands made of literal or quoted words, joined
 * into pipelines with `|` and into lists with `&&`, `||`, `;` and newlines,
 * with comments and a few redirections. Rejected: every expansion that runs
 * code or reads variables (`$`, backticks), subshells and groups, background
 * jobs, heredocs, reserved words, and assignments before a command.
 *
 * Its reading is checked against bash itself by tests/shell-oracle/.
 */

export interface ShellWord {
  // The word after quote removal.
  text: string;
  // The shell rewrites it before the program sees it: an unquoted glob or
  // brace character, or a tilde bash expands. Its final text is unknown.
  expands: boolean;
  // It contains quotes or backslashes, so bash does not treat it as a
  // reserved word or an alias.
  quoted: boolean;
  // It starts with an unquoted `name=`, `name+=` or `name[`: before the
  // program, bash would take it as a variable assignment.
  assignment: boolean;
  // Where the word, quotes included, sits in the command string.
  start: number;
  end: number;
}

export interface ShellRedirect {
  fd: number;
  kind: "write" | "append" | "read" | "duplicate";
  // A file path for write/append/read; the source fd for duplicate.
  target: string;
}

export interface ShellCommand {
  words: ShellWord[];
  redirects: ShellRedirect[];
  // Where the command, from its first word or redirection to its last, sits
  // in the command string.
  start: number;
  end: number;
}

export type ShellConnector = "&&" | "||" | ";";

export interface ShellScript {
  // Pipelines in order; `connectors[i]` joins pipeline i and i + 1.
  pipelines: ShellCommand[][];
  connectors: ShellConnector[];
}

const RESERVED_WORDS = new Set([
  "!", "case", "coproc", "do", "done", "elif", "else", "esac", "fi", "for", "function",
  "if", "in", "select", "then", "time", "until", "while", "{", "}", "[[", "]]",
]);
// Characters that end an unquoted word.
const METACHARACTERS = new Set([" ", "\t", "\n", "|", "&", ";", "(", ")", "<", ">"]);
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*\+?$/;
// Inside double quotes a backslash only escapes these.
const DOUBLE_QUOTE_ESCAPABLE = new Set(["$", "`", "\"", "\\"]);

class Reject extends Error {}

function isControl(char: string): boolean {
  const code = char.charCodeAt(0);
  return (code < 0x20 && char !== "\t" && char !== "\n") || code === 0x7f;
}

type Token = { start: number; end: number } & (
  | { type: "word"; word: ShellWord }
  | { type: "operator"; operator: "&&" | "||" | ";" | "|" | "\n" }
  | { type: "redirect"; redirects: (Omit<ShellRedirect, "target"> & { target?: string })[]; needsTarget: boolean }
);

class Lexer {
  private index = 0;
  readonly tokens: Token[] = [];

  constructor(private readonly source: string) {}

  private peek(offset = 0): string {
    return this.source[this.index + offset] ?? "";
  }

  run(): Token[] {
    while (this.index < this.source.length) {
      const char = this.peek();
      if (isControl(char)) {
        throw new Reject();
      }
      if (char === " " || char === "\t") {
        this.index += 1;
      } else if (char === "\\" && this.peek(1) === "\n") {
        // Line continuation between words.
        this.index += 2;
      } else if (char === "#") {
        while (this.index < this.source.length && this.peek() !== "\n") {
          this.index += 1;
        }
      } else if (char === "\n") {
        this.operator("\n", 1);
      } else if (char === ";") {
        if (this.peek(1) === ";" || this.peek(1) === "&") {
          throw new Reject();
        }
        this.operator(";", 1);
      } else if (char === "&") {
        if (this.peek(1) === "&") {
          this.operator("&&", 2);
        } else if (this.peek(1) === ">") {
          // `&>file` and `&>>file`: stdout and stderr to the same file.
          const start = this.index;
          const append = this.peek(2) === ">";
          this.index += append ? 3 : 2;
          this.tokens.push({
            start,
            end: this.index,
            type: "redirect",
            redirects: [{ fd: 1, kind: append ? "append" : "write" }, { fd: 2, kind: "duplicate", target: "1" }],
            needsTarget: true,
          });
        } else {
          throw new Reject();
        }
      } else if (char === "|") {
        if (this.peek(1) === "|") {
          this.operator("||", 2);
        } else if (this.peek(1) === "&") {
          throw new Reject();
        } else {
          this.operator("|", 1);
        }
      } else if (char === "<" || char === ">") {
        this.redirect(null, this.index);
      } else if (char === "(" || char === ")") {
        throw new Reject();
      } else {
        this.word();
      }
    }
    return this.tokens;
  }

  private operator(operator: "&&" | "||" | ";" | "|" | "\n", length: number): void {
    this.tokens.push({ start: this.index, end: this.index + length, type: "operator", operator });
    this.index += length;
  }

  /**
   * A redirection operator at the current position, applying to `fd` or the
   * default; `start` is where it begins, fd number included.
   */
  private redirect(fd: number | null, start: number): void {
    const push = (redirects: (Omit<ShellRedirect, "target"> & { target?: string })[], needsTarget: boolean) => {
      this.tokens.push({ start, end: this.index, type: "redirect", redirects, needsTarget });
    };
    const char = this.peek();
    const next = this.peek(1);
    if (char === "<") {
      // `<<`, `<<<`, `<>`, `<&` and `<(` are all outside the subset.
      if (next === "<" || next === ">" || next === "&" || next === "(") {
        throw new Reject();
      }
      this.index += 1;
      push([{ fd: fd ?? 0, kind: "read" }], true);
      return;
    }
    if (next === "(" || next === "|") {
      throw new Reject();
    }
    if (next === ">") {
      this.index += 2;
      push([{ fd: fd ?? 1, kind: "append" }], true);
      return;
    }
    if (next === "&") {
      this.index += 2;
      const digits = /^[0-9]+/.exec(this.source.slice(this.index))?.[0];
      const after = this.source[this.index + (digits?.length ?? 0)] ?? "";
      if (digits && (after === "" || METACHARACTERS.has(after))) {
        // `>&2`: duplicate an fd.
        this.index += digits.length;
        push([{ fd: fd ?? 1, kind: "duplicate", target: digits }], false);
        return;
      }
      if (fd !== null || this.peek() === "-" || this.peek() === " " || this.peek() === "\t") {
        throw new Reject();
      }
      // `>&file` is `&>file`.
      push([{ fd: 1, kind: "write" }, { fd: 2, kind: "duplicate", target: "1" }], true);
      return;
    }
    this.index += 1;
    push([{ fd: fd ?? 1, kind: "write" }], true);
  }

  private word(): void {
    const start = this.index;
    let text = "";
    let expands = false;
    let quoted = false;
    // Bash treats `name=value` like an assignment, for tilde expansion, only
    // when `name` is written without quotes.
    let assignment = false;
    while (this.index < this.source.length) {
      const char = this.peek();
      if (isControl(char)) {
        throw new Reject();
      }
      if (METACHARACTERS.has(char)) {
        break;
      }
      if (char === "$" || char === "`") {
        throw new Reject();
      }
      if (char === "'") {
        const close = this.source.indexOf("'", this.index + 1);
        if (close < 0) {
          throw new Reject();
        }
        const content = this.source.slice(this.index + 1, close);
        if ([...content].some(isControl)) {
          throw new Reject();
        }
        text += content;
        quoted = true;
        this.index = close + 1;
        continue;
      }
      if (char === "\"") {
        text += this.doubleQuoted();
        quoted = true;
        continue;
      }
      if (char === "\\") {
        const next = this.peek(1);
        if (next === "") {
          throw new Reject();
        }
        this.index += 2;
        if (next !== "\n") {
          if (isControl(next)) {
            throw new Reject();
          }
          text += next;
          quoted = true;
        }
        continue;
      }
      if ((char === "=" || char === "[") && !assignment && !quoted && IDENTIFIER.test(text)) {
        assignment = true;
      }
      if (char === "*" || char === "?" || char === "[" || char === "{") {
        expands = true;
      }
      if (char === "~" && (text === "" || (assignment && /[=:]$/.test(text)))) {
        expands = true;
      }
      text += char;
      this.index += 1;
    }
    const after = this.peek();
    if ((after === "<" || after === ">") && !quoted && text !== "") {
      if (/^[0-9]+$/.test(text)) {
        // An fd number: only digits, directly before the operator.
        this.redirect(Number(text), start);
        return;
      }
      if (/^\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(text)) {
        // `{name}>`: bash allocates an fd and stores it in a variable.
        throw new Reject();
      }
    }
    this.tokens.push({ start, end: this.index, type: "word", word: { text, expands, quoted, assignment, start, end: this.index } });
  }

  private doubleQuoted(): string {
    let text = "";
    this.index += 1;
    while (this.index < this.source.length) {
      const char = this.peek();
      if (char === "\"") {
        this.index += 1;
        return text;
      }
      if (char === "$" || char === "`" || isControl(char)) {
        throw new Reject();
      }
      if (char === "\\") {
        const next = this.peek(1);
        if (next === "\n") {
          this.index += 2;
          continue;
        }
        if (DOUBLE_QUOTE_ESCAPABLE.has(next)) {
          text += next;
          this.index += 2;
          continue;
        }
      }
      text += char;
      this.index += 1;
    }
    throw new Reject();
  }
}

function buildScript(tokens: Token[]): ShellScript {
  const script: ShellScript = { pipelines: [], connectors: [] };
  let pipeline: ShellCommand[] = [];
  const newCommand = (): ShellCommand => ({ words: [], redirects: [], start: -1, end: -1 });
  let command = newCommand();
  const extend = (token: Token) => {
    if (command.start < 0) {
      command.start = token.start;
    }
    command.end = token.end;
  };
  // After `|`, `&&` or `||` bash keeps reading across newlines.
  let continuing = false;

  const finishCommand = () => {
    if (!command.words.length) {
      throw new Reject();
    }
    const first = command.words[0];
    // A command word starting with `%`, quoted or not, is a job: bash runs `fg`.
    if (first.assignment || first.text.startsWith("%") || (!first.quoted && RESERVED_WORDS.has(first.text))) {
      throw new Reject();
    }
    pipeline.push(command);
    command = newCommand();
  };
  const finishPipeline = () => {
    finishCommand();
    script.pipelines.push(pipeline);
    pipeline = [];
  };
  const empty = () => !command.words.length && !command.redirects.length && !pipeline.length;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type === "word") {
      command.words.push(token.word);
      extend(token);
      continuing = false;
    } else if (token.type === "redirect") {
      extend(token);
      let target: string | undefined;
      if (token.needsTarget) {
        const next = tokens[index + 1];
        if (next?.type !== "word" || next.word.expands) {
          throw new Reject();
        }
        target = next.word.text;
        extend(next);
        index += 1;
      }
      for (const redirect of token.redirects) {
        command.redirects.push({ ...redirect, target: redirect.target ?? target ?? "" });
      }
      continuing = false;
    } else if (token.operator === "\n" && (continuing || empty())) {
      // Blank lines, and newlines after `|`, `&&` or `||`.
    } else if (token.operator === "|") {
      finishCommand();
      continuing = true;
    } else if (token.operator === "\n" || token.operator === ";") {
      if (empty()) {
        // A `;` with no command before it is a syntax error; a stray newline is not.
        if (token.operator === ";") {
          throw new Reject();
        }
        continue;
      }
      finishPipeline();
      script.connectors.push(";");
    } else {
      finishPipeline();
      script.connectors.push(token.operator);
      continuing = true;
    }
  }
  if (continuing) {
    throw new Reject();
  }
  if (!empty()) {
    finishPipeline();
  } else if (script.connectors.at(-1) === ";") {
    // A trailing `;` or newline ends the last command; it joins nothing.
    script.connectors.pop();
  }
  if (!script.pipelines.length) {
    throw new Reject();
  }
  return script;
}

/** The structure of `command`, or null when it is outside the recognized subset. */
export function recognizeShell(command: string): ShellScript | null {
  try {
    return buildScript(new Lexer(command).run());
  } catch (error) {
    if (error instanceof Reject) {
      return null;
    }
    throw error;
  }
}
