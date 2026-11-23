// main.ts is mend, the CLI SPEC.md specifies (MIT). It implements all of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, matching lines at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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
  readonly moves = new Map<string, string>();
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

/** A file as lines, with its own line break and whether it ends with one (SPEC.md section 3). */
interface FileModel { lines: string[]; br: string; final: boolean; }

function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeFile(m: FileModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.final ? m.br : '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}

/** Matching lines (SPEC.md section 5). */
function normLine(s: string, tier: number): string {
  if (tier === 0) return s;
  if (tier === 1) return s.replace(/[ \t]+$/, '');
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

function occurrences(lines: string[], O: string[], tier: number, from: number): number[] {
  const pos: number[] = [];
  if (O.length === 0) return pos;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(lines[i + j]!, tier) !== nO[j]) { ok = false; break; }
    }
    if (ok) pos.push(i);
  }
  return pos;
}

function findTier(lines: string[], O: string[], strict: boolean, from = 0): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(lines, O, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: its text, and the index in O when it is a context line (else null). */
interface NLine { text: string; ctx: number | null; }

/** O and N from hunk/chunk body lines: context lines go in both, `-` in O only, `+` in N only. */
function bodyON(body: string[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const l of body) {
    if (l.startsWith('\\')) continue;
    if (l === '' || l.startsWith(' ')) {
      const content = l === '' ? '' : l.slice(1);
      O.push(content);
      N.push({ text: content, ctx: O.length - 1 });
    } else if (l.startsWith('-')) {
      O.push(l.slice(1));
    } else if (l.startsWith('+')) {
      N.push({ text: l.slice(1), ctx: null });
    }
  }
  return { O, N };
}

/** Whether a `\` line follows the last body line `isTarget` is true of. */
function noNLAfter(body: string[], isTarget: (l: string) => boolean): boolean {
  for (let i = body.length - 1; i >= 0; i--) {
    if (isTarget(body[i]!)) {
      const next = body[i + 1];
      return next !== undefined && next.startsWith('\\');
    }
  }
  return false;
}

/** Replace O at `pos` by N: context lines as the file's own matched lines, tier-2 re-indentation. */
function replaceAt(m: FileModel, O: string[], N: NLine[], pos: number, tier: number, final: boolean): FileModel {
  let seg: string[];
  if (tier === 2 && O.length > 0) {
    const F = leadingWS(m.lines[pos] ?? '');
    const P = leadingWS(O[0]!);
    seg = N.map((n) => {
      if (n.ctx !== null) return m.lines[pos + n.ctx]!;
      if (n.text !== '' && n.text.trim() !== '' && n.text.startsWith(P)) return F + n.text.slice(P.length);
      return n.text;
    });
  } else {
    seg = N.map((n) => (n.ctx !== null ? m.lines[pos + n.ctx]! : n.text));
  }
  return { lines: [...m.lines.slice(0, pos), ...seg, ...m.lines.slice(pos + O.length)], br: m.br, final };
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

/** Unified diffs (SPEC.md section 6). */
interface Hunk { A: number; body: string[]; }
interface Section {
  diffX?: string; diffY?: string;
  oldPath?: string | null; newPath?: string | null;
  renameFrom?: string; renameTo?: string;
  newFile: boolean; deletedFile: boolean;
  hunks: Hunk[];
  inHeader: boolean; hasPair: boolean;
}

function stripAB(p: string): string {
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2);
  return p;
}

function headerPath(line: string): string {
  const raw = line.slice(4);
  const tab = raw.indexOf('\t');
  return (tab >= 0 ? raw.slice(0, tab) : raw).trim();
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { diffX: m[1], diffY: m[2], newFile: false, deletedFile: false, hunks: [], inHeader: true, hasPair: false };
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || !cur.inHeader || cur.hasPair) {
        cur = { newFile: false, deletedFile: false, hunks: [], inHeader: true, hasPair: false };
        sections.push(cur);
      }
      cur.hasPair = true;
      const op = headerPath(line);
      const np = headerPath(lines[i + 1]!);
      cur.oldPath = op === '/dev/null' ? null : stripAB(op);
      cur.newPath = np === '/dev/null' ? null : stripAB(np);
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && cur.inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      cur.inHeader = false;
      const A = parseInt(m[1]!, 10);
      const body: string[] = [];
      i++;
      while (i < lines.length) {
        const b = lines[i]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      cur.hunks.push({ A, body });
      continue;
    }
    if (cur !== null && cur.inHeader) {
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => unifiedSectionEdit(s, strict));
}

function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  let m = parseFile(text);
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    const noNL = noNLAfter(h.body, (l) => l === '' || l.startsWith(' ') || l.startsWith('+'));
    if (O.length > 0) {
      const found = findTier(m.lines, O, strict);
      if (!found) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = found.pos[0]!;
      for (const p of found.pos) {
        if (Math.abs(p - target) < Math.abs(best - target)) best = p;
      }
      const touchesEnd = best + O.length === m.lines.length;
      m = replaceAt(m, O, N, best, found.tier, touchesEnd ? !noNL : m.final);
    } else {
      const at = Math.max(0, Math.min(h.A + d, m.lines.length));
      const touchesEnd = at === m.lines.length;
      const seg = N.map((n) => n.text);
      m = { lines: [...m.lines.slice(0, at), ...seg, ...m.lines.slice(at)], br: m.br, final: touchesEnd ? !noNL : m.final };
    }
    d += N.length - O.length;
  }
  return writeFile(m);
}

function unifiedSectionEdit(s: Section, strict: boolean): Edit {
  let oldP: string | null | undefined;
  let newP: string | null | undefined;
  if (s.hasPair) {
    oldP = s.oldPath;
    newP = s.newPath;
  } else if (s.renameFrom !== undefined || s.renameTo !== undefined) {
    oldP = s.renameFrom !== undefined ? s.renameFrom : s.diffX;
    newP = s.renameTo !== undefined ? s.renameTo : s.diffY;
  } else {
    oldP = s.diffX;
    newP = s.diffY;
  }
  const op = oldP === null || oldP === undefined ? null : oldP;
  const np = newP === null || newP === undefined ? null : newP;
  if (op === null || s.newFile) {
    const p = np ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noNL = false;
      for (const h of s.hunks) {
        if (h.body.some((l) => l.startsWith('+'))) noNL = noNLAfter(h.body, (l) => l.startsWith('+'));
        for (const l of h.body) {
          if (l.startsWith('+')) plus.push(l.slice(1));
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noNL ? '' : '\n'));
    };
  }
  if (np === null || s.deletedFile) {
    const p = op;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (op !== np) {
    const o = op;
    const n = np;
    return (tree) => {
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const before = tree.get(o);
      if (before === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const out = applyHunks(before, s.hunks, strict, o);
      tree.now.set(n, out);
      tree.now.set(o, null);
      tree.moves.set(o, n);
    };
  }
  const p = op;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(before, s.hunks, strict, p));
  };
}

/** SEARCH/REPLACE blocks (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let si = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') { si = j; break; }
    }
    if (si < 0) break;
    let path: string | null = null;
    for (let j = si - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${si + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = si + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${si + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
    }
    if (rep < 0) throw new Exit2(`error: parse ${si + 1}`);
    const oldLines = lines.slice(si + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevReplaceEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const m = parseFile(before);
    const found = findTier(m.lines, oldLines, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const N = newLines.map((t) => ({ text: t, ctx: null }));
    const nm = replaceAt(m, oldLines, N, found.pos[0]!, found.tier, m.final);
    tree.now.set(path, writeFile(nm));
  };
}

/** V4A patches (SPEC.md section 8). */
interface V4AChunk { anchor: string | null; eof: boolean; body: { idx: number; text: string }[]; }
interface V4ASection { kind: 'add' | 'delete' | 'update'; path: string; idx: number; body: { idx: number; text: string }[]; }

function v4aSectionKind(line: string): 'add' | 'delete' | 'update' | null {
  if (line.startsWith('*** Add File:')) return 'add';
  if (line.startsWith('*** Delete File:')) return 'delete';
  if (line.startsWith('*** Update File:')) return 'update';
  return null;
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: V4ASection[] = [];
  let cur: V4ASection | null = null;
  for (let i = first + 1; i < last; i++) {
    const line = lines[i]!;
    const kind = v4aSectionKind(line);
    if (kind !== null) {
      if (cur !== null) sections.push(cur);
      const prefix = kind === 'add' ? '*** Add File:' : kind === 'delete' ? '*** Delete File:' : '*** Update File:';
      cur = { kind, path: line.slice(prefix.length).trim(), idx: i, body: [] };
      continue;
    }
    if (cur === null) {
      if (blank(line)) continue;
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.body.push({ idx: i, text: line });
  }
  if (cur !== null) sections.push(cur);
  for (const s of sections) {
    while (s.body.length > 0 && blank(s.body[s.body.length - 1]!.text)) s.body.pop();
  }
  return sections.map((s) => v4aSectionEdit(s, strict));
}

function findChunkOccurrence(lines: string[], O: string[], strict: boolean, from: number, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    let occ = occurrences(lines, O, t, from);
    if (eof) occ = occ.filter((p) => p + O.length === lines.length);
    if (occ.length > 0) return { tier: t, pos: occ[0]! };
  }
  return null;
}

function v4aSectionEdit(s: V4ASection, strict: boolean): Edit {
  if (s.kind === 'add') {
    const fileLines: string[] = [];
    for (const b of s.body) {
      if (b.text.startsWith('+')) fileLines.push(b.text.slice(1));
      else if (b.text === '') fileLines.push('');
      else throw new Exit2(`error: parse ${b.idx + 1}`);
    }
    const p = s.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    for (const b of s.body) {
      if (!blank(b.text)) throw new Exit2(`error: parse ${b.idx + 1}`);
    }
    const p = s.path;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
    };
  }
  let moveTo: string | null = null;
  let bi = 0;
  if (s.body.length > 0 && s.body[0]!.text.startsWith('*** Move to:')) {
    moveTo = s.body[0]!.text.slice('*** Move to:'.length).trim();
    bi = 1;
  }
  const chunks: V4AChunk[] = [];
  let curChunk: V4AChunk | null = null;
  for (; bi < s.body.length; bi++) {
    const b = s.body[bi]!;
    if (b.text.startsWith('@@')) {
      const anchor = b.text.slice(2).trim();
      curChunk = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
      chunks.push(curChunk);
    } else if (b.text === '*** End of File') {
      if (curChunk === null) throw new Exit2(`error: parse ${b.idx + 1}`);
      curChunk.eof = true;
      curChunk = null;
    } else if (b.text === '' || b.text.startsWith(' ') || b.text.startsWith('-') || b.text.startsWith('+')) {
      if (curChunk === null) {
        if (chunks.length === 0) {
          curChunk = { anchor: null, eof: false, body: [] };
          chunks.push(curChunk);
        } else {
          throw new Exit2(`error: parse ${b.idx + 1}`);
        }
      }
      curChunk.body.push(b);
    } else {
      throw new Exit2(`error: parse ${b.idx + 1}`);
    }
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.idx + 1}`);
  const p = s.path;
  const mt = moveTo;
  return (tree) => {
    if (!safe(p)) throw new Fail('unsafe', p);
    if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    if (mt !== null && tree.get(mt) !== null) throw new Fail('exists', mt);
    let m = parseFile(before);
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null) {
        const found = findTier(m.lines, [chunk.anchor], strict, cursor);
        if (!found) throw new Fail('no-match', p);
        cursor = found.pos[0]! + 1;
      }
      const { O, N } = bodyON(chunk.body.map((b) => b.text));
      if (O.length > 0) {
        const found = findChunkOccurrence(m.lines, O, strict, cursor, chunk.eof);
        if (!found) throw new Fail('no-match', p);
        const pos = found.pos;
        m = replaceAt(m, O, N, pos, found.tier, m.final);
        cursor = pos + N.length;
      } else {
        const at = chunk.eof ? m.lines.length : cursor;
        const seg = N.map((n) => n.text);
        m = { lines: [...m.lines.slice(0, at), ...seg, ...m.lines.slice(at)], br: m.br, final: m.final };
        cursor = at + N.length;
      }
    }
    const out = writeFile(m);
    if (mt !== null) {
      tree.now.set(mt, out);
      tree.now.set(p, null);
      tree.moves.set(p, mt);
    } else {
      tree.now.set(p, out);
    }
  };
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
    edits = kind === 'json' ? jsonEdits(text, lines)
      : kind === 'unified' ? unifiedEdits(lines, strict)
      : kind === 'search-replace' ? searchReplaceEdits(lines, strict)
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
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: { key: string; line: string }[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.get(oldP);
    const wasNew = tree.original(newP);
    const nowNew = tree.get(newP);
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
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
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
