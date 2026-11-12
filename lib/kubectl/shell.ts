// The terminal's little shell, modelled on bash: `&&`, `||` and `;` lists, `|` pipelines, `>`,
// `>>`, `2>`, `2>&1`, `&>`, `<`, `<<` (here-documents) and `<<<` redirections, quoting, `$VAR` and
// `${VAR}` expansion with word splitting, aliases, `export`, `source`, and the text tools people
// pipe kubectl into (grep, head, wc, awk…). Commands it doesn't own (kubectl, curl…) go through
// ShellEnv.exec. Aliases, variables and files belong to one terminal session (see ShellState).
// The behaviours and their sources in the GNU Bash manual are in docs/research/shell-behaviour.md.

/** One piece of output, on stdout (1) or stderr (2). `nl: false` is echo -n. */
export interface Chunk {
  fd: 1 | 2;
  text: string;
  nl?: boolean;
}

export interface Res {
  chunks: Chunk[];
  ok: boolean;
  /** A streaming command: the UI re-runs this line to refresh it. */
  watch?: string;
  /** Ask the UI to open this file in the Editor. */
  openFile?: string;
  /** How it was opened: `nano`, or `vi` (vi and vim): the Editor then behaves like that tool. Absent for plain opens. */
  editor?: "nano" | "vi";
}

/** A login on a Node's host (ADR 0003): `ssh <node>` opens one, `sudo -i` opens a root shell inside it, `exit` closes the innermost. */
export interface HostSession {
  node: string;
  user: "candidate" | "root";
  via: "ssh" | "sudo";
}

/** What one terminal session remembers: aliases and shell variables. Both start empty (apart from the usual environment). */
export interface ShellState {
  aliases: Map<string, string>;
  vars: Map<string, { value: string; exported: boolean }>;
  /** The hosts this terminal is logged in to, outermost first. Empty: the base terminal. */
  sessions: HostSession[];
  /** Exit status of the last command, for `$?`. */
  status: number;
  /** The file being `source`d and its current line, for error messages. */
  src?: { file: string; line: number };
  /** How many `source`s are running inside one another (a file that sources itself must stop, as bash's own limit does). */
  sourceDepth?: number;
}

export const HOME = "/home/candidate";

export function newShell(): ShellState {
  const vars = new Map<string, { value: string; exported: boolean }>();
  for (const [k, v] of Object.entries({ HOME, USER: "candidate", LOGNAME: "candidate", SHELL: "/bin/bash", PWD: HOME, TERM: "xterm", PATH: "/usr/local/bin:/usr/bin:/bin" })) vars.set(k, { value: v, exported: true });
  return { aliases: new Map(), vars, status: 0, sessions: [] };
}

/** A file operation the host refuses: the shell words it like the real tool (`cat: /x: Permission denied`). */
export class FsError extends Error {
  constructor(
    public kind: "denied" | "isdir" | "missing",
    public path: string,
  ) {
    super(kind);
  }
}
const FS_TEXT = { denied: "Permission denied", isdir: "Is a directory", missing: "No such file or directory" } as const;

export interface HostEntry {
  name: string;
  dir: boolean;
  mode: number;
  size: number;
  mtime: number;
}

/** What the shell's file commands need to reach a Node's files (absolute paths outside the home directory). */
export interface HostView {
  node: string;
  owns(path: string): boolean;
  isDir(path: string): boolean;
  /** A directory's entries, or the one entry of a file; undefined when the path does not exist. */
  ls(path: string): { dir: boolean; entries: HostEntry[] } | undefined;
  move(src: string, dst: string): void;
  copy(src: string, dst: string, preserve: boolean): void;
  /** Throws when the user may not open the path for editing. */
  checkEdit(path: string): void;
  /** Runs `fn` with root's privileges (sudo). */
  asRoot<T>(fn: () => T): T;
}

export interface ShellEnv {
  files: Record<string, string>;
  /** On a node host: reaches the Node's files. `files` then also answers for absolute host paths. */
  host?: HostView;
  /** Runs a command the shell doesn't own. `text` is its source, for streaming re-runs. */
  exec(words: string[], stdin: string | undefined, text: string): Res | undefined;
  /** Aliases and variables of this terminal session. Created on first use if the caller gives none. */
  shell?: ShellState;
}

export const out = (text: string, ok = true): Res => ({ chunks: text ? [{ fd: 1, text }] : [], ok });
export const err = (text: string): Res => ({ chunks: text ? [{ fd: 2, text }] : [], ok: false });

import { grepRegex } from "@/lib/engine";
import { lsStamp } from "@/lib/engine/host";

class ShellSyntax extends Error {}

const stateOf = (env: ShellEnv): ShellState => (env.shell ??= newShell());

// ---------------------------------------------------------------- tokenizer

/** A piece of a word: unquoted (0, subject to expansion and splitting), literal (1: single-quoted or escaped), double-quoted (2: expands, never splits). */
export interface Seg {
  s: string;
  q: 0 | 1 | 2;
}
export interface Word {
  segs: Seg[];
  /** The text with quotes removed and `$` left alone. */
  v: string;
  /** Any part of it was quoted or escaped. */
  quoted: boolean;
}
type Tok = ({ t: "word"; start: number; end: number } & Word) | { t: "op"; v: string; start: number; end: number };

const OPS = ["2>&1", "1>&2", "&>>", "2>>", "&&", "||", ">>", "&>", "2>", ">&2", "|", ";", ">", "<<<", "<<-", "<<", "<", "&"];

/** POSIX-ish word splitting with operators recognised outside quotes. */
export function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let segs: Seg[] = [];
  let run = "";
  let any = false;
  let start = -1;
  const endRun = () => {
    if (run) segs.push({ s: run, q: 0 });
    run = "";
  };
  const flush = (end: number) => {
    endRun();
    if (segs.length || any) toks.push({ t: "word", segs, v: segs.map((x) => x.s).join(""), quoted: segs.some((x) => x.q !== 0), start, end });
    segs = [];
    any = false;
    start = -1;
  };
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      if (start < 0) start = i;
      endRun();
      any = true;
      const q = ch;
      i++;
      let text = "";
      while (i < s.length && s[i] !== q) {
        if (q === '"' && s[i] === "$" && s[i + 1] === "(") throw new ShellSyntax("subst");
        if (q === '"' && s[i] === "`") throw new ShellSyntax("subst");
        // Inside double quotes a backslash only escapes $, `, ", \ and newline; elsewhere it stays.
        if (q === '"' && s[i] === "\\" && i + 1 < s.length && '$`"\\\n'.includes(s[i + 1])) {
          if (text) segs.push({ s: text, q: 2 });
          text = "";
          segs.push({ s: s[i + 1], q: 1 });
          i += 2;
          continue;
        }
        text += s[i++];
      }
      if (i >= s.length) throw new ShellSyntax(`unexpected EOF while looking for matching \`${q}'`);
      i++;
      segs.push({ s: text, q: q === "'" ? 1 : 2 });
      continue;
    }
    if (/\s/.test(ch)) {
      flush(i);
      i++;
      continue;
    }
    if (ch === "\\") {
      if (start < 0) start = i;
      endRun();
      if (i + 1 < s.length && s[i + 1] !== "\n") segs.push({ s: s[i + 1], q: 1 });
      else any = true;
      i += 2;
      continue;
    }
    if ((ch === "$" && s[i + 1] === "(") || ch === "`") throw new ShellSyntax("subst");
    if ((ch === "<" || ch === ">") && s[i + 1] === "(") throw new ShellSyntax("The simulator's shell doesn't support process substitution (<(...) or >(...)). Run the inner command on its own, or write its output to a file and use that file.");
    if (ch === "#" && !run && !segs.length && !any) break;
    // "2>" is only an operator at the start of a word.
    const op = OPS.find((o) => s.startsWith(o, i) && (!/^[12]/.test(o) || (!run && !segs.length && !any)));
    if (op) {
      flush(i);
      toks.push({ t: "op", v: op, start: i, end: i + op.length });
      i += op.length;
      continue;
    }
    if (start < 0) start = i;
    run += ch;
    i++;
  }
  flush(s.length);
  return toks;
}

// ---------------------------------------------------------------- aliases

/**
 * Alias expansion happens when a line is read, before anything on it runs: the first word of each
 * simple command, if unquoted, is replaced by the alias text, whose own first word is checked again
 * (but not for the alias being expanded). An alias value ending in a blank also checks the next word.
 */
function expandAliases(toks: Tok[], aliases: Map<string, string>, active: Set<string> = new Set()): Tok[] {
  if (!aliases.size) return toks;
  const res: Tok[] = [];
  let cmdPos = true;
  let blankNext = false;
  for (const t of toks) {
    if (t.t === "op") {
      res.push(t);
      cmdPos = ["|", ";", "&&", "||", "&"].includes(t.v);
      blankNext = false;
      continue;
    }
    const plain = t.segs.length === 1 && t.segs[0].q === 0;
    const isAssign = /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.segs[0]?.q === 0 ? t.segs[0].s : "");
    if ((cmdPos || blankNext) && plain && !active.has(t.v) && aliases.has(t.v)) {
      const value = aliases.get(t.v)!;
      let inner: Tok[];
      try {
        inner = tokenize(value);
      } catch {
        inner = [];
      }
      for (const x of expandAliases(inner, aliases, new Set([...active, t.v]))) res.push(x.t === "word" ? { ...x, start: t.start, end: t.end } : { ...x, start: t.start, end: t.end });
      blankNext = /[ \t]$/.test(value);
      cmdPos = false;
      continue;
    }
    res.push(t);
    cmdPos = isAssign && cmdPos;
    blankNext = false;
  }
  return res;
}

// ---------------------------------------------------------------- expansion

class BadSubst extends Error {}

/** $NAME, ${NAME}, ${NAME:-word}, ${#NAME} and $? in a run of text; anything else with a `$` stays as it is. */
function expandParams(text: string, sh: ShellState): string {
  let res = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "$") {
      res += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === "{") {
      const close = text.indexOf("}", i + 2);
      if (close < 0) throw new BadSubst(text.slice(i));
      const body = text.slice(i + 2, close);
      const m = /^(#?)([A-Za-z_][A-Za-z0-9_]*)(?:(:?-)([\s\S]*))?$/.exec(body);
      if (!m) throw new BadSubst(`\${${body}}`);
      const val = sh.vars.get(m[2])?.value;
      if (m[1]) res += String((val ?? "").length);
      else if (m[3]) res += m[3] === ":-" ? (val ? val : (m[4] ?? "")) : (val !== undefined ? val : (m[4] ?? ""));
      else res += val ?? "";
      i = close;
      continue;
    }
    if (next === "?") {
      res += String(sh.status);
      i++;
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i + 1));
    if (m) {
      res += sh.vars.get(m[0])?.value ?? "";
      i += m[0].length;
      continue;
    }
    // $1, $@, $* and friends: no positional parameters here.
    if (next && /[0-9@*#]/.test(next)) {
      i++;
      continue;
    }
    res += "$";
  }
  return res;
}

/** Tilde expansion: a word that starts with an unquoted `~` or `~/`. */
function tilde(segs: Seg[], sh: ShellState): Seg[] {
  const first = segs[0];
  if (!first || first.q !== 0 || !first.s.startsWith("~")) return segs;
  if (first.s === "~" || first.s.startsWith("~/")) return [{ s: sh.vars.get("HOME")?.value ?? HOME, q: 1 }, { s: first.s.slice(1), q: 0 }, ...segs.slice(1)];
  return segs;
}

/** One word to its fields: parameters expanded, then (unless `split` is off) the unquoted results split at blanks. */
function expandWord(w: Word, sh: ShellState, split = true): string[] {
  const fields: string[] = [];
  let cur: string | null = null;
  for (const seg of tilde(w.segs, sh)) {
    if (seg.q === 1) {
      cur = (cur ?? "") + seg.s;
    } else if (seg.q === 2 || !split) {
      cur = (cur ?? "") + expandParams(seg.s, sh);
    } else {
      for (const part of expandParams(seg.s, sh).split(/(\s+)/)) {
        if (/^\s+$/.test(part)) {
          if (cur !== null) fields.push(cur);
          cur = null;
        } else if (part !== "") cur = (cur ?? "") + part;
      }
    }
  }
  if (cur !== null) fields.push(cur);
  // An unquoted expansion of nothing disappears; a quoted empty string ("") stays as an empty argument.
  return fields.length ? fields : w.quoted ? [""] : [];
}

const DECLARING = new Set(["export", "alias", "declare", "readonly", "local", "typeset"]);
const assignmentPrefix = (w: Word) => /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(w.segs[0]?.q === 0 ? w.segs[0].s : "");

/** The text of a here-document body: backslash-newline joins lines; `\$`, `\\` and "\`" are literal; parameters expand. */
function expandHeredoc(body: string, sh: ShellState): string {
  const joined = body.replace(/\\\n/g, "");
  if (/\$\(|`/.test(joined.replace(/\\[$`\\]/g, ""))) throw new ShellSyntax("subst");
  // Escaped characters are swapped for markers so parameter expansion leaves them alone.
  const marks: Record<string, string> = { $: "\uE001", "`": "\uE002", "\\": "\uE003" };
  const back: Record<string, string> = { "\uE001": "$", "\uE002": "`", "\uE003": "\\" };
  let res = "";
  let i = 0;
  while (i < joined.length) {
    if (joined[i] === "\\" && "$`\\".includes(joined[i + 1] ?? "")) {
      res += marks[joined[i + 1]];
      i += 2;
      continue;
    }
    res += joined[i++];
  }
  return expandParams(res, sh).replace(/[\uE001-\uE003]/g, (m) => back[m]);
}

// ---------------------------------------------------------------- reading input: lines, here-documents, continuation

/** A here-document: its delimiter, whether that was quoted (then the body is not expanded), and the lines read. */
export interface Doc {
  delim: string;
  quoted: boolean;
  strip: boolean;
  body: string;
}
interface Piece {
  line: string;
  docs: Doc[];
  /** The physical line the command starts on (1-based), for messages from a sourced file. */
  lineNo: number;
}

/** Whether a line ends inside a quote or on a backslash, so the command carries on on the next line. */
function openState(s: string): { quote: "'" | '"' | null; backslash: boolean } {
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
    } else if (quote === '"') {
      if (ch === "\\" && i + 1 < s.length) i++;
      else if (ch === '"') quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === "\\") {
      if (i + 1 >= s.length) return { quote, backslash: true };
      i++;
    } else if (ch === "#" && (i === 0 || /\s/.test(s[i - 1]))) break;
  }
  return { quote, backslash: false };
}

/**
 * Splits input into commands. A line that opens a quote or ends in a backslash, `|`, `&&` or `||`
 * carries on onto the next; a line with `<<WORD` is followed by the lines up to WORD. `incomplete`
 * says the input stops before that is finished, which is when the terminal shows a `> ` prompt.
 */
export function splitScript(text: string): { pieces: Piece[]; incomplete: boolean; wanted?: string; rest?: string } {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  const pieces: Piece[] = [];
  let i = 0;
  while (i < lines.length) {
    const lineNo = i + 1;
    let logical = lines[i++];
    for (;;) {
      const st = openState(logical);
      let more = st.quote !== null || st.backslash;
      if (!more) {
        try {
          const last = tokenize(logical).at(-1);
          more = last?.t === "op" && ["|", "&&", "||"].includes(last.v);
        } catch {
          more = false;
        }
      }
      if (!more) break;
      if (i >= lines.length) return { pieces, incomplete: true, rest: logical };
      logical = st.backslash ? logical.slice(0, -1) + lines[i++] : st.quote ? logical + "\n" + lines[i++] : logical + " " + lines[i++];
    }
    // A multi-line function definition is one piece, so its body lines are never run on their own.
    if (FUNC_HEADER.test(logical) && /\{\s*$/.test(logical)) {
      for (;;) {
        if (i >= lines.length) return { pieces, incomplete: true, rest: logical };
        const l = lines[i++];
        logical += "\n" + l;
        if (/^\s*\}/.test(l)) break;
      }
    }
    const docs: Doc[] = [];
    let toks: Tok[] = [];
    try {
      toks = tokenize(logical);
    } catch {
      toks = [];
    }
    for (let k = 0; k < toks.length; k++) {
      const t = toks[k];
      if (t.t !== "op" || (t.v !== "<<" && t.v !== "<<-")) continue;
      const delimTok = toks[k + 1];
      if (!delimTok || delimTok.t !== "word") continue;
      const strip = t.v === "<<-";
      const body: string[] = [];
      let closed = false;
      while (i < lines.length) {
        const l = lines[i++];
        const cmp = strip ? l.replace(/^\t+/, "") : l;
        if (cmp === delimTok.v) {
          closed = true;
          break;
        }
        body.push(cmp === l || !strip ? l : cmp);
      }
      docs.push({ delim: delimTok.v, quoted: delimTok.quoted, strip, body: body.length ? body.join("\n") + "\n" : "" });
      if (!closed) return { pieces: [...pieces, { line: logical, docs, lineNo }], incomplete: true, wanted: delimTok.v };
    }
    pieces.push({ line: logical, docs, lineNo });
  }
  return { pieces, incomplete: false };
}

/** True while what has been typed is not yet a whole command: the terminal then asks for more with `> `. */
export const needsMore = (text: string) => splitScript(text).incomplete;

// ---------------------------------------------------------------- parser

interface Redirect {
  op: string;
  target?: Word;
  doc?: Doc;
}
interface SimpleCmd {
  words: Word[];
  redirects: Redirect[];
  text: string;
}
interface Pipeline {
  cmds: SimpleCmd[];
  text: string;
}
interface Statement {
  join: ";" | "&&" | "||";
  pipe: Pipeline;
}

function parse(line: string, toks: Tok[], docs: Doc[]): Statement[] {
  const stmts: Statement[] = [];
  let i = 0;
  let docIdx = 0;
  let join: Statement["join"] = ";";
  const near = (t?: Tok) => `bash: syntax error near unexpected token \`${t ? t.v : "newline"}'`;
  while (i < toks.length) {
    const cmds: SimpleCmd[] = [];
    let pStart = toks[i].start;
    let pEnd = pStart;
    for (;;) {
      const words: Word[] = [];
      const redirects: Redirect[] = [];
      const cStart = toks[i]?.start ?? line.length;
      let cEnd = cStart;
      while (i < toks.length) {
        const t = toks[i];
        if (t.t === "word") {
          words.push(t);
          cEnd = t.end;
          i++;
          continue;
        }
        if (["|", ";", "&&", "||"].includes(t.v)) break;
        if (t.v === "&") throw new ShellSyntax("The simulator's shell doesn't run background jobs (&). Run the command on its own.");
        if (t.v === "2>&1" || t.v === "1>&2" || t.v === ">&2") {
          redirects.push({ op: t.v });
          cEnd = t.end;
          i++;
          continue;
        }
        const target = toks[i + 1];
        if (!target || target.t !== "word") throw new ShellSyntax(near(target));
        if (t.v === "<<" || t.v === "<<-") redirects.push({ op: t.v, target, doc: docs[docIdx++] });
        else redirects.push({ op: t.v, target });
        cEnd = target.end;
        i += 2;
      }
      if (!words.length && !redirects.length) throw new ShellSyntax(near(toks[i]));
      cmds.push({ words, redirects, text: line.slice(cStart, cEnd).trim() });
      pEnd = cEnd;
      if (toks[i]?.v === "|") {
        i++;
        if (i >= toks.length) throw new ShellSyntax(near(undefined));
        continue;
      }
      break;
    }
    stmts.push({ join, pipe: { cmds, text: line.slice(pStart, pEnd).trim() } });
    const sep = toks[i];
    if (!sep) break;
    join = sep.v as Statement["join"];
    i++;
    if (i >= toks.length && sep.v !== ";") throw new ShellSyntax(near(undefined));
    pStart = toks[i]?.start ?? line.length;
  }
  return stmts;
}

// ---------------------------------------------------------------- execution

/** Text a chunk contributes to a file or pipe (programs end their output with a newline). */
const serialize = (cs: Chunk[]) => cs.map((c) => (c.nl === false || !c.text || c.text.endsWith("\n") ? c.text : c.text + "\n")).join("");

/** A path in the Learner's home directory (where every file lives) as the key it is stored under. */
export const fileName = (f: string) => {
  const g = f.replace(/^\.\//, "");
  if (g === HOME || g === "~") return ".";
  return g.startsWith(HOME + "/") ? g.slice(HOME.length + 1) : g.startsWith("~/") ? g.slice(2) : g;
};

/** Words for a command the shell doesn't run itself: a path in the home directory is the name the file is stored under. */
const forProgram = (w: string) => w.replace(/(^|=)\/home\/candidate\//g, "$1").replace(/^\/home\/candidate$/, ".");

const where = (sh: ShellState) => (sh.src ? `${sh.src.file}: line ${sh.src.line}: ` : "");

/** Runs one or more lines (a pasted block, or a sourced file), each read after the one before has run. */
export function runScript(env: ShellEnv, text: string): Res {
  const sh = stateOf(env);
  const { pieces, incomplete, wanted, rest } = splitScript(text);
  const chunks: Chunk[] = [];
  let last: Res = { chunks: [], ok: true };
  for (const p of pieces) {
    if (sh.src) sh.src.line = p.lineNo;
    last = runLine(env, p.line, p.docs);
    chunks.push(...last.chunks);
  }
  if (incomplete) {
    if (wanted !== undefined) chunks.push({ fd: 2, text: `bash: warning: here-document delimited by end-of-file (wanted \`${wanted}')` });
    else {
      // The input stops inside a quote or after `|`: run what is there so the error is bash's own.
      last = runLine(env, rest ?? text);
      chunks.push(...last.chunks);
    }
  }
  return { chunks, ok: last.ok, ...(last.watch ? { watch: last.watch } : {}), ...(last.openFile ? { openFile: last.openFile } : {}), ...(last.editor ? { editor: last.editor } : {}) };
}

/** The start of a shell function definition: `name() {`, `name () {` or `function name {`. */
const FUNC_HEADER = /^\s*(function\s+[A-Za-z_][\w.:-]*\s*(\(\s*\))?|[A-Za-z_][\w.:-]*\s*\(\s*\))\s*(\{|$)/;

export function runLine(env: ShellEnv, line: string, docs: Doc[] = []): Res {
  const sh = stateOf(env);
  if (FUNC_HEADER.test(line)) {
    sh.status = 2;
    return err("bash: shell functions are not supported in the simulator. Use an alias for a shorthand, or put the commands in a file and `source` it.");
  }
  let stmts: Statement[];
  try {
    const toks = expandAliases(tokenize(line), sh.aliases);
    if (!toks.length) return out("");
    stmts = parse(line, toks, docs);
  } catch (e) {
    if (e instanceof ShellSyntax) {
      sh.status = 2;
      if (e.message === "subst") return err("The simulator's shell doesn't support command substitution ($(...) or backticks). Run the inner command first, then paste its output.");
      return err(e.message.startsWith("bash:") || e.message.startsWith("The ") ? e.message : `bash: ${e.message}`);
    }
    throw e;
  }
  const chunks: Chunk[] = [];
  let last: Res = { chunks: [], ok: true };
  for (let si = 0; si < stmts.length; si++) {
    const st = stmts[si];
    if ((st.join === "&&" && !last.ok) || (st.join === "||" && last.ok)) continue;
    last = runPipeline(env, st.pipe, si === stmts.length - 1);
    sh.status = last.ok ? 0 : 1;
    chunks.push(...last.chunks);
  }
  return { chunks, ok: last.ok, ...(last.watch ? { watch: last.watch } : {}), ...(last.openFile ? { openFile: last.openFile } : {}), ...(last.editor ? { editor: last.editor } : {}) };
}

function runPipeline(env: ShellEnv, p: Pipeline, lastStatement: boolean): Res {
  const sh = stateOf(env);
  const term: Chunk[] = [];
  let stdin: string | undefined;
  let r: Res = { chunks: [], ok: true };
  let streamed = false;
  let redirected = false;
  for (let ci = 0; ci < p.cmds.length; ci++) {
    const c = p.cmds[ci];
    const isLast = ci === p.cmds.length - 1;
    let input = stdin;
    // Expansion happens as each command runs, so `x=1; echo $x` sees the new value.
    let words: string[];
    const targets = new Map<Redirect, string>();
    const assigns: [string, string][] = [];
    try {
      const rest = [...c.words];
      while (rest.length && assignmentPrefix(rest[0])) {
        const w = rest.shift()!;
        const m = assignmentPrefix(w)!;
        const value = expandWord({ ...w, segs: [{ s: w.segs[0].s.slice(m[0].length), q: w.segs[0].q }, ...w.segs.slice(1)] }, sh, false).join(" ");
        assigns.push([m[1], value]);
      }
      const head = rest[0]?.segs.length === 1 && rest[0].segs[0].q === 0 ? rest[0].v : "";
      words = rest.flatMap((w) => expandWord(w, sh, !(DECLARING.has(head) && !!assignmentPrefix(w))));
      for (const rd of c.redirects) {
        if (!rd.target || rd.op === "<<" || rd.op === "<<-") continue;
        const f = expandWord(rd.target, sh, true);
        if (f.length !== 1) throw new BadSubst(`${rd.target.v}: ambiguous redirect`);
        targets.set(rd, f[0]);
      }
    } catch (e) {
      if (!(e instanceof BadSubst)) throw e;
      term.push({ fd: 2, text: e.message.includes("ambiguous") ? `bash: ${e.message}` : `bash: ${e.message}: bad substitution` });
      r = { chunks: [], ok: false };
      stdin = "";
      continue;
    }
    if (!words.length && assigns.length) {
      // Only assignments: they set shell variables (an exported variable stays exported).
      for (const [k, v] of assigns) sh.vars.set(k, { value: v, exported: sh.vars.get(k)?.exported ?? false });
      r = { chunks: [], ok: true };
      stdin = "";
      continue;
    }
    const saved = new Map(assigns.map(([k]) => [k, sh.vars.get(k)]));
    for (const [k, v] of assigns) sh.vars.set(k, { value: v, exported: true });
    const inRedir = [...c.redirects].reverse().find((x) => x.op === "<" || x.op === "<<" || x.op === "<<-" || x.op === "<<<");
    if (inRedir) {
      if (inRedir.op === "<<" || inRedir.op === "<<-") {
        const doc = inRedir.doc;
        try {
          input = doc ? (doc.quoted ? doc.body : expandHeredoc(doc.body, sh)) : "";
        } catch (e) {
          if (!(e instanceof ShellSyntax)) throw e;
          term.push({ fd: 2, text: "The simulator's shell doesn't support command substitution ($(...) or backticks). Run the inner command first, then paste its output." });
          input = "";
        }
      } else if (inRedir.op === "<<<") {
        input = expandWord(inRedir.target!, sh, false).join(" ") + "\n";
      } else {
        const name = targets.get(inRedir)!;
        const f = fileName(name);
        let text: string | undefined;
        try {
          text = env.files[f];
        } catch (e) {
          if (!(e instanceof FsError)) throw e;
          term.push({ fd: 2, text: `bash: ${name}: ${FS_TEXT[e.kind]}` });
          r = { chunks: [], ok: false };
          stdin = "";
          continue;
        }
        if (text === undefined) {
          term.push({ fd: 2, text: `bash: ${name}: No such file or directory` });
          r = { chunks: [], ok: false };
          stdin = "";
          continue;
        }
        input = text;
      }
    }
    r = words.length ? runSimple(env, words, input, c.text) : out("");
    for (const [k, v] of saved) {
      if (v) sh.vars.set(k, v);
      else sh.vars.delete(k);
    }
    if (r.watch) streamed = true;
    // Route stdout/stderr through the redirections, left to right like sh.
    type Target = { kind: "term" | "pipe" | "null" } | { kind: "file"; name: string };
    let t1: Target = isLast ? { kind: "term" } : { kind: "pipe" };
    let t2: Target = { kind: "term" };
    const written = new Map<string, string>();
    for (const rd of c.redirects) {
      if (rd.op === "<" || rd.op === "<<" || rd.op === "<<-" || rd.op === "<<<") continue;
      if (rd.op === "2>&1") {
        t2 = t1;
        continue;
      }
      if (rd.op === "1>&2" || rd.op === ">&2") {
        t1 = t2;
        continue;
      }
      redirected = true;
      const name = fileName(targets.get(rd)!);
      const target: Target = name === "/dev/null" ? { kind: "null" } : name === "/dev/stdout" ? { kind: "term" } : name === "/dev/stderr" ? { kind: "term" } : { kind: "file", name };
      if (target.kind === "file") {
        const append = rd.op.endsWith(">>");
        // ">" truncates the file before the command runs, even if it writes nothing.
        try {
          written.set(name, append ? (env.files[name] ?? "") : "");
        } catch (e) {
          if (!(e instanceof FsError)) throw e;
          term.push({ fd: 2, text: `bash: ${name}: ${FS_TEXT[e.kind]}` });
          r = { chunks: [], ok: false };
          continue;
        }
      }
      if (rd.op.startsWith("&")) t1 = t2 = target;
      else if (rd.op.startsWith("2")) t2 = target;
      else t1 = target;
    }
    let piped = "";
    for (const ch of r.chunks) {
      const t = ch.fd === 1 ? t1 : t2;
      if (t.kind === "term") term.push(ch);
      else if (t.kind === "pipe") piped += serialize([ch]);
      else if (t.kind === "file") written.set(t.name, written.get(t.name)! + serialize([ch]));
    }
    for (const [name, text] of written) {
      try {
        env.files[name] = text;
      } catch (e) {
        if (!(e instanceof FsError)) throw e;
        term.push({ fd: 2, text: `bash: ${name}: ${FS_TEXT[e.kind]}` });
        r = { ...r, ok: false };
      }
    }
    stdin = piped;
  }
  const watch = streamed && !redirected && lastStatement ? (p.cmds.length === 1 ? r.watch : p.text) : undefined;
  return { chunks: term, ok: r.ok, ...(watch ? { watch } : {}), ...(r.openFile ? { openFile: r.openFile } : {}), ...(r.editor ? { editor: r.editor } : {}) };
}

function runSimple(env: ShellEnv, words: string[], stdin: string | undefined, text: string): Res {
  if (!words.length) return out("");
  const sh0 = stateOf(env);
  // `exit` leaves the innermost host login; on the base terminal there is nothing to leave.
  if ((words[0] === "exit" || words[0] === "logout") && sh0.sessions.length) {
    const s = sh0.sessions.pop()!;
    return out(s.via === "ssh" ? `logout\nConnection to ${s.node} closed.` : "logout");
  }
  const builtin = BUILTINS[words[0]];
  if (builtin) {
    try {
      return builtin(words.slice(1), stdin ?? "", env, text);
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      return err(`${words[0]}: ${e.path}: ${FS_TEXT[e.kind]}`);
    }
  }
  const r = env.exec(words.map((w, i) => (i ? forProgram(w) : w)), stdin, text);
  if (r) return r;
  const sh = stateOf(env);
  const hint = words[0].startsWith("kube") ? `\nDid you mean "kubectl"?` : "";
  return err(`bash: ${where(sh)}${words[0]}: command not found${hint}${sh.src ? "" : '\nTry "help" for what this terminal can do.'}`);
}

// ---------------------------------------------------------------- builtins and text tools

type Builtin = (args: string[], stdin: string, env: ShellEnv, text: string) => Res;

/** Text that came in on stdin going back out: its final newline is the line end, not content. */
const passthrough = (text: string): Res => ({ chunks: text ? [text.endsWith("\n") ? { fd: 1, text: text.slice(0, -1) } : { fd: 1, text, nl: false }] : [], ok: true });

const linesOf = (s: string) => (s === "" ? [] : s.replace(/\n$/, "").split("\n"));
const joinLines = (ls: string[]) => ls.join("\n");

/** Short options as a set of letters, plus option values for the ones that take one. */
function opts(args: string[], valued: string): { set: Set<string>; vals: Record<string, string>; rest: string[]; missing?: string } {
  const set = new Set<string>();
  const vals: Record<string, string> = {};
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      rest.push(...args.slice(i + 1));
      break;
    }
    if (/^-\d+$/.test(a) && valued.includes("n")) {
      vals.n = a.slice(1);
      continue;
    }
    if (a.startsWith("-") && a.length > 1 && !a.startsWith("--")) {
      for (let j = 1; j < a.length; j++) {
        const ch = a[j];
        if (valued.includes(ch)) {
          const v = a.slice(j + 1) || args[++i];
          if (v === undefined) return { set, vals, rest, missing: ch };
          vals[ch] = v;
          break;
        }
        set.add(ch);
      }
      continue;
    }
    rest.push(a);
  }
  return { set, vals, rest };
}

/** Input from file arguments, or stdin. */
function inputOf(tool: string, files: string[], stdin: string, env: ShellEnv): { text: string; error?: string } {
  if (!files.length) return { text: stdin };
  let text = "";
  for (const f of files) {
    const v = env.files[fileName(f)];
    if (v === undefined) return { text, error: `${tool}: ${f}: No such file or directory` };
    text += v.endsWith("\n") || !v ? v : v + "\n";
  }
  return { text };
}

function grep(args: string[], stdin: string, env: ShellEnv): Res {
  const o = opts(args, "em");
  if (o.missing) return err(`grep: option requires an argument -- '${o.missing}'\nUsage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.`);
  const rest = [...o.rest];
  const pat = o.vals.e ?? rest.shift();
  if (pat === undefined) return err("Usage: grep [OPTION]... PATTERNS [FILE]...\nTry 'grep --help' for more information.");
  const input = inputOf("grep", rest, stdin, env);
  if (input.error) return err(input.error);
  const f = o.set;
  const base = grepRegex(pat, { extended: f.has("E"), fixed: f.has("F"), icase: f.has("i") });
  if (typeof base === "string") return err(`grep: ${base}`);
  // -w / -x wrap the already-compiled pattern, so user input never reaches new RegExp directly.
  const re = f.has("w") ? new RegExp(`(?<![\\w])(?:${base.source})(?![\\w])`, base.flags) : f.has("x") ? new RegExp(`^(?:${base.source})$`, base.flags) : base;
  let hits = linesOf(input.text)
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => re.test(l) !== f.has("v"));
  if (o.vals.m) hits = hits.slice(0, parseInt(o.vals.m, 10) || 0);
  if (f.has("q")) return { chunks: [], ok: hits.length > 0 };
  if (f.has("c")) return { chunks: [{ fd: 1, text: String(hits.length) }], ok: hits.length > 0 };
  const rows = f.has("o") && !f.has("v") ? hits.flatMap(({ l, i }) => [...l.matchAll(new RegExp(re.source, re.flags + "g"))].map((m) => ({ l: m[0], i }))) : hits;
  return { chunks: rows.length ? [{ fd: 1, text: joinLines(rows.map(({ l, i }) => (f.has("n") ? `${i + 1}:${l}` : l))) }] : [], ok: hits.length > 0 };
}

function headTail(tool: "head" | "tail"): Builtin {
  return (args, stdin, env) => {
    const o = opts(args, "nc");
    if (o.missing) return err(`${tool}: option requires an argument -- '${o.missing}'\nTry '${tool} --help' for more information.`);
    const input = inputOf(tool, o.rest, stdin, env);
    if (input.error) return err(`${tool}: cannot open '${o.rest[0]}' for reading: No such file or directory`);
    if (o.vals.c !== undefined) {
      if (!/^[+-]?\d+$/.test(o.vals.c)) return err(`${tool}: invalid number of bytes: '${o.vals.c}'`);
      const n = parseInt(o.vals.c, 10);
      return { chunks: [{ fd: 1, text: tool === "head" ? input.text.slice(0, n) : input.text.slice(-n || input.text.length), nl: false }], ok: true };
    }
    const raw = o.vals.n ?? "10";
    if (!/^[+-]?\d+$/.test(raw)) return err(`${tool}: invalid number of lines: '${raw}'`);
    const ls = linesOf(input.text);
    const n = Math.abs(parseInt(raw, 10));
    const pick = tool === "head" ? (raw.startsWith("-") ? ls.slice(0, Math.max(0, ls.length - n)) : ls.slice(0, n)) : raw.startsWith("+") ? ls.slice(Math.max(0, n - 1)) : n === 0 ? [] : ls.slice(-n);
    return out(joinLines(pick));
  };
}

function sortCmd(args: string[], stdin: string, env: ShellEnv): Res {
  const o = opts(args, "kt");
  const input = inputOf("sort", o.rest, stdin, env);
  if (input.error) return err(`sort: cannot read: ${o.rest[0]}: No such file or directory`);
  const field = o.vals.k ? parseInt(o.vals.k, 10) - 1 : -1;
  const key = (l: string) => (field < 0 ? l : ((o.vals.t ? l.split(o.vals.t) : l.trim().split(/\s+/))[field] ?? ""));
  let ls = [...linesOf(input.text)].sort((a, b) => {
    const x = key(a);
    const y = key(b);
    if (o.set.has("n") || o.set.has("h")) return (parseFloat(x) || 0) - (parseFloat(y) || 0) || (x < y ? -1 : x > y ? 1 : 0);
    return x < y ? -1 : x > y ? 1 : 0;
  });
  if (o.set.has("r")) ls.reverse();
  if (o.set.has("u")) ls = ls.filter((l, i) => i === 0 || l !== ls[i - 1]);
  return out(joinLines(ls));
}

function uniq(args: string[], stdin: string): Res {
  const o = opts(args, "");
  const groups: { l: string; n: number }[] = [];
  for (const l of linesOf(stdin)) {
    const g = groups[groups.length - 1];
    if (g && g.l === l) g.n++;
    else groups.push({ l, n: 1 });
  }
  const keep = groups.filter((g) => (o.set.has("d") ? g.n > 1 : o.set.has("u") ? g.n === 1 : true));
  return out(joinLines(keep.map((g) => (o.set.has("c") ? `${String(g.n).padStart(7)} ${g.l}` : g.l))));
}

function wc(args: string[], stdin: string, env: ShellEnv): Res {
  const o = opts(args, "");
  const input = inputOf("wc", o.rest, stdin, env);
  if (input.error) return err(input.error);
  const t = input.text;
  const n = { l: (t.match(/\n/g) ?? []).length, w: t.split(/\s+/).filter(Boolean).length, c: new TextEncoder().encode(t).length };
  const which = ["l", "w", "c"].filter((x) => o.set.has(x) || (x === "c" && o.set.has("m")));
  const cols = which.length ? which : ["l", "w", "c"];
  if (cols.length === 1) return out(String(n[cols[0] as "l"]));
  return out(cols.map((x) => String(n[x as "l"]).padStart(7)).join(" "));
}

/** tr SET1 SET2, tr -d SET: with a-z style ranges. */
function trCmd(args: string[], stdin: string): Res {
  const o = opts(args, "");
  const expand = (s = "") => s.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/(.)-(.)/g, (_, a: string, b: string) => Array.from({ length: Math.max(0, b.charCodeAt(0) - a.charCodeAt(0) + 1) }, (_, i) => String.fromCharCode(a.charCodeAt(0) + i)).join(""));
  const a = expand(o.rest[0]);
  if (!o.rest[0]) return err("tr: missing operand\nTry 'tr --help' for more information.");
  if (o.set.has("d")) return passthrough([...stdin].filter((ch) => !a.includes(ch)).join(""));
  if (o.rest[1] === undefined) return err(`tr: missing operand after '${o.rest[0]}'\nTwo strings must be given when translating.\nTry 'tr --help' for more information.`);
  const b = expand(o.rest[1]);
  let res = [...stdin].map((ch) => (a.includes(ch) ? (b[a.indexOf(ch)] ?? b[b.length - 1] ?? "") : ch)).join("");
  if (o.set.has("s")) res = res.replace(new RegExp(`([${b.replace(/[\]\\^-]/g, "\\$&")}])\\1+`, "g"), "$1");
  return passthrough(res);
}

function cut(args: string[], stdin: string, env: ShellEnv): Res {
  const o = opts(args, "dfc");
  const input = inputOf("cut", o.rest, stdin, env);
  if (input.error) return err(input.error);
  const list = o.vals.f ?? o.vals.c;
  if (!list) return err("cut: you must specify a list of bytes, characters, or fields\nTry 'cut --help' for more information.");
  const want = (i: number) =>
    list.split(",").some((r) => {
      const [a, b] = r.split("-");
      if (b === undefined) return i === parseInt(a, 10);
      return i >= (a ? parseInt(a, 10) : 1) && i <= (b ? parseInt(b, 10) : Infinity);
    });
  const d = o.vals.d ?? "\t";
  return out(joinLines(linesOf(input.text).map((l) => (o.vals.c ? [...l].filter((_, i) => want(i + 1)).join("") : !l.includes(d) ? l : l.split(d).filter((_, i) => want(i + 1)).join(d)))));
}

function awk(args: string[], stdin: string, env: ShellEnv): Res {
  const o = opts(args, "F");
  const [prog, ...files] = o.rest;
  const m = (prog ?? "").match(/^\s*(?:NR\s*>\s*(\d+)\s*)?\{\s*print\s*(.*?)\s*;?\s*\}\s*$/);
  if (!m) return err("awk: the simulator's awk runs '{print $N, …}' programs (optionally NR>1 {print …}).");
  const input = inputOf("awk", files, stdin, env);
  if (input.error) return err(`awk: cannot open "${files[0]}" (No such file or directory)`);
  const after = m[1] ? parseInt(m[1], 10) : 0;
  const parts = m[2] ? m[2].match(/\$\d+|"[^"]*"|,/g) ?? [] : ["$0"];
  const sep = o.vals.F;
  return out(
    joinLines(
      linesOf(input.text)
        .filter((_, i) => i + 1 > after)
        .map((l) => {
          const fields = sep ? l.split(sep) : l.trim().split(/\s+/);
          // print $1, $2 joins with a space (OFS); adjacent items concatenate.
          return parts.map((p) => (p === "," ? " " : p.startsWith('"') ? p.slice(1, -1) : p === "$0" ? l : (fields[parseInt(p.slice(1), 10) - 1] ?? ""))).join("");
        }),
    ),
  );
}

function b64(args: string[], stdin: string): Res {
  const decode = args.includes("-d") || args.includes("--decode") || args.includes("-D");
  if (decode) {
    try {
      return { chunks: [{ fd: 1, text: decodeURIComponent(escape(atob(stdin.replace(/\s+/g, "")))), nl: false }], ok: true };
    } catch {
      return err("base64: invalid input");
    }
  }
  const enc = btoa(unescape(encodeURIComponent(stdin)));
  const wrap = args.some((a) => /^(-w0|--wrap=0)$/.test(a)) || (args.includes("-w") && args[args.indexOf("-w") + 1] === "0") ? enc : enc.replace(/(.{76})/g, "$1\n").replace(/\n$/, "");
  return out(wrap);
}

function echo(args: string[]): Res {
  let i = 0;
  let nl = true;
  let esc = false;
  while (i < args.length && /^-[neE]+$/.test(args[i])) {
    if (args[i].includes("n")) nl = false;
    if (args[i].includes("e")) esc = true;
    if (args[i].includes("E")) esc = false;
    i++;
  }
  let text = args.slice(i).join(" ");
  if (esc) text = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\\\/g, "\\");
  return { chunks: [{ fd: 1, text, nl }], ok: true };
}

// ---------------------------------------------------------------- the shell's own builtins

/** `alias name='value'`, the way bash prints it (single quotes, an embedded ' written '\''). */
const aliasLine = (name: string, value: string) => `alias ${name}='${value.replace(/'/g, "'\\''")}'`;

/** bash's alias names: no blanks, slashes, quotes, `$`, `=` or other shell metacharacters. */
const legalAliasName = (n: string) => n.length > 0 && !/[\s/$`'"\\=<>|&;()*?[\]!{}~#]/.test(n);

function aliasCmd(args: string[], _s: string, env: ShellEnv): Res {
  const sh = stateOf(env);
  const names = args.filter((a) => a !== "-p");
  if (!names.length) {
    const lines = [...sh.aliases.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => aliasLine(k, v));
    return out(lines.join("\n"));
  }
  const res: Chunk[] = [];
  let ok = true;
  for (const a of names) {
    const eq = a.indexOf("=");
    if (eq > 0) {
      const name = a.slice(0, eq);
      if (!legalAliasName(name)) {
        res.push({ fd: 2, text: `bash: ${where(sh)}alias: \`${name}': invalid alias name` });
        ok = false;
      } else sh.aliases.set(name, a.slice(eq + 1));
    } else if (sh.aliases.has(a)) res.push({ fd: 1, text: aliasLine(a, sh.aliases.get(a)!) });
    else {
      // A name with no "=" (or an empty name before it) is a request to print that alias.
      res.push({ fd: 2, text: `bash: ${where(sh)}alias: ${a}: not found` });
      ok = false;
    }
  }
  return { chunks: res, ok };
}

function unaliasCmd(args: string[], _s: string, env: ShellEnv): Res {
  const sh = stateOf(env);
  if (args.includes("-a")) {
    sh.aliases.clear();
    return out("");
  }
  if (!args.length) return err("unalias: usage: unalias [-a] name [name ...]");
  const res: Chunk[] = [];
  let ok = true;
  for (const a of args) {
    if (!sh.aliases.delete(a)) {
      res.push({ fd: 2, text: `bash: ${where(sh)}unalias: ${a}: not found` });
      ok = false;
    }
  }
  return { chunks: res, ok };
}

function exportCmd(args: string[], _s: string, env: ShellEnv): Res {
  const sh = stateOf(env);
  const names = args.filter((a) => a !== "-p");
  if (!names.length) {
    const rows = [...sh.vars.entries()].filter(([, v]) => v.exported).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `declare -x ${k}="${v.value.replace(/(["\\$`])/g, "\\$1")}"`);
    return out(rows.join("\n"));
  }
  const res: Chunk[] = [];
  let ok = true;
  for (const a of names) {
    const eq = a.indexOf("=");
    const name = eq < 0 ? a : a.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      res.push({ fd: 2, text: `bash: ${where(sh)}export: \`${a}': not a valid identifier` });
      ok = false;
      continue;
    }
    sh.vars.set(name, { value: eq < 0 ? (sh.vars.get(name)?.value ?? "") : a.slice(eq + 1), exported: true });
  }
  return { chunks: res, ok };
}

function unsetCmd(args: string[], _s: string, env: ShellEnv): Res {
  const sh = stateOf(env);
  const res: Chunk[] = [];
  let ok = true;
  for (const a of args.filter((x) => !/^-[vfn]$/.test(x))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(a)) {
      res.push({ fd: 2, text: `bash: ${where(sh)}unset: \`${a}': not a valid identifier` });
      ok = false;
    } else sh.vars.delete(a);
  }
  return { chunks: res, ok };
}

const envLines = (sh: ShellState) => [...sh.vars.entries()].filter(([, v]) => v.exported).map(([k, v]) => `${k}=${v.value}`);

/** How deep `source` may nest: a file that sources itself ends with a message instead of a stack overflow. */
const SOURCE_DEPTH_MAX = 100;

function sourceCmd(args: string[], _s: string, env: ShellEnv): Res {
  const sh = stateOf(env);
  const name = args.filter((a) => a !== "-p")[0];
  if (!name) return err("bash: .: filename argument required\n.: usage: . [-p path] filename [arguments]");
  const text = env.files[fileName(name)];
  if (text === undefined) return err(`bash: ${where(sh)}${name}: No such file or directory`);
  if ((sh.sourceDepth ?? 0) >= SOURCE_DEPTH_MAX) return err(`bash: ${name}: maximum source depth exceeded`);
  const saved = sh.src;
  sh.src = { file: name.startsWith("/") || name.startsWith("~") ? name : `${HOME}/${fileName(name)}`, line: 1 };
  sh.sourceDepth = (sh.sourceDepth ?? 0) + 1;
  try {
    return runScript(env, text);
  } finally {
    sh.src = saved;
    sh.sourceDepth--;
  }
}

/** nano / vi / vim: open the YAML editor tab, which behaves like that tool (nano's shortcuts, vim's keys); flags are accepted and ignored. */
function editorCmd(tool: string): Builtin {
  // Options that take a value of their own when written apart from the flag: nano's -T -r -Y -z, vim's -c -S -u -i -s -w -W -t -T and --cmd.
  const takesValue = tool === "nano" ? /^-[Trz]$|^-Y$/ : /^-[cSuiswWtT]$|^--cmd$/;
  return (args, _s, env) => {
    let file: string | undefined;
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === "--") {
        file = args[i + 1];
        break;
      }
      if (takesValue.test(a)) i++;
      else if (!a.startsWith("-") && !a.startsWith("+")) {
        file = a;
        break;
      }
    }
    const name = file ? fileName(file) : "manifest.yaml";
    // A file on a Node's host is only editable by a user who may write it.
    if (env.host?.owns(name)) env.host.checkEdit(name);
    // Like the real tools, nothing is printed and a new file is only created when it is first saved: the editor takes over the screen.
    return { chunks: [], ok: true, openFile: name, editor: tool === "nano" ? "nano" : "vi" };
  };
}


/** `-rw-------` / `drwxr-xr-x`, from a host entry's mode bits. */
function modeString(e: { dir: boolean; mode: number }): string {
  const bits = "rwxrwxrwx";
  return (e.dir ? "d" : "-") + [...bits].map((ch, i) => (e.mode & (1 << (8 - i)) ? ch : "-")).join("");
}

/** ls -l's date column: `Nov  9 01:31`. */
function lsDate(simMs: number): string {
  return lsStamp(simMs);
}

/** mv and cp over the Learner's files and, on a node host, the Node's: the target may be a directory; `-p` keeps mode and time. */
function moveOrCopy(tool: "mv" | "cp", args: string[], env: ShellEnv): Res {
  const o = opts(args, "t");
  const preserve = o.set.has("p") || o.set.has("a");
  const names = [...o.rest];
  if (names.length < 2) return err(names.length ? `${tool}: missing destination file operand after '${names[0]}'\nTry '${tool} --help' for more information.` : `${tool}: missing file operand\nTry '${tool} --help' for more information.`);
  const target = names.pop()!;
  const tn = fileName(target);
  const targetIsDir = tn === "." || !!(env.host?.owns(tn) && env.host.isDir(tn));
  if (names.length > 1 && !targetIsDir) return err(`${tool}: target '${target}' is not a directory`);
  const res: Chunk[] = [];
  let ok = true;
  const fail = (text: string) => {
    res.push({ fd: 2, text });
    ok = false;
  };
  for (const src of names) {
    const sn = fileName(src);
    const base = sn.slice(sn.lastIndexOf("/") + 1);
    const dst = targetIsDir ? (tn === "." ? base : `${tn.replace(/\/$/, "")}/${base}`) : tn;
    const srcHost = env.host?.owns(sn) ?? false;
    const dstHost = env.host?.owns(dst) ?? false;
    try {
      if (srcHost && env.host!.isDir(sn)) {
        fail(tool === "cp" ? `cp: -r not specified; omitting directory '${src}'` : `mv: cannot move '${src}': moving directories is not simulated`);
        continue;
      }
      if (srcHost && dstHost) {
        if (!env.host!.ls(sn)) fail(`${tool}: cannot stat '${src}': No such file or directory`);
        else if (tool === "mv") env.host!.move(sn, dst);
        else env.host!.copy(sn, dst, preserve);
        continue;
      }
      const text = env.files[sn];
      if (text === undefined) {
        fail(`${tool}: cannot stat '${src}': No such file or directory`);
        continue;
      }
      env.files[dst] = text;
      if (tool === "mv") delete env.files[sn];
    } catch (e) {
      if (!(e instanceof FsError)) throw e;
      fail(`${tool}: ${tool === "mv" ? "cannot move" : "cannot create regular file"} '${e.path === sn ? src : e.path}': ${FS_TEXT[e.kind]}`);
    }
  }
  return { chunks: res, ok };
}

/** sudo: runs a command as root (on a node host that means the host's root privileges), or `sudo -i` opens a root shell inside the current login. */
function sudoCmd(args: string[], stdin: string, env: ShellEnv): Res {
  const rest = [...args];
  let login = false;
  while (rest.length && rest[0].startsWith("-")) {
    const f = rest.shift()!;
    if (f === "--") break;
    if (f === "-i" || f === "-s" || /^-[a-z]*[is]$/.test(f)) login = true;
    if (f === "-u" || f === "-g") rest.shift();
  }
  const shells = ["bash", "sh", "/bin/bash", "/bin/sh"];
  // A root shell: `sudo -i`, `sudo -s`, `sudo su [-]` or `sudo bash`.
  const rootShell = !rest.length ? login : rest[0] === "su" || (shells.includes(rest[0]) && rest.length === 1);
  const sh = stateOf(env);
  if (rootShell) {
    const cur = sh.sessions.at(-1);
    if (!cur) return err("sudo: a root shell is only available on a node: ssh to one first.");
    if (cur.user === "root") return out("");
    sh.sessions.push({ node: cur.node, user: "root", via: "sudo" });
    return out("");
  }
  if (!rest.length) return err("usage: sudo -h | -K | -k | -V\nusage: sudo [-ABbEHnPS] [-r role] [-t type] [-C num] [-D dir] [-g group] [-h host] [-p prompt] [-R dir] [-T timeout] [-u user] [VAR=value] [-i | -s] [<command>]");
  const run = () => runSimple(env, rest, stdin, rest.join(" "));
  const r = env.host ? env.host.asRoot(run) : run();
  return r.watch ? { ...r, watch: `sudo ${r.watch}` } : r;
}

const BUILTINS: Record<string, Builtin> = {
  echo: (a) => echo(a),
  ls: (args, _s, env) => {
    const flags = args.filter((a) => a.startsWith("-") && !a.startsWith("--")).join("");
    const all = flags.includes("a");
    const long = flags.includes("l");
    const operands = args.filter((a) => !a.startsWith("-"));
    if (operands.length) {
      const res: Chunk[] = [];
      let ok = true;
      for (const o of operands) {
        const n = fileName(o);
        const hit = env.host?.owns(n) ? env.host.ls(n) : undefined;
        if (env.host?.owns(n)) {
          if (!hit) {
            res.push({ fd: 2, text: `ls: cannot access '${o}': No such file or directory` });
            ok = false;
          } else if (!long) res.push({ fd: 1, text: hit.dir ? hit.entries.filter((e) => all || !e.name.startsWith(".")).map((e) => e.name).join("  ") : o });
          else {
            const rows = hit.entries.filter((e) => all || !e.name.startsWith("."));
            const width = Math.max(1, ...rows.map((e) => String(e.size).length));
            const lines = rows.map((e) => `${modeString(e)} ${e.dir ? 2 : 1} root root ${String(e.size).padStart(width)} ${lsDate(e.mtime)} ${hit.dir ? e.name : o}`);
            if (hit.dir) lines.unshift(`total ${rows.reduce((t, e) => t + (e.dir ? 4 : Math.max(1, Math.ceil(e.size / 4096)) * 4), 0)}`);
            res.push({ fd: 1, text: lines.join("\n") });
          }
        } else if (n === ".") res.push({ fd: 1, text: Object.keys(env.files).filter((k) => all || !k.startsWith(".")).sort().join("  ") });
        else if (env.files[n] !== undefined) res.push({ fd: 1, text: o });
        else {
          res.push({ fd: 2, text: `ls: cannot access '${o}': No such file or directory` });
          ok = false;
        }
      }
      return { chunks: res, ok };
    }
    return out(Object.keys(env.files).filter((k) => all || !k.startsWith(".")).sort().join("  "));
  },
  mv: (args, _s, env) => moveOrCopy("mv", args, env),
  cp: (args, _s, env) => moveOrCopy("cp", args, env),
  sudo: (args, stdin, env) => sudoCmd(args, stdin, env),
  pwd: () => out(HOME),
  alias: aliasCmd,
  unalias: unaliasCmd,
  export: exportCmd,
  unset: unsetCmd,
  env: (_a, _s, env) => out(envLines(stateOf(env)).join("\n")),
  printenv: (args, _s, env) => {
    const sh = stateOf(env);
    if (!args.length) return out(envLines(sh).join("\n"));
    const vals = args.map((a) => (sh.vars.get(a)?.exported ? sh.vars.get(a)!.value : undefined));
    return { chunks: vals.filter((v): v is string => v !== undefined).map((v) => ({ fd: 1 as const, text: v })), ok: vals.every((v) => v !== undefined) };
  },
  source: sourceCmd,
  ".": sourceCmd,
  // Lines of a typical exam ~/.bashrc: the simulator has no completion, options or signals to set, so they succeed quietly.
  complete: () => out(""),
  set: () => out(""),
  shopt: () => out(""),
  trap: () => out(""),
  nano: editorCmd("nano"),
  vi: editorCmd("vi"),
  vim: editorCmd("vim"),
  cat: (args, stdin, env) => {
    const files = args.filter((a) => a !== "-" && !/^-[a-zA-Z]+$/.test(a));
    if (!files.length) return passthrough(stdin);
    const parts: Chunk[] = [];
    let ok = true;
    for (const f of files) {
      const v = env.files[fileName(f)];
      if (v === undefined) {
        parts.push({ fd: 2, text: `cat: ${f}: No such file or directory` });
        ok = false;
      } else parts.push({ fd: 1, text: v.replace(/\n$/, "") });
    }
    return { chunks: parts, ok };
  },
  rm: (args, _s, env) => {
    const force = args.some((a) => /^-[a-zA-Z]*f/.test(a));
    const files = args.filter((a) => !a.startsWith("-"));
    if (!files.length) return err("rm: missing operand\nTry 'rm --help' for more information.");
    for (const f of files) {
      if (env.files[fileName(f)] === undefined) {
        if (force) continue;
        return err(`rm: cannot remove '${f}': No such file or directory`);
      }
      delete env.files[fileName(f)];
    }
    return out("");
  },
  tee: (args, stdin, env) => {
    const append = args.includes("-a");
    for (const f of args.filter((a) => !a.startsWith("-"))) env.files[fileName(f)] = (append ? (env.files[fileName(f)] ?? "") : "") + stdin;
    return passthrough(stdin);
  },
  grep: (a, s, env) => grep(a, s, env),
  egrep: (a, s, env) => grep(["-E", ...a], s, env),
  head: headTail("head"),
  tail: headTail("tail"),
  wc: (a, s, env) => wc(a, s, env),
  sort: (a, s, env) => sortCmd(a, s, env),
  uniq: (a, s) => uniq(a, s),
  tr: (a, s) => trCmd(a, s),
  cut: (a, s, env) => cut(a, s, env),
  awk: (a, s, env) => awk(a, s, env),
  base64: (a, s) => b64(a, s),
  less: (_a, s) => passthrough(s),
  more: (_a, s) => passthrough(s),
  true: () => out(""),
  false: () => ({ chunks: [], ok: false }),
  jq: () => err("jq isn't in the simulator: use -o jsonpath='{...}' instead"),
  xargs: (args, stdin, env, text) => {
    const items = stdin.split(/\s+/).filter(Boolean);
    if (!args.length) return out(items.join(" "));
    if (!items.length) return out("");
    return runSimple(env, [...args, ...items], undefined, `${text.replace(/^xargs\s+/, "")} ${items.join(" ")}`);
  },
};

/** The commands the shell itself provides (for Tab completion and help). */
export const SHELL_BUILTINS = Object.keys(BUILTINS);
