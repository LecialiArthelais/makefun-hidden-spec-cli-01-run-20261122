// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Moves a successful move edit made, as [old, new] pairs, for the `R` output lines. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- SPEC.md section 5: matching lines ----------

const trimEndWs = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBothWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

/** A file's text as lines: its line break, its lines, whether it ends with a break. */
interface FileText {
  br: string;
  lines: string[];
  finalBr: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { br: '\n', lines: [], finalBr: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  const finalBr = text.endsWith(br);
  if (finalBr) lines.pop();
  return { br, lines, finalBr };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBr ? f.br : '');
}

function tierMatch(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndWs(a) === trimEndWs(b);
  return trimBothWs(a) === trimBothWs(b);
}

/** 0-based positions, at or after `from`, where o occurs in lines at the tier; occurrences may overlap. */
function occurrences(lines: string[], o: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = Math.max(0, from); i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!tierMatch(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, or 0..2) at which o occurs at least once, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0, eofOnly = false): { tier: number; pos: number[] } | null {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    let pos = occurrences(lines, o, t, from);
    if (eofOnly) pos = pos.filter((p) => p + o.length === lines.length);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One body line of a hunk or chunk: context, old or new, with its patch text. */
interface Op {
  kind: 'ctx' | 'old' | 'new';
  text: string;
  /** A `\` line follows this body line. */
  noNL: boolean;
}

/** Old lines, new lines, and for each new line the old index when it is a context line. */
interface ReplaceSpec {
  o: string[];
  n: string[];
  ctxOfN: (number | null)[];
}

function specOf(ops: Op[]): ReplaceSpec {
  const o: string[] = [];
  const n: string[] = [];
  const ctxOfN: (number | null)[] = [];
  for (const op of ops) {
    if (op.kind === 'ctx') {
      ctxOfN.push(o.length);
      o.push(op.text);
      n.push(op.text);
    } else if (op.kind === 'old') {
      o.push(op.text);
    } else {
      ctxOfN.push(null);
      n.push(op.text);
    }
  }
  return { o, n, ctxOfN };
}

/** Replace the o lines at pos by the spec's new lines, honouring section 5. Only for a non-empty o. */
function applyReplace(lines: string[], spec: ReplaceSpec, pos: number, tier: number): string[] {
  const f = lines[pos] === undefined ? '' : leadWs(lines[pos]!);
  const p = spec.o.length === 0 ? '' : leadWs(spec.o[0]!);
  const written = spec.n.map((t, i) => {
    const oi = spec.ctxOfN[i]!;
    if (oi !== null) return lines[pos + oi]!;
    if (tier === 2 && t.trim() !== '' && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
  return [...lines.slice(0, pos), ...written, ...lines.slice(pos + spec.o.length)];
}

// ---------- SPEC.md section 6: unified diffs ----------

interface Hunk {
  a: number;
  ops: Op[];
  oLen: number;
  nLen: number;
}

/**
 * Whether a `\` line follows the hunk's last context-or-`+` line, or, when plusOnly, its last `+` line.
 * A `\` after a `-` line says nothing about the result, so `-` lines are skipped.
 */
function hunkNoNL(h: Hunk, plusOnly: boolean): boolean {
  for (let i = h.ops.length - 1; i >= 0; i--) {
    const op = h.ops[i]!;
    if (op.kind === 'new' || (!plusOnly && op.kind === 'ctx')) return op.noNL;
  }
  return false;
}

interface Section {
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  renFrom: string | null;
  renTo: string | null;
  diffOld: string | null;
  diffNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function sectionPaths(s: Section): { oldP: string | null; newP: string | null } {
  if (s.hasPair) return { oldP: s.pairOld, newP: s.pairNew };
  return { oldP: s.renFrom ?? s.diffOld, newP: s.renTo ?? s.diffNew };
}

/** The path after `--- ` or `+++ `, or null for /dev/null. */
function diffPath(line: string): string | null {
  const p = line.slice(4).split('\t')[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(\S+) b\/(\S+)$/;

/** One hunk applied to a file: the result's lines and whether it ends with a line break. */
function applyHunkTo(file: FileText, hunk: Hunk, d: number, strict: boolean, path: string): FileText {
  const spec = specOf(hunk.ops);
  if (spec.o.length === 0) {
    const at = Math.min(hunk.a + d, file.lines.length);
    const lines = [...file.lines.slice(0, at), ...spec.n, ...file.lines.slice(at)];
    return { br: file.br, lines, finalBr: at === file.lines.length ? !hunkNoNL(hunk, false) : file.finalBr };
  }
  const found = findTier(file.lines, spec.o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.pos[0]!;
  for (const p of found.pos) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const lines = applyReplace(file.lines, spec, best, found.tier);
  const runsToEnd = best + spec.o.length === file.lines.length;
  return { br: file.br, lines, finalBr: runsToEnd ? !hunkNoNL(hunk, false) : file.finalBr };
}

function unifiedEdit(s: Section, strict: boolean): Edit {
  const { oldP, newP } = sectionPaths(s);
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (s.isCreate || oldP === null) {
      if (newP === null) return;
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const added: string[] = [];
      for (const h of s.hunks) for (const op of h.ops) if (op.kind === 'new') added.push(op.text);
      let noNL = false;
      for (let hi = s.hunks.length - 1; hi >= 0; hi--) {
        const h = s.hunks[hi]!;
        if (h.ops.some((op) => op.kind === 'new')) {
          noNL = hunkNoNL(h, true);
          break;
        }
      }
      tree.now.set(newP, added.length === 0 ? '' : added.join('\n') + (noNL ? '' : '\n'));
      return;
    }
    if (s.isDelete || newP === null) {
      if (tree.get(oldP!) === null) throw new Fail('missing', oldP!);
      tree.now.set(oldP!, null);
      return;
    }
    if (oldP !== newP) {
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      let file = splitFile(tree.get(oldP)!);
      let d = 0;
      for (const h of s.hunks) {
        file = applyHunkTo(file, h, d, strict, oldP);
        d += h.nLen - h.oLen;
      }
      tree.now.set(oldP, null);
      tree.now.set(newP, joinFile(file));
      tree.moves.push([oldP, newP]);
      return;
    }
    if (tree.get(oldP) === null) throw new Fail('missing', oldP);
    let file = splitFile(tree.get(oldP)!);
    let d = 0;
    for (const h of s.hunks) {
      file = applyHunkTo(file, h, d, strict, oldP);
      d += h.nLen - h.oLen;
    }
    tree.now.set(oldP, joinFile(file));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inBody = false;
  const startSection = (s: Section): void => {
    sections.push(s);
    cur = s;
    inBody = false;
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      startSection({
        pairOld: null,
        pairNew: null,
        hasPair: false,
        renFrom: null,
        renTo: null,
        diffOld: m[1]!,
        diffNew: m[2]!,
        isCreate: false,
        isDelete: false,
        hunks: [],
      });
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_HEAD.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const raw: string[] = [];
      i++;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.startsWith('diff --git ')) break;
        if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (l.startsWith('@@')) break;
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\')) {
          raw.push(l);
          i++;
          continue;
        }
        break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      const ops: Op[] = [];
      for (const l of raw) {
        if (l.startsWith('\\')) {
          if (ops.length > 0) ops[ops.length - 1]!.noNL = true;
          continue;
        }
        if (l === '') ops.push({ kind: 'ctx', text: '', noNL: false });
        else if (l.startsWith(' ')) ops.push({ kind: 'ctx', text: l.slice(1), noNL: false });
        else if (l.startsWith('-')) ops.push({ kind: 'old', text: l.slice(1), noNL: false });
        else ops.push({ kind: 'new', text: l.slice(1), noNL: false });
      }
      const spec = specOf(ops);
      cur.hunks.push({ a: Number(m[1]), ops, oLen: spec.o.length, nLen: spec.n.length });
      inBody = true;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !inBody && !cur.hasPair) {
        cur.pairOld = diffPath(line);
        cur.pairNew = diffPath(lines[i + 1]!);
        cur.hasPair = true;
        i += 2;
        continue;
      }
      startSection({
        pairOld: diffPath(line),
        pairNew: diffPath(lines[i + 1]!),
        hasPair: true,
        renFrom: null,
        renTo: null,
        diffOld: null,
        diffNew: null,
        isCreate: false,
        isDelete: false,
        hunks: [],
      });
      i += 2;
      continue;
    }
    if (cur !== null && !inBody) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.isCreate = true;
      else if (line.startsWith('deleted file mode')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---------- SPEC.md section 7: SEARCH/REPLACE blocks ----------

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const file = splitFile(text);
    const found = findTier(file.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const spec: ReplaceSpec = { o: oldLines, n: newLines, ctxOfN: newLines.map(() => null) };
    const out = applyReplace(file.lines, spec, found.pos[0]!, found.tier);
    tree.now.set(path, joinFile({ br: file.br, lines: out, finalBr: file.finalBr }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevPath: string | null = null;
  let searchFrom = 0;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchLine = i;
    let path: string | null = null;
    for (let j = searchLine - 1; j >= searchFrom; j--) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${searchLine + 1}`);
    let eq = -1;
    for (let j = searchLine + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${searchLine + 1}`);
    edits.push(searchReplaceEdit(path, lines.slice(searchLine + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    searchFrom = rep + 1;
    i = rep + 1;
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// ---------- SPEC.md section 8: V4A patches ----------

interface Chunk {
  anchor: string | null;
  eof: boolean;
  ops: Op[];
}

const V4A_SECTION_START = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

function findAnchor(lines: string[], anchor: string, from: number, strict: boolean): number {
  const max = strict ? 0 : 2;
  for (let t = 0; t <= max; t++) {
    for (let i = from; i < lines.length; i++) {
      if (tierMatch(lines[i]!, anchor, t)) return i;
    }
  }
  return -1;
}

function v4aUpdateEdit(path: string, moveTo: string | null, chunks: Chunk[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    let file = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(file.lines, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const spec = specOf(ch.ops);
      if (spec.o.length === 0) {
        const at = ch.eof ? file.lines.length : cursor;
        const lines = [...file.lines.slice(0, at), ...spec.n, ...file.lines.slice(at)];
        file = { br: file.br, lines, finalBr: file.finalBr };
        cursor = at + spec.n.length;
        continue;
      }
      const found = findTier(file.lines, spec.o, strict, cursor, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const pos = found.pos[0]!;
      const lines = applyReplace(file.lines, spec, pos, found.tier);
      file = { br: file.br, lines, finalBr: file.finalBr };
      cursor = pos + spec.n.length;
    }
    const out = joinFile(file);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    if (V4A_SECTION_START(line)) {
      const isAdd = line.startsWith('*** Add File: ');
      const isDel = line.startsWith('*** Delete File: ');
      const path = line.slice(line.indexOf(': ') + 2).trim();
      const start = i;
      i++;
      const raw: { text: string; idx: number }[] = [];
      while (i < last && !V4A_SECTION_START(lines[i]!)) {
        raw.push({ text: lines[i]!, idx: i });
        i++;
      }
      while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
      if (isAdd) {
        const fileLines: string[] = [];
        for (const r of raw) {
          if (r.text === '') fileLines.push('');
          else if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
          else throw new Exit2(`error: parse ${r.idx + 1}`);
        }
        edits.push(v4aAddEdit(path, fileLines));
      } else if (isDel) {
        for (const r of raw) {
          if (!blank(r.text)) throw new Exit2(`error: parse ${r.idx + 1}`);
        }
        edits.push(v4aDeleteEdit(path));
      } else {
        let moveTo: string | null = null;
        let k = 0;
        if (k < raw.length && raw[k]!.text.startsWith('*** Move to: ')) {
          moveTo = raw[k]!.text.slice('*** Move to: '.length).trim();
          k++;
        }
        const chunks: Chunk[] = [];
        let cur: Chunk | null = null;
        const open = (anchor: string | null): void => {
          if (cur !== null) chunks.push(cur);
          cur = { anchor, eof: false, ops: [] };
        };
        while (k < raw.length) {
          const r = raw[k]!;
          const t = r.text;
          if (t.startsWith('@@')) {
            const anchor = t.slice(2).trim();
            open(anchor === '' ? null : anchor);
            k++;
            continue;
          }
          if (t.trimEnd() === '*** End of File') {
            if (cur === null) open(null);
            cur!.eof = true;
            chunks.push(cur!);
            cur = null;
            k++;
            continue;
          }
          if (t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+')) {
            if (cur === null) {
              if (chunks.length > 0) throw new Exit2(`error: parse ${r.idx + 1}`);
              open(null);
            }
            if (t === '') cur!.ops.push({ kind: 'ctx', text: '', noNL: false });
            else if (t.startsWith(' ')) cur!.ops.push({ kind: 'ctx', text: t.slice(1), noNL: false });
            else if (t.startsWith('-')) cur!.ops.push({ kind: 'old', text: t.slice(1), noNL: false });
            else cur!.ops.push({ kind: 'new', text: t.slice(1), noNL: false });
            k++;
            continue;
          }
          throw new Exit2(`error: parse ${r.idx + 1}`);
        }
        if (cur !== null) chunks.push(cur);
        if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${start + 1}`);
        edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
      }
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { p: string; was: string | null; now: string | null }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    changed.push({ p, was, now });
  }
  const moveNew = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    const oc = changed.find((c) => c.p === o);
    const nc = changed.find((c) => c.p === n);
    if (oc !== undefined && nc !== undefined && oc.was !== null && oc.now === null && nc.was === null && nc.now !== null) moveNew.set(o, n);
  }
  const rows: { key: string; text: string }[] = [];
  for (const c of changed) {
    if (moveNew.has(c.p)) {
      rows.push({ key: moveNew.get(c.p)!, text: `R ${c.p} -> ${moveNew.get(c.p)!}` });
      continue;
    }
    if ([...moveNew.values()].includes(c.p)) continue;
    rows.push({ key: c.p, text: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const outRows = rows.map((r) => r.text);
  if (!check) {
    for (const c of changed) {
      if (c.now === null) rmSync(c.p, { force: true });
      else {
        mkdirSync(dirname(c.p), { recursive: true });
        writeFileSync(c.p, c.now);
      }
    }
  }
  return { code: 0, out: [...outRows, `ok: ${outRows.length} ${outRows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
