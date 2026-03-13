/**
 * fix-note-offs.ts — For every segment in MIDI_SEGMENTS.db, simulate
 * playback to find notes that are still sounding at the end of the sequence,
 * then append note-off events for those notes into the final step.
 *
 * Run:  npm run fix-note-offs
 *
 * What it does
 * ────────────
 *   Iterates every trit in every step of the sequence:
 *     trit +1 at position P  →  note at P starts sounding
 *     trit −1 at position P  →  note at P stops sounding
 *
 *   After all steps have been processed, any position still sounding needs a
 *   note-off merged into the final step:
 *     current trit at P = 0   →  set to −1
 *     current trit at P = +1  →  clear to 0  (note-on and note-off coalesce)
 *     current trit at P = −1  →  already off, leave unchanged
 *
 *   Only the `sequence` column is modified.
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { toBalancedTernary } from './utils.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT      = path.resolve(__dirname, '..');
const SEGS_DB   = path.join(ROOT, 'MIDI_SEGMENTS.db');
const BATCH_SIZE = 500;

// ── Open database ─────────────────────────────────────────────────────────────

if (!fs.existsSync(SEGS_DB)) {
  console.error(`Database not found: ${SEGS_DB}\nRun  npm run segs-to-sqlite  first.`);
  process.exit(1);
}

console.log(`Opening ${SEGS_DB} …`);
const db = new Database(SEGS_DB);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Parse a balanced-ternary integer string into a Map<position, trit (±1)>. */
function parseTritMap(stepStr: string): Map<number, number> {
  const trits = toBalancedTernary(BigInt(stepStr));
  const map = new Map<number, number>();
  for (let i = 0; i < trits.length; i++) {
    if (trits[i] !== 0) map.set(i, trits[i]);
  }
  return map;
}

/** Encode a sparse trit map {position → ±1} back to a decimal BigInt string. */
function encodeTrits(trits: Map<number, number>): string {
  if (trits.size === 0) return '0';
  let val = 0n;
  for (const [pos, trit] of trits) {
    if (trit === 0) continue;
    val += BigInt(trit) * (3n ** BigInt(pos));
  }
  return val.toString();
}

/**
 * Simulate playback through the full sequence.
 * Returns the set of trit positions that are still sounding (note-on without
 * a matching note-off) after the last step.
 */
function getSoundingAtEnd(sequence: string[]): Set<number> {
  const sounding = new Set<number>();
  for (const stepStr of sequence) {
    if (stepStr === '0') continue;
    const trits = toBalancedTernary(BigInt(stepStr));
    for (let pos = 0; pos < trits.length; pos++) {
      if      (trits[pos] ===  1) sounding.add(pos);
      else if (trits[pos] === -1) sounding.delete(pos);
    }
  }
  return sounding;
}

/**
 * Merge note-offs for every position in `sounding` into the last step string.
 * Returns the (possibly unchanged) last step string.
 */
function addNoteOffs(lastStep: string, sounding: Set<number>): string {
  if (sounding.size === 0) return lastStep;
  const tritMap = parseTritMap(lastStep);
  let changed = false;
  for (const pos of sounding) {
    const current = tritMap.get(pos) ?? 0;
    if (current === -1) continue;          // already has note-off
    if (current === 1) {
      tritMap.delete(pos);                 // note-on + note-off → coalesce to 0
    } else {
      tritMap.set(pos, -1);               // 0 → note-off
    }
    changed = true;
  }
  return changed ? encodeTrits(tritMap) : lastStep;
}

// ── Prepared statements ───────────────────────────────────────────────────────

interface SegRow {
  id:       number;
  sequence: string;
}

const stmtTotal = db.prepare<[], { total: number }>(
  'SELECT COUNT(*) AS total FROM segments'
);

const stmtPage = db.prepare<{ limit: number; offset: number }, SegRow>(
  'SELECT id, sequence FROM segments ORDER BY id LIMIT @limit OFFSET @offset'
);

const stmtUpdate = db.prepare<{ id: number; sequence: string }>(
  'UPDATE segments SET sequence = @sequence WHERE id = @id'
);

const flushBatch = db.transaction((rows: Array<{ id: number; sequence: string }>) => {
  for (const row of rows) stmtUpdate.run(row);
});

// ── Main loop ─────────────────────────────────────────────────────────────────

const totalRows = stmtTotal.get()!.total;
console.log(`Processing ${totalRows} segments …`);

const start    = Date.now();
let inspected  = 0;
let modified   = 0;
let offset     = 0;

while (offset < totalRows) {
  const page = stmtPage.all({ limit: BATCH_SIZE, offset });
  if (page.length === 0) break;
  offset += page.length;

  const updates: Array<{ id: number; sequence: string }> = [];

  for (const row of page) {
    inspected++;
    const sequence: string[] = JSON.parse(row.sequence);
    if (sequence.length === 0) continue;

    const sounding = getSoundingAtEnd(sequence);
    if (sounding.size === 0) continue;

    const lastIndex = sequence.length - 1;
    const newLastStep = addNoteOffs(sequence[lastIndex], sounding);

    if (newLastStep === sequence[lastIndex]) continue;

    sequence[lastIndex] = newLastStep;
    updates.push({ id: row.id, sequence: JSON.stringify(sequence) });
    modified++;
  }

  if (updates.length > 0) flushBatch(updates);

  const pct = Math.round((offset / totalRows) * 100);
  process.stdout.write(`\r  ${pct}%  inspected ${inspected}, modified ${modified} …`);
}

const elapsed = ((Date.now() - start) / 1000).toFixed(1);
console.log(`\nDone in ${elapsed}s.  Rows inspected: ${inspected}  |  Rows updated: ${modified}`);
db.close();
