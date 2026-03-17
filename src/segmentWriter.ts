/**
 * segmentWriter.ts — open MIDI_SEGMENTS.db and write SegmentRecord rows in
 * batched transactions.
 *
 * Schema matches segments-to-sqlite.ts so fix-note-offs.ts and generate.ts
 * work unchanged against the new database.
 */

import Database from 'better-sqlite3';
import type { SegmentRecord } from './types.ts';

const BATCH_SIZE = 1000;

export interface SegmentWriter {
  readonly count: number;
  add(seg: SegmentRecord): void;
  flush(): void;
  close(): void;
}

export function createWriter(dbPath: string): SegmentWriter {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS segments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      source      TEXT    NOT NULL,
      start_step  INTEGER NOT NULL,
      end_step    INTEGER NOT NULL,
      trit_lo     INTEGER NOT NULL,
      trit_hi     INTEGER NOT NULL,
      forte       TEXT    NOT NULL,
      octave      INTEGER NOT NULL DEFAULT 0,
      bpm         REAL    NOT NULL,
      numerator   INTEGER NOT NULL,
      denominator INTEGER NOT NULL,
      steps       INTEGER NOT NULL,
      sequence    TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_seg_source ON segments (source);
    CREATE INDEX IF NOT EXISTS idx_seg_forte  ON segments (forte);
    CREATE INDEX IF NOT EXISTS idx_seg_steps  ON segments (steps);
    CREATE INDEX IF NOT EXISTS idx_seg_bpm    ON segments (bpm);
    CREATE INDEX IF NOT EXISTS idx_seg_lower_source ON segments (LOWER(source));
    CREATE INDEX IF NOT EXISTS idx_seg_forte_steps  ON segments (forte, steps);
    CREATE INDEX IF NOT EXISTS idx_seg_forte_bpm    ON segments (forte, bpm);
    CREATE INDEX IF NOT EXISTS idx_seg_source_steps ON segments (source, steps);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO segments
      (source, start_step, end_step, trit_lo, trit_hi,
       forte, octave, bpm, numerator, denominator, steps, sequence)
    VALUES
      (@source, @startStep, @endStep, @tritLo, @tritHi,
       @forte, @octave, @bpm, @numerator, @denominator, @steps, @sequence)
  `);

  interface BatchRow extends SegmentRecord { sequence_str: string }

  const flushTx = db.transaction((rows: BatchRow[]) => {
    for (const row of rows) {
      insertStmt.run({
        source:      row.source,
        startStep:   row.startStep,
        endStep:     row.endStep,
        tritLo:      row.tritLo,
        tritHi:      row.tritHi,
        forte:       row.forte,
        octave:      row.octave,
        bpm:         row.bpm,
        numerator:   row.numerator,
        denominator: row.denominator,
        steps:       row.steps,
        sequence:    row.sequence_str,
      });
    }
  });

  let batch: BatchRow[] = [];
  let total = 0;

  function flush(): void {
    if (batch.length > 0) {
      flushTx(batch);
      batch = [];
    }
  }

  return {
    get count() { return total; },

    add(seg: SegmentRecord): void {
      batch.push({ ...seg, sequence_str: JSON.stringify(seg.sequence) });
      total++;
      if (batch.length >= BATCH_SIZE) flush();
    },

    flush,

    close(): void {
      flush();
      db.close();
    },
  };
}
