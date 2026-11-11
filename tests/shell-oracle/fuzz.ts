/**
 * Seeded generator of short shell commands built from the characters and
 * constructs bash treats specially. The same seed always yields the same
 * commands, so a divergence can be reproduced.
 */

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PLAIN = [
  "a",
  "b",
  "ls",
  "git",
  "status",
  "x.txt",
  "notes.txt",
  "dir/d.txt",
  "-l",
  "-rf",
  "--opt",
  "--opt=v",
  "2",
  "1a",
  "é",
];
// Characters with a meaning somewhere in bash's grammar.
const SPECIAL = [
  "#",
  "~",
  "*",
  "?",
  "[",
  "]",
  "{",
  "}",
  ",",
  "..",
  "!",
  "=",
  ":",
  "\\",
  "'",
  '"',
  "$",
  "`",
  "(",
  ")",
  "<",
  ">",
  "&",
  "|",
  ";",
  " ",
  "\t",
  "\n",
  "-",
  "/",
  "@",
  "%",
  "^",
];
const ATOMS = [
  "~",
  "~/x",
  "~root",
  "a=~/y",
  "a=x:~/y",
  "'a'=~",
  "--x=~/y",
  "*",
  "*.ts",
  "?.txt",
  "[ab]",
  "{a,b}",
  "{1..2}",
  "{a}",
  "#c",
  "a#b",
  "\\#",
  "\\ ",
  "\\\n",
  "\\\\",
  "\\'",
  '\\"',
  "\\$x",
  "$x",
  "${x}",
  "$(a)",
  "`a`",
  "$'a'",
  "!",
  "!a",
  "=",
];
const OPERATORS = [" && ", " || ", "; ", ";", " | ", "|", "\n", " & ", "&&", " ;; "];
const REDIRECTS = [
  " 2>/dev/null",
  " >/dev/null",
  " 2>&1",
  " &>/dev/null",
  " </dev/null",
  " >x",
  " <notes.txt",
  "2>/dev/null",
  " 1>&2",
  " a2>/dev/null",
];

export function fuzzCommands(count: number, seed: number): string[] {
  const random = mulberry32(seed);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  const quoted = (): string => {
    const inner = Array.from({ length: 1 + Math.floor(random() * 4) }, () =>
      random() < 0.5 ? pick(PLAIN) : pick(SPECIAL),
    ).join("");
    if (random() < 0.5) {
      return `'${inner.replace(/'/g, "")}'`;
    }
    return `"${inner.replace(/"/g, '\\"')}"`;
  };
  const piece = (): string => {
    const roll = random();
    if (roll < 0.45) {
      return pick(PLAIN);
    }
    if (roll < 0.7) {
      return pick(ATOMS);
    }
    if (roll < 0.9) {
      return quoted();
    }
    return pick(SPECIAL);
  };
  const word = (): string => Array.from({ length: 1 + Math.floor(random() * 3) }, piece).join("");
  const simple = (): string => {
    const words = [pick(["ls", "git", "echo", "a", "b"]), ...Array.from({ length: Math.floor(random() * 4) }, word)];
    let text = words.join(random() < 0.2 ? "  " : " ");
    if (random() < 0.25) {
      text += pick(REDIRECTS);
    }
    return text;
  };
  const commands: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const parts = [simple()];
    const extra = random() < 0.5 ? 0 : Math.floor(random() * 3);
    for (let part = 0; part < extra; part += 1) {
      parts.push(pick(OPERATORS), simple());
    }
    commands.push(parts.join(""));
  }
  return commands;
}
