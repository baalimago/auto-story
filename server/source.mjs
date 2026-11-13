// Splits a document into numbered parts small enough for one read call each,
// so the analyst can be made to read (and prove it read) every part.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PART_CHARS = 24000;
const PART_LINES = 1500;

export function splitParts(text, maxChars = PART_CHARS) {
  const parts = [];
  let rest = String(text).replace(/\r\n?/g, '\n');
  while (rest.length) {
    let cut = Math.min(rest.length, maxChars);
    // Stay under the read tool's line limit too.
    let lines = 0;
    for (let i = 0; i < cut; i++) if (rest[i] === '\n' && ++lines >= PART_LINES) { cut = i + 1; break; }
    if (cut < rest.length) {
      // Prefer a paragraph break, then a line break, then a sentence end in the last quarter.
      const floor = Math.floor(cut * 0.75);
      const window = rest.slice(floor, cut);
      const at = [window.lastIndexOf('\n\n'), window.lastIndexOf('\n'), window.lastIndexOf('. ')].find(i => i > 0);
      if (at !== undefined) cut = floor + at + 1;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  const width = String(parts.length).length < 2 ? 2 : String(parts.length).length;
  return parts.map((body, i) => ({ id: `part-${String(i + 1).padStart(width, '0')}`, text: body }));
}

export function writeParts(dir, parts) {
  mkdirSync(dir, { recursive: true });
  for (const part of parts) writeFileSync(join(dir, `${part.id}.txt`), part.text);
  return parts.map(p => ({ id: p.id, file: join(dir, `${p.id}.txt`), chars: p.text.length }));
}

// Groups parts for digest sessions when the whole document will not fit one agent's context.
export function groupParts(parts, maxChars) {
  const groups = [];
  let current = [], size = 0;
  for (const part of parts) {
    if (current.length && size + part.chars > maxChars) { groups.push(current); current = []; size = 0; }
    current.push(part);
    size += part.chars;
  }
  if (current.length) groups.push(current);
  return groups;
}
