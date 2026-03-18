/**
 * addMetrics.ts — backfill quality-metric columns on an existing MIDI_SEGMENTS.db.
 *
 * Run:  npm run add-metrics
 *
 * Safe to run multiple times; skips rows whose metrics are already populated.
 * The four columns are added to the table if they don't exist yet.
 *
 * Columns added / updated
 * ───────────────────────
 *   note_count     INTEGER  — total note-on events (trit = +1)
 *   note_density   REAL     — fraction of non-zero steps (0–1)
 *   unique_pitches INTEGER  — distinct trit positions that fired a note-on
 *   polyphony_avg  REAL     — mean simultaneously-sounding notes per step
 */

import Database   from 'better-sqlite3';
import path       from 'path';
import fs         from 'fs';
import { fileURLToPath } from 'url';
import { toBalancedTernary } from './utils.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, '..', 'MIDI_SEGMENTS.db');
const BATCH     = 2000;

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found: ${DB_PATH}`);
  console.error('Run  npm run build-dataset  first.');
  process.exit(1);
}

console.log(`Opening ${DB_PATH} …`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ── Ensure columns exist ──────────────────────────────────────────────────────

const existingCols = new Set(
  (db.pragma('table_info(segments)') as { name: string }[]).map(c => c.name),
);

const toAdd: [string, string][] = [
  ['note_count',     'INTEGER NOT NULL DEFAULT 0'],
  ['note_density',   'REAL    NOT NULL DEFAULT 0'],
  ['unique_pitches', 'INTEGER NOT NULL DEFAULT 0'],
  ['polyphony_avg',  'REAL    NOT NULL DEFAULT 0'],
];

for (const [col, def] of toAdd) {
  if (!existingCols.has(col)) {
    db.exec(`ALTER TABLE segments ADD COLUMN ${col} ${def}`);
    console.log(`  Added column: ${col}`);
  } else {
    console.log(`  Column already exists: ${col}`);
  }
}

// ── Ensure indexes ────────────────────────────────────────────────────────────

db.exec('CREATE INDEX IF NOT EXISTS idx_seg_note_count     ON segments (note_count)');
db.exec('CREATE INDEX IF NOT EXISTS idx_seg_note_density   ON segments (note_density)');
db.exec('CREATE INDEX IF NOT EXISTS idx_seg_unique_pitches ON segments (unique_pitches)');
db.exec('CREATE INDEX IF NOT EXISTS idx_seg_polyphony_avg  ON segments (polyphony_avg)');

// ── Metric computation ────────────────────────────────────────────────────────

function computeMetrics(seq: string[]): {
  noteCount:     number;
  noteDensity:   number;
  uniquePitches: number;
  polyphonyAvg:  number;
} {
  let noteCount    = 0;
  let nonZeroSteps = 0;
  const pitchSet   = new Set<number>();
  const sounding   = new Set<number>();
  let soundingSum  = 0;

  for (const raw of seq) {
    if (raw !== '0') {
      nonZeroSteps++;
      const trits = toBalancedTernary(BigInt(raw));
      for (let i = 0; i < trits.length; i++) {
        if (trits[i] === 1) {
          noteCount++;
          pitchSet.add(i);
          sounding.add(i);
        } else if (trits[i] === -1) {
          sounding.delete(i);
        }
      }
    }
    soundingSum += sounding.size;
  }

  return {
    noteCount,
    noteDensity:   seq.length ? nonZeroSteps / seq.length : 0,
    uniquePitches: pitchSet.size,
    polyphonyAvg:  seq.length ? soundingSum / seq.length : 0,
  };
}

// ── Main update loop ──────────────────────────────────────────────────────────

interface IdSeqRow { id: number; sequence: string }

// Rows that need populating: those where note_count is still 0 (default)
// but have a non-trivial sequence (avoids touching rows that genuinely have
// 0 note-ons, which shouldn't exist in a well-formed DB, but is harmless).
const total: number = (db.prepare(
  'SELECT COUNT(*) AS n FROM segments WHERE note_count = 0'
).get() as { n: number }).n;

if (total === 0) {
  console.log('\nAll rows already have metrics. Nothing to do.');
  db.close();
  process.exit(0);
}

console.log(`\nBackfilling metrics for ${total.toLocaleString()} rows …`);

const fetchBatch = db.prepare<{ limit: number; offset: number }, IdSeqRow>(
  'SELECT id, sequence FROM segments WHERE note_count = 0 LIMIT :limit OFFSET :offset',
);

const updateStmt = db.prepare(`
  UPDATE segments
  SET note_count     = @noteCount,
      note_density   = @noteDensity,
      unique_pitches = @uniquePitches,
      polyphony_avg  = @polyphonyAvg
  WHERE id = @id
`);

interface UpdateRow {
  id: number;
  noteCount:     number;
  noteDensity:   number;
  uniquePitches: number;
  polyphonyAvg:  number;
}

const flushBatch = db.transaction((rows: UpdateRow[]) => {
  for (const r of rows) updateStmt.run(r);
});

const startTime = Date.now();
let processed   = 0;
let offset      = 0;

while (processed < total) {
  const rows = fetchBatch.all({ limit: BATCH, offset: 0 }); // always offset 0: updated rows fall out of WHERE
  if (rows.length === 0) break;

  const updates: UpdateRow[] = rows.map(row => {
    const seq     = JSON.parse(row.sequence) as string[];
    const metrics = computeMetrics(seq);
    return { id: row.id, ...metrics };
  });

  flushBatch(updates);
  processed += rows.length;
  offset    += rows.length;

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  process.stdout.write(`\r  ${processed.toLocaleString()} / ${total.toLocaleString()} rows — ${elapsed}s`);
}

const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(`\n\nDone in ${elapsed}s. ${processed.toLocaleString()} rows updated.`);

db.close();
