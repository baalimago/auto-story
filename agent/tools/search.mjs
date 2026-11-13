// A small grep / rg stand-in for the agent sandbox, which has no grep. shell.sh maps both names here.
// Usage: node search.mjs grep|rg [flags] PATTERN [PATH...]
// Supports the flags agents use: -n -i -r -R -l -L -c -v -E -F -w -x -o -h -H -q -s -m N -A N -B N -C N -e PAT,
// --include/--exclude/--exclude-dir GLOB, rg's -g/--glob, -N, -S, --hidden. Exit 0 on a match, 1 on none, 2 on error.
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync, statSync } from 'node:fs';
import { join, basename, relative } from 'node:path';

const [mode = 'grep', ...argv] = process.argv.slice(2);
const rg = mode === 'rg';
const o = { n: rg, i: false, r: rg, l: false, L: false, c: false, v: false, E: rg, F: false, w: false, x: false, oo: false,
  h: null, q: false, s: false, m: Infinity, A: 0, B: 0, smart: false, hidden: false, include: [], exclude: [], excludeDir: [], globs: [] };
const patterns = [];
const paths = [];
let errors = 0;

const needsValue = new Set(['A', 'B', 'C', 'm', 'e', 'g', 't', 'T', 'f', 'M', 'j']);
function setShort(flag, value) {
  switch (flag) {
    case 'n': o.n = true; break;
    case 'N': o.n = false; break;
    case 'i': o.i = true; break;
    case 'S': o.smart = true; break;
    case 'r': case 'R': o.r = true; break;
    case 'l': o.l = true; break;
    case 'L': o.L = true; break;
    case 'c': o.c = true; break;
    case 'v': o.v = true; break;
    case 'E': o.E = true; break;
    case 'G': o.E = rg; break;
    case 'P': o.E = true; break;
    case 'F': o.F = true; break;
    case 'w': o.w = true; break;
    case 'x': o.x = true; break;
    case 'o': o.oo = true; break;
    case 'h': o.h = false; break;
    case 'H': o.h = true; break;
    case 'q': o.q = true; break;
    case 's': o.s = true; break;
    case 'I': case 'a': case 'U': case 'u': case 'z': break;
    case 'm': o.m = Number(value); break;
    case 'A': o.A = Number(value); break;
    case 'B': o.B = Number(value); break;
    case 'C': o.A = o.B = Number(value); break;
    case 'e': patterns.push(value); break;
    case 'f': patterns.push(...readFileSync(value, 'utf8').split('\n').filter(Boolean)); break;
    case 'g': o.globs.push(value); break;
    case 't': case 'T': case 'M': case 'j': break;
    default: console.error(`${mode}: unsupported flag -${flag} (this is a small Node stand-in; use node for anything fancier)`); process.exit(2);
  }
}

const LONG = {
  'line-number': () => { o.n = true; }, 'no-line-number': () => { o.n = false; }, 'ignore-case': () => { o.i = true; },
  'smart-case': () => { o.smart = true; }, recursive: () => { o.r = true; }, 'dereference-recursive': () => { o.r = true; },
  'files-with-matches': () => { o.l = true; }, 'files-without-match': () => { o.L = true; }, count: () => { o.c = true; },
  'invert-match': () => { o.v = true; }, 'extended-regexp': () => { o.E = true; }, 'perl-regexp': () => { o.E = true; },
  'fixed-strings': () => { o.F = true; }, 'word-regexp': () => { o.w = true; }, 'line-regexp': () => { o.x = true; },
  'only-matching': () => { o.oo = true; }, 'no-filename': () => { o.h = false; }, 'with-filename': () => { o.h = true; },
  quiet: () => { o.q = true; }, silent: () => { o.q = true; }, 'no-messages': () => { o.s = true; }, hidden: () => { o.hidden = true; },
  'max-count': v => { o.m = Number(v); }, 'after-context': v => { o.A = Number(v); }, 'before-context': v => { o.B = Number(v); },
  context: v => { o.A = o.B = Number(v); }, regexp: v => patterns.push(v), include: v => o.include.push(v),
  exclude: v => o.exclude.push(v), 'exclude-dir': v => o.excludeDir.push(v), glob: v => o.globs.push(v), iglob: v => o.globs.push(v),
};
const LONG_WITH_VALUE = new Set(['max-count', 'after-context', 'before-context', 'context', 'regexp', 'include', 'exclude', 'exclude-dir', 'glob', 'iglob', 'type', 'type-not', 'max-columns', 'threads', 'sort']);
const LONG_IGNORED = new Set(['color', 'colour', 'heading', 'no-heading', 'binary-text', 'text', 'no-ignore', 'null', 'no-config', 'pretty', 'type', 'type-not', 'max-columns', 'threads', 'sort', 'trim', 'vimgrep', 'column']);

let positional = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
  if (a.startsWith('--')) {
    const [name, inline] = a.slice(2).split(/=(.*)/s);
    const value = inline ?? (LONG_WITH_VALUE.has(name) ? argv[++i] : undefined);
    if (LONG[name]) LONG[name](value);
    else if (!LONG_IGNORED.has(name)) { console.error(`${mode}: unsupported option --${name}`); process.exit(2); }
    continue;
  }
  if (a.startsWith('-') && a.length > 1 && !/^-\d+$/.test(a)) {
    for (let k = 1; k < a.length; k++) {
      const flag = a[k];
      if (needsValue.has(flag)) {
        const rest = a.slice(k + 1);
        setShort(flag, rest || argv[++i]);
        break;
      }
      setShort(flag);
    }
    continue;
  }
  if (/^-\d+$/.test(a)) { o.A = o.B = Number(a.slice(1)); continue; }
  positional.push(a);
}
if (!patterns.length) {
  if (!positional.length) { console.error(`usage: ${mode} [flags] PATTERN [PATH...]`); process.exit(2); }
  patterns.push(positional.shift());
}
paths.push(...positional);

// grep's basic regular expressions: \| \( \) \{ \} \+ \? are the operators and the bare characters are literal.
function fromBasic(p) {
  let out = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '\\' && i + 1 < p.length) {
      const n = p[++i];
      out += '|(){}+?'.includes(n) ? n : `\\${n}`;
    } else out += '|(){}+?'.includes(c) ? `\\${c}` : c;
  }
  return out;
}
const POSIX = { alpha: 'a-zA-Z', digit: '0-9', alnum: 'a-zA-Z0-9', upper: 'A-Z', lower: 'a-z', space: '\\s', blank: ' \\t', punct: '!-\\/:-@\\[-`{-~', xdigit: '0-9A-Fa-f', word: '\\w' };
function toSource(p) {
  if (o.F) return p.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  let s = o.E ? p : fromBasic(p);
  s = s.replace(/\[:(\w+):\]/g, (m, name) => POSIX[name] ?? m);
  return s;
}
let ignoreCase = o.i || (o.smart && !patterns.some(p => /[A-Z]/.test(p)));
const sources = patterns.map(p => {
  if (/^\(\?i\)/.test(p)) { ignoreCase = true; p = p.slice(4); }
  let s = toSource(p);
  if (o.w) s = `(?<![\\w])(?:${s})(?![\\w])`;
  if (o.x) s = `^(?:${s})$`;
  return s;
});
let regex;
try { regex = new RegExp(sources.map(s => `(?:${s})`).join('|'), ignoreCase ? 'gi' : 'g'); }
catch (error) { console.error(`${mode}: bad pattern: ${error.message}`); process.exit(2); }

const globRe = glob => new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\/?/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]').replace(/\u0000/g, '.*')}$`);
const includes = o.include.map(globRe);
const excludes = o.exclude.map(globRe);
const excludeDirs = o.excludeDir.map(globRe);
const globs = o.globs.map(g => ({ neg: g.startsWith('!'), re: globRe(g.replace(/^!/, '')), hasSlash: g.includes('/') }));
function wanted(file, rel) {
  const name = basename(file);
  if (includes.length && !includes.some(re => re.test(name))) return false;
  if (excludes.some(re => re.test(name))) return false;
  if (globs.length) {
    const positive = globs.filter(g => !g.neg);
    const test = g => g.re.test(g.hasSlash ? rel : name) || g.re.test(rel);
    if (positive.length && !positive.some(test)) return false;
    if (globs.filter(g => g.neg).some(test)) return false;
  }
  return true;
}

const SKIP_DIRS = new Set(['.git', 'node_modules']);
function* walk(dir, root) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch (error) { if (!o.s) console.error(`${mode}: ${dir}: ${error.code || error.message}`); errors++; return; }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = dir === '.' ? e.name : join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || (rg && !o.hidden && e.name.startsWith('.')) || excludeDirs.some(re => re.test(e.name))) continue;
      yield* walk(path, root);
    } else if (e.isFile()) {
      if (rg && !o.hidden && e.name.startsWith('.')) continue;
      if (wanted(path, relative(root, path))) yield path;
    }
  }
}

function stdinIsData() {
  try { const st = fstatSync(0); return st.isFIFO() || st.isFile(); } catch { return false; }
}
function readStdin() {
  const chunks = [];
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n;
    try { n = readSync(0, buf, 0, buf.length, null); } catch (error) { if (error.code === 'EAGAIN') continue; if (error.code === 'EOF') break; throw error; }
    if (!n) break;
    chunks.push(Buffer.from(buf.subarray(0, n)));
  }
  return Buffer.concat(chunks);
}

const targets = [];
if (!paths.length) {
  if (o.r && !(rg && stdinIsData())) targets.push(...walk('.', '.'));
  else targets.push('-');
} else {
  for (const p of paths) {
    if (p === '-') { targets.push('-'); continue; }
    let st;
    try { st = statSync(p); } catch { if (!o.s) console.error(`${mode}: ${p}: No such file or directory`); errors++; continue; }
    if (st.isDirectory()) {
      if (!o.r) { if (!o.s) console.error(`${mode}: ${p}: Is a directory`); continue; }
      targets.push(...walk(p, p));
    } else targets.push(p);
  }
}
const showName = o.h ?? (o.r || targets.length > 1);
const out = [];
const write = line => { out.push(line); if (out.length >= 512) flush(); };
function flush() { if (out.length) { process.stdout.write(out.join('\n') + '\n'); out.length = 0; } }

let anyMatch = false;
let printedGroup = false;
for (const target of targets) {
  let data;
  try { data = target === '-' ? readStdin() : readFileSync(target); }
  catch (error) { if (!o.s) console.error(`${mode}: ${target}: ${error.code || error.message}`); errors++; continue; }
  if (target !== '-' && data.subarray(0, 8192).includes(0)) continue; // binary
  const name = target === '-' ? '(standard input)' : target;
  const lines = data.toString('utf8').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let count = 0;
  let lastPrinted = -1;
  let afterLeft = 0;
  const prefix = (n, sep) => `${showName ? `${name}${sep}` : ''}${o.n ? `${n + 1}${sep}` : ''}`;
  for (let n = 0; n < lines.length; n++) {
    if (count >= o.m) break;
    const line = lines[n];
    regex.lastIndex = 0;
    const hit = regex.test(line) !== o.v;
    if (!hit) {
      if (afterLeft > 0 && !(o.l || o.L || o.c || o.q)) { write(prefix(n, '-') + line); lastPrinted = n; afterLeft--; }
      continue;
    }
    count++;
    anyMatch = true;
    if (o.q) break;
    if (o.l || o.L || o.c) continue;
    if (o.A || o.B) {
      const from = Math.max(n - o.B, lastPrinted + 1);
      if (printedGroup && lastPrinted >= 0 && from > lastPrinted + 1) write('--');
      else if (printedGroup && lastPrinted < 0) write('--');
      for (let b = from; b < n; b++) write(prefix(b, '-') + lines[b]);
      printedGroup = true;
    }
    if (o.oo && !o.v) {
      regex.lastIndex = 0;
      for (const m of line.matchAll(regex)) if (m[0]) write(prefix(n, ':') + m[0]);
    } else write(prefix(n, ':') + line);
    lastPrinted = n;
    afterLeft = o.A;
  }
  if (o.q && anyMatch) break;
  if (o.c) write(`${showName ? `${name}:` : ''}${count}`);
  if (o.l && count) write(name);
  if (o.L && !count) write(name);
}
flush();
process.exitCode = o.L ? (targets.length ? 0 : 1) : anyMatch ? 0 : errors ? 2 : 1;
