/**
 * fix-note-offs.ts — For every segment in MIDI_SEGMENTS.db, move any
 * note-off events (trit = −1) found at step 0 to the final step of the
 * sequence and merge them tritwise into that last step.
 *
 * Run:  npm run fix-note-offs
 *
 * What it does
 * ────────────
 *   Some segments currently start with step-0 note-offs so they can safely
 *   loop. This script rewrites each sequence so those note-offs live at the
 *   end of the segment instead.
 *
 *   For every trit position P where step 0 contains −1:
 *     • step 0 at P is cleared
 *     • the final step is merged with −1 at P using single-trit semantics:
 *         0  + (−1) → −1
 *         1  + (−1) → 0
 *        −1  + (−1) → −1   (duplicate note-offs collapse)
 *
 *   Only the `sequence` column is modified; trit_lo / trit_hi / steps are
 *   unchanged because the rewrite only relocates existing step-level events.
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

/** Positions that carry note-offs at step 0 and should be relocated. */
function getLeadingNoteOffPositions(step0: string): number[] {
  const trits = toBalancedTernary(BigInt(step0));
  const positions: number[] = [];
  for (let i = 0; i < trits.length; i++) {
    if (trits[i] === -1) positions.push(i);
  }
  return positions;
}

/** Remove note-offs from step 0, leaving note-ons and other positions intact. */
function clearLeadingNoteOffs(step0: string, positions: number[]): string {
  if (positions.length === 0) return step0;
  const tritMap = parseTritMap(step0);
  let changed = false;
  for (const pos of positions) {
    if (tritMap.get(pos) !== -1) continue;
    tritMap.delete(pos);
    changed = true;
  }
  return changed ? encodeTrits(tritMap) : step0;
}

/**
 * Merge relocated note-offs into the final step using the only states the
 * one-trit-per-position encoding can represent.
 */
function mergeIntoLastStep(lastStep: string, noteOffPositions: number[]): string {
  if (noteOffPositions.length === 0) return lastStep;
  const tritMap = parseTritMap(lastStep);

  for (const pos of noteOffPositions) {
    const current = tritMap.get(pos) ?? 0;
    if (current === 1) {
      tritMap.delete(pos);
      continue;
    }
    tritMap.set(pos, -1);
  }

  return encodeTrits(tritMap);
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

    const leadingNoteOffs = getLeadingNoteOffPositions(sequence[0]);
    if (leadingNoteOffs.length === 0) continue;

    const newStep0 = clearLeadingNoteOffs(sequence[0], leadingNoteOffs);
    const lastIndex = sequence.length - 1;
    const newLastStep = mergeIntoLastStep(sequence[lastIndex], leadingNoteOffs);

    if (newStep0 === sequence[0] && newLastStep === sequence[lastIndex]) continue;

    sequence[0] = newStep0;
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
