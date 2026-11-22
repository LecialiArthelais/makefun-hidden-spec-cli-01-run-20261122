// mend — one patch tool for every AI edit format.
//
// Written fresh from SPEC.md (version 1) in the kit. It reads a patch in one
// of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits),
// finds the lines each edit names at the first of three matching tiers, and
// writes every change or none. Node 22, standard library only; run it as
// `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below).

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/** A patch that cannot be read in its format: `error: parse <line>`. */
class ParseError extends Error {
  readonly line: number;
  constructor(line: number) {
    super(`error: parse ${line}`);
    this.line = line;
  }
}

/** One edit that failed: `error: <code> <path>`. */
class EditFail extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    super(`error: ${code} ${path}`);
    this.code = code;
    this.path = path;
  }
}

const isBlank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC section 3): split at `\n`, one trailing `\r` off
 * each line, no empty piece after a final `\n`. */
function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it is not empty, does not start with `/`, holds no
 * `\`, and none of its `/`-separated segments is empty, `.` or `..`. */
function isSafePath(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file, split the way SPEC section 3 says: its line break is CRLF when
 * its first line feed follows a carriage return, LF otherwise. */
interface FileState {
  br: '\r\n' | '\n';
  lines: string[];
  finalBreak: boolean;
}

function parseFile(text: string): FileState {
  if (text === '') return { br: '\n', lines: [], finalBreak: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const finalBreak = text.endsWith(br);
  if (finalBreak) parts.pop();
  return { br, lines: parts, finalBreak };
}

function renderFile(f: FileState): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.finalBreak ? f.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted),
 * the rest read from disk on first use. */
class Tree {
  private readonly origCache = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();

  original(p: string): string | null {
    if (!this.origCache.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.origCache.set(p, v);
    }
    return this.origCache.get(p)!;
  }

  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }

  set(p: string, text: string | null): void {
    this.now.set(p, text);
  }
}

/** One edit: a closure over its parsed form that runs against the tree and
 * records a successful move in `moves` as [old, new]. It throws EditFail
 * when it fails and touches nothing else on failure. */
type Edit = (tree: Tree, moves: Array<[string, string]>) => void;

// ---------------------------------------------------------------------------
// Section 5: matching lines at three tiers.
// ---------------------------------------------------------------------------

/** A line as a tier sees it: tier 0 exact, tier 1 trailing spaces/tabs off,
 * tier 2 leading and trailing spaces/tabs off. */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/** Every 0-based position where O occurs in `lines` at `tier`, at or after
 * `from`. Occurrences may overlap. */
function occurrences(lines: string[], old: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (old.length === 0) return out;
  for (let i = from; i + old.length <= lines.length; i += 1) {
    let ok = true;
    for (let j = 0; j < old.length; j += 1) {
      if (normLine(lines[i + j]!, tier) !== normLine(old[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  occ: number[];
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs
 * at least once at or after `from`, with every occurrence there. */
function firstTier(lines: string[], old: string[], strict: boolean, from: number): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, old, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** One line of N: a context line is written as the file's own matched line
 * (its index into O), any other line as the patch wrote it, re-indented at
 * tier 2. */
interface NewLine {
  text: string;
  ctx: boolean;
  oIdx: number;
}

/** Render N at `pos` in `fileLines`, where O matched at `tier`. At tier 2
 * every other line of N is re-indented: F is the leading spaces/tabs of the
 * file's first matched line, P those of O's first line; a non-blank line of
 * N starting with P has that P replaced by F, any other line is as it is. */
function renderNew(oldLines: string[], newLines: NewLine[], fileLines: string[], pos: number, tier: number): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && oldLines.length > 0) {
    f = leadingWs(fileLines[pos]!);
    p = leadingWs(oldLines[0]!);
  }
  return newLines.map((nl) => {
    if (nl.ctx) return fileLines[pos + nl.oIdx]!;
    if (tier !== 2) return nl.text;
    const t = nl.text;
    if (t === '' || /^[ \t]*$/.test(t)) return t;
    return t.startsWith(p) ? f + t.slice(p.length) : t;
  });
}

/** Split a hunk/chunk body into O (context + old lines) and N (context +
 * new lines), each in body order. `body` holds raw body lines without `\`
 * markers. */
function splitBody(body: string[]): { oldLines: string[]; newLines: NewLine[] } {
  const oldLines: string[] = [];
  const newLines: NewLine[] = [];
  for (const r of body) {
    if (r.startsWith(' ')) {
      const oi = oldLines.length;
      oldLines.push(r.slice(1));
      newLines.push({ text: r.slice(1), ctx: true, oIdx: oi });
    } else if (r.startsWith('-')) {
      oldLines.push(r.slice(1));
    } else if (r.startsWith('+')) {
      newLines.push({ text: r.slice(1), ctx: false, oIdx: -1 });
    } else if (r === '') {
      const oi = oldLines.length;
      oldLines.push('');
      newLines.push({ text: '', ctx: true, oIdx: oi });
    }
  }
  return { oldLines, newLines };
}

// ---------------------------------------------------------------------------
// Section 1: the command line.
// ---------------------------------------------------------------------------

const FORMAT_NAMES = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

interface CliArgs {
  format: string;
  check: boolean;
  strict: boolean;
  patch: string | null;
}

/** Parse the arguments; null is a usage error. Options and PATCH may come
 * in any order; `--` ends the options. */
function parseArgs(args: string[]): CliArgs | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=')) {
        if (format !== null) return null;
        const v = a.slice('--format='.length);
        if (!FORMAT_NAMES.includes(v)) return null;
        format = v;
      } else if (a === '--check') {
        if (check) return null;
        check = true;
      } else if (a === '--strict') {
        if (strict) return null;
        strict = true;
      } else {
        return null;
      }
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return null;
  const p = pos.length === 0 ? null : pos[0]!;
  return { format: format ?? 'auto', check, strict, patch: p === '-' ? null : p };
}

// ---------------------------------------------------------------------------
// Section 4: detecting the format.
// ---------------------------------------------------------------------------

/** The first of the section 4 rules that holds, or null when none does. */
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (
    lines.some(
      (l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')),
    )
  ) {
    return 'unified';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Section 9: JSON edits.
// ---------------------------------------------------------------------------

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o['path'];
  if (typeof p !== 'string') return null;

  if (o['command'] === 'create' && typeof o['file_text'] === 'string') {
    const text = o['file_text'] as string;
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.set(p, text);
    };
  }

  if (
    o['command'] === 'str_replace' &&
    typeof o['old_str'] === 'string' &&
    (o['old_str'] as string) !== '' &&
    (o['new_str'] === undefined || typeof o['new_str'] === 'string')
  ) {
    const oldStr = o['old_str'] as string;
    const newStr = (o['new_str'] as string | undefined) ?? '';
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      // In a CRLF file the text and both strings are read with every
      // `\r\n` as `\n`, and the result is written back with `\r\n`.
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const text = toLf(before);
      const old = toLf(oldStr);
      const nw = toLf(newStr);
      let count = 0;
      for (let k = text.indexOf(old); k >= 0; k = text.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = text.indexOf(old);
      const out = text.slice(0, at) + nw + text.slice(at + old.length);
      tree.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }

  if (
    o['command'] === 'insert' &&
    typeof o['insert_line'] === 'number' &&
    Number.isInteger(o['insert_line']) &&
    typeof o['new_str'] === 'string'
  ) {
    const lineNo = o['insert_line'] as number;
    const add = splitPatch(o['new_str'] as string);
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new EditFail('missing', p);
      const f = parseFile(before);
      if (lineNo < 0 || lineNo > f.lines.length) throw new EditFail('no-match', p);
      const lines = [...f.lines];
      lines.splice(lineNo, 0, ...add);
      tree.set(p, renderFile({ br: f.br, lines, finalBreak: f.finalBreak }));
    };
  }

  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError(1);
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(v)) throw new ParseError(first + 1);
    const edits: Edit[] = [];
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseError(first + 1);
      edits.push(e);
    }
    return edits;
  }
  const edits: Edit[] = [];
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new ParseError(i + 1);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Section 6: unified diffs.
// ---------------------------------------------------------------------------

interface Hunk {
  a: number;
  oldLines: string[];
  newLines: NewLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noEol: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  plusNoEol: boolean;
}

interface UniSection {
  dgOld: string | null;
  dgNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  hdrOld: string | null;
  hdrNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path a `--- `/`+++ ` header line names: the text after the four
 * characters, up to the first tab, with surrounding spaces removed, and a
 * leading `a/` or `b/` removed. `/dev/null` means no file. */
function headerPath(line: string): string | null {
  const s = line.slice(4).split('\t')[0]!.trim();
  if (s === '/dev/null') return null;
  if (s.startsWith('a/') || s.startsWith('b/')) return s.slice(2);
  return s;
}

const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT = /^diff --git a\/(.+) b\/(.+)$/;

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let pairSeen = false;
  let fromDiffGit = false;
  const n = lines.length;
  let i = 0;

  while (i < n) {
    const line = lines[i]!;

    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT.exec(line.trimEnd());
      if (m === null) throw new ParseError(i + 1);
      cur = {
        dgOld: m[1]!,
        dgNew: m[2]!,
        renFrom: null,
        renTo: null,
        hdrOld: null,
        hdrNew: null,
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      pairSeen = false;
      fromDiffGit = true;
      i += 1;
      continue;
    }

    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && inHeader && fromDiffGit && !pairSeen) {
        cur.hdrOld = headerPath(line);
        cur.hdrNew = headerPath(lines[i + 1]!);
        pairSeen = true;
        i += 2;
        continue;
      }
      cur = {
        dgOld: null,
        dgNew: null,
        renFrom: null,
        renTo: null,
        hdrOld: headerPath(line),
        hdrNew: headerPath(lines[i + 1]!),
        isCreate: false,
        isDelete: false,
        hunks: [],
      };
      sections.push(cur);
      inHeader = true;
      pairSeen = true;
      fromDiffGit = false;
      i += 2;
      continue;
    }

    if (line.startsWith('--- ')) {
      // A lone `--- ` line inside a section's header names the line after it.
      if (cur !== null && inHeader) throw new ParseError(i + 2);
      i += 1;
      continue;
    }

    if (line.startsWith('+++ ') && cur !== null && inHeader) {
      cur.hdrNew = headerPath(line);
      i += 1;
      continue;
    }

    if (line.startsWith('@@')) {
      const hm = HUNK_HEAD.exec(line);
      if (hm === null) throw new ParseError(i + 1);
      if (cur === null) throw new ParseError(i + 1);
      const a = Number(hm[1]);
      i += 1;
      const raw: string[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('diff --git ')) break;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '' || bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl.startsWith('\\')) {
          raw.push(bl);
          i += 1;
          continue;
        }
        break;
      }
      while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
      let lastCtxPlus = -1;
      let lastPlus = -1;
      for (let j = 0; j < raw.length; j += 1) {
        if (raw[j]!.startsWith(' ') || raw[j]!.startsWith('+')) lastCtxPlus = j;
        if (raw[j]!.startsWith('+')) lastPlus = j;
      }
      const noEol =
        lastCtxPlus >= 0 && raw[lastCtxPlus + 1] !== undefined && raw[lastCtxPlus + 1]!.startsWith('\\');
      const plusNoEol =
        lastPlus >= 0 && raw[lastPlus + 1] !== undefined && raw[lastPlus + 1]!.startsWith('\\');
      const body = raw.filter((r) => !r.startsWith('\\'));
      const { oldLines, newLines } = splitBody(body);
      cur.hunks.push({ a, oldLines, newLines, noEol, plusNoEol });
      inHeader = false;
      continue;
    }

    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) {
        cur.renFrom = line.slice('rename from '.length).split('\t')[0]!.trim();
      } else if (line.startsWith('rename to ')) {
        cur.renTo = line.slice('rename to '.length).split('\t')[0]!.trim();
      } else if (line.startsWith('new file mode')) {
        cur.isCreate = true;
      } else if (line.startsWith('deleted file mode')) {
        cur.isDelete = true;
      }
      // `index`, `old mode`, `new mode`, `similarity index`,
      // `dissimilarity index`, `Index:` and any other line are ignored.
    }
    // Outside bodies, lines that are not part of a section header are
    // ignored (prose, code fences).
    i += 1;
  }

  if (sections.length === 0) throw new ParseError(1);
  return sections.map((sec) => unifiedEdit(sec, strict));
}

/** Apply a section's hunks in order to a file, each to the result of the
 * ones before it. `d` is the sum over this section's hunks applied so far
 * of (N's length minus O's length). */
function applyHunks(file: FileState, hunks: Hunk[], strict: boolean, path: string): FileState {
  const lines = [...file.lines];
  let finalBreak = file.finalBreak;
  let d = 0;
  for (const h of hunks) {
    if (h.oldLines.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), lines.length);
      const atEnd = at === lines.length;
      lines.splice(at, 0, ...h.newLines.map((nl) => nl.text));
      if (atEnd) finalBreak = !h.noEol;
      d += h.newLines.length;
      continue;
    }
    const hit = firstTier(lines, h.oldLines, strict, 0);
    if (hit === null) throw new EditFail('no-match', path);
    const target = h.a - 1 + d;
    let pos = hit.occ[0]!;
    let best = Math.abs(pos - target);
    for (const o of hit.occ) {
      const dist = Math.abs(o - target);
      if (dist < best) {
        pos = o;
        best = dist;
      }
    }
    const rendered = renderNew(h.oldLines, h.newLines, lines, pos, hit.tier);
    const toEnd = pos + h.oldLines.length === lines.length;
    lines.splice(pos, h.oldLines.length, ...rendered);
    if (toEnd) finalBreak = !h.noEol;
    d += h.newLines.length - h.oldLines.length;
  }
  return { br: file.br, lines, finalBreak };
}

/** One unified section is one edit. */
function unifiedEdit(sec: UniSection, strict: boolean): Edit {
  const oldPath = sec.hdrOld ?? sec.renFrom ?? sec.dgOld;
  const newPath = sec.hdrNew ?? sec.renTo ?? sec.dgNew;
  const isCreate = oldPath === null || sec.isCreate;
  const isDelete = !isCreate && (newPath === null || sec.isDelete);
  const isMove = !isCreate && !isDelete && oldPath !== null && newPath !== null && oldPath !== newPath;

  if (isCreate) {
    const p = newPath ?? '';
    const plusLines: string[] = [];
    for (const h of sec.hunks) {
      for (const nl of h.newLines) if (!nl.ctx) plusLines.push(nl.text);
    }
    let createNoEol = false;
    for (let k = sec.hunks.length - 1; k >= 0; k -= 1) {
      if (sec.hunks[k]!.newLines.some((nl) => !nl.ctx)) {
        createNoEol = sec.hunks[k]!.plusNoEol;
        break;
      }
    }
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.set(p, plusLines.length === 0 ? '' : plusLines.join('\n') + (createNoEol ? '' : '\n'));
    };
  }

  if (isDelete) {
    const p = oldPath ?? '';
    return (tree) => {
      if (!isSafePath(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) === null) throw new EditFail('missing', p);
      tree.set(p, null);
    };
  }

  if (isMove) {
    const o = oldPath!;
    const nw = newPath!;
    return (tree, moves) => {
      if (!isSafePath(o)) throw new EditFail('unsafe', o);
      if (!isSafePath(nw)) throw new EditFail('unsafe', nw);
      const cur = tree.get(o);
      if (cur === null) throw new EditFail('missing', o);
      if (tree.get(nw) !== null) throw new EditFail('exists', nw);
      const out = applyHunks(parseFile(cur), sec.hunks, strict, o);
      tree.set(nw, renderFile(out));
      tree.set(o, null);
      moves.push([o, nw]);
    };
  }

  const p = oldPath ?? '';
  return (tree) => {
    if (!isSafePath(p)) throw new EditFail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new EditFail('missing', p);
    const out = applyHunks(parseFile(cur), sec.hunks, strict, p);
    tree.set(p, renderFile(out));
  };
}

// ---------------------------------------------------------------------------
// Section 7: SEARCH/REPLACE blocks.
// ---------------------------------------------------------------------------

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() === '<<<<<<< SEARCH') {
      const s = i;
      // The path is the nearest line before the SEARCH line, and after the
      // previous block's `>>>>>>> REPLACE` line (or the start of the patch),
      // that is not blank and, its surrounding whitespace removed, does not
      // start with three backticks.
      let path: string | null = null;
      for (let j = s - 1; j > prevEnd; j -= 1) {
        const l = lines[j]!;
        if (isBlank(l)) continue;
        const t = l.trim();
        if (t.startsWith('```')) continue;
        path = t;
        break;
      }
      if (path === null) {
        if (prevPath !== null) path = prevPath;
        else throw new ParseError(s + 1);
      }
      let eq = -1;
      for (let j = s + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
        if (lines[j]!.trimEnd() === '=======') {
          eq = j;
          break;
        }
      }
      if (eq < 0) throw new ParseError(s + 1);
      let rep = -1;
      for (let j = eq + 1; j < lines.length; j += 1) {
        if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
      if (rep < 0) throw new ParseError(s + 1);
      blocks.push({ path, oldLines: lines.slice(s + 1, eq), newLines: lines.slice(eq + 1, rep) });
      prevPath = path;
      prevEnd = rep;
      i = rep + 1;
      continue;
    }
    i += 1;
  }
  if (blocks.length === 0) throw new ParseError(1);
  return blocks.map((b) => srEdit(b, strict));
}

/** One SEARCH/REPLACE block is one edit, applied in order. */
function srEdit(b: SrBlock, strict: boolean): Edit {
  return (tree) => {
    if (!isSafePath(b.path)) throw new EditFail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new EditFail('exists', b.path);
      tree.set(b.path, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(b.path);
    if (cur === null) throw new EditFail('missing', b.path);
    const f = parseFile(cur);
    const hit = firstTier(f.lines, b.oldLines, strict, 0);
    if (hit === null) throw new EditFail('no-match', b.path);
    if (hit.occ.length !== 1) throw new EditFail('ambiguous', b.path);
    const pos = hit.occ[0]!;
    const rendered = renderNew(
      b.oldLines,
      b.newLines.map((t) => ({ text: t, ctx: false, oIdx: -1 })),
      f.lines,
      pos,
      hit.tier,
    );
    f.lines.splice(pos, b.oldLines.length, ...rendered);
    tree.set(b.path, renderFile(f));
  };
}

// ---------------------------------------------------------------------------
// Section 8: V4A patches.
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  oldLines: string[];
  newLines: NewLine[];
}

const isV4aSectionStart = (l: string): boolean =>
  l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseError(1);
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseError(first + 1);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k -= 1) {
    if (!isBlank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new ParseError(lines.length + 1);

  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) {
      i += 1;
      continue;
    }
    if (!isV4aSectionStart(line)) throw new ParseError(i + 1);
    const startLine = i + 1;
    i += 1;
    // The section's raw lines run to the next section start or End Patch.
    const raw: Array<{ text: string; no: number }> = [];
    while (i < last && !isV4aSectionStart(lines[i]!)) {
      raw.push({ text: lines[i]!, no: i + 1 });
      i += 1;
    }
    // Blank lines at the end of a section are not part of it.
    while (raw.length > 0 && isBlank(raw[raw.length - 1]!.text)) raw.pop();

    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      const fileLines: string[] = [];
      for (const r of raw) {
        if (r.text.startsWith('+')) fileLines.push(r.text.slice(1));
        else if (r.text === '') fileLines.push('');
        else throw new ParseError(r.no);
      }
      edits.push((tree) => {
        if (!isSafePath(path)) throw new EditFail('unsafe', path);
        if (tree.get(path) !== null) throw new EditFail('exists', path);
        tree.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
      });
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      for (const r of raw) throw new ParseError(r.no);
      edits.push((tree) => {
        if (!isSafePath(path)) throw new EditFail('unsafe', path);
        if (tree.get(path) === null) throw new EditFail('missing', path);
        tree.set(path, null);
      });
      continue;
    }

    // *** Update File: ***
    const path = line.slice('*** Update File: '.length).trim();
    let moveTo: string | null = null;
    let j = 0;
    if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
      moveTo = raw[0]!.text.slice('*** Move to: '.length).trim();
      j = 1;
    }
    const chunks: VChunk[] = [];
    let curBody: Array<{ text: string; no: number }> | null = null;
    let curAnchor: string | null = null;
    let afterEof = false;
    const flush = (eof: boolean): void => {
      if (curBody === null) return;
      const { oldLines, newLines } = splitBody(curBody.map((b) => b.text));
      chunks.push({ anchor: curAnchor, eof, oldLines, newLines });
      curBody = null;
      curAnchor = null;
    };
    for (; j < raw.length; j += 1) {
      const r = raw[j]!;
      if (r.text === '*** End of File') {
        if (curBody === null) throw new ParseError(r.no);
        flush(true);
        afterEof = true;
        continue;
      }
      if (r.text.startsWith('@@')) {
        flush(false);
        const anchor = r.text.slice(2).trim();
        curAnchor = anchor === '' ? null : anchor;
        curBody = [];
        afterEof = false;
        continue;
      }
      if (r.text.startsWith(' ') || r.text.startsWith('-') || r.text.startsWith('+') || r.text === '') {
        if (curBody === null) {
          if (afterEof) throw new ParseError(r.no);
          curAnchor = null;
          curBody = [];
        }
        curBody.push(r);
        continue;
      }
      throw new ParseError(r.no);
    }
    flush(false);
    if (chunks.length === 0 && moveTo === null) throw new ParseError(startLine);
    edits.push(v4aUpdateEdit(path, moveTo, chunks, strict));
  }

  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

/** One V4A Update File section is one edit: its chunks apply in order,
 * with a cursor that starts at line 0. */
function v4aUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[], strict: boolean): Edit {
  return (tree, moves) => {
    if (!isSafePath(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !isSafePath(moveTo)) throw new EditFail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new EditFail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    const f = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        // The first line at or after the cursor equal to the anchor at the
        // first tier where one is (both sides a single line).
        let found = -1;
        for (const t of strict ? [0] : [0, 1, 2]) {
          for (let k = cursor; k < f.lines.length; k += 1) {
            if (normLine(f.lines[k]!, t) === normLine(ch.anchor, t)) {
              found = k;
              break;
            }
          }
          if (found >= 0) break;
        }
        if (found < 0) throw new EditFail('no-match', path);
        cursor = found + 1;
      }
      if (ch.oldLines.length === 0) {
        const at = ch.eof ? f.lines.length : cursor;
        const ins = ch.newLines.map((nl) => nl.text);
        f.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const hit = firstTier(f.lines, ch.oldLines, strict, cursor);
      if (hit === null) throw new EditFail('no-match', path);
      let pos = -1;
      for (const o of hit.occ) {
        if (!ch.eof || o + ch.oldLines.length === f.lines.length) {
          pos = o;
          break;
        }
      }
      if (pos < 0) throw new EditFail('no-match', path);
      const rendered = renderNew(ch.oldLines, ch.newLines, f.lines, pos, hit.tier);
      f.lines.splice(pos, ch.oldLines.length, ...rendered);
      cursor = pos + rendered.length;
    }
    const out = renderFile(f);
    if (moveTo !== null) {
      tree.set(moveTo, out);
      tree.set(path, null);
      moves.push([path, moveTo]);
    } else {
      tree.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Section 2 and 10: running the edits, output, exit codes, atomicity.
// ---------------------------------------------------------------------------

interface Row {
  key: string;
  line: string;
}

const byteCompare = (a: string, b: string): number =>
  Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function runCli(args: string[]): { code: number; out: string[] } {
  const parsed = parseArgs(args);
  if (parsed === null) return { code: 2, out: ['error: usage'] };

  let text = '';
  try {
    text = readFileSync(parsed.patch ?? 0, 'utf8');
  } catch {
    if (parsed.patch !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = parsed.format === 'auto' ? detectFormat(lines) : parsed.format;
  if (kind === null) return { code: 2, out: ['error: format'] };

  let edits: Edit[];
  try {
    if (kind === 'json') edits = parseJson(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, parsed.strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, parsed.strict);
    else edits = parseV4a(lines, parsed.strict);
    if (edits.length === 0) throw new ParseError(1);
  } catch (e) {
    if (e instanceof ParseError) return { code: 2, out: [`error: parse ${e.line}`] };
    throw e;
  }

  const tree = new Tree();
  const moves: Array<[string, string]> = [];
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const snapNow = new Map(tree.now);
    const snapMoves = moves.length;
    try {
      edit(tree, moves);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of snapNow) tree.now.set(k, v);
      moves.length = snapMoves;
      fails.push(e);
    }
  }

  if (fails.length > 0) {
    return {
      code: 1,
      out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`],
    };
  }

  const rows: Row[] = [];
  const rowByPath = new Map<string, Row>();
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const row: Row = { key: p, line: was === null ? `A ${p}` : now === null ? `D ${p}` : `M ${p}` };
    rows.push(row);
    rowByPath.set(p, row);
  }
  // A move that succeeded prints one `R <old> -> <new>` line, when `<old>`
  // existed before the patch and does not after it, and `<new>` did not
  // exist before it and does after it. It replaces that pair's `D` and `A`
  // lines and sorts by `<new>`.
  for (const [oldP, newP] of moves) {
    const oldWas = tree.original(oldP);
    const oldNow = tree.get(oldP);
    const newWas = tree.original(newP);
    const newNow = tree.get(newP);
    if (oldWas !== null && oldNow === null && newWas === null && newNow !== null) {
      const dRow = rowByPath.get(oldP);
      if (dRow !== undefined) {
        rows.splice(rows.indexOf(dRow), 1);
        rowByPath.delete(oldP);
      }
      const aRow = rowByPath.get(newP);
      if (aRow !== undefined) {
        rows.splice(rows.indexOf(aRow), 1);
        rowByPath.delete(newP);
      }
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
    }
  }
  rows.sort((a, b) => byteCompare(a.key, b.key));
  const outLines = rows.map((r) => r.line);

  if (!parsed.check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }

  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = runCli(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
