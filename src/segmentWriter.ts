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
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source         TEXT    NOT NULL,
      start_step     INTEGER NOT NULL,
      end_step       INTEGER NOT NULL,
      trit_lo        INTEGER NOT NULL,
      trit_hi        INTEGER NOT NULL,
      forte          TEXT    NOT NULL,
      octave         INTEGER NOT NULL DEFAULT 0,
      bpm            REAL    NOT NULL,
      numerator      INTEGER NOT NULL,
      denominator    INTEGER NOT NULL,
      steps          INTEGER NOT NULL,
      sequence       TEXT    NOT NULL,
      note_count     INTEGER NOT NULL DEFAULT 0,
      note_density   REAL    NOT NULL DEFAULT 0,
      unique_pitches INTEGER NOT NULL DEFAULT 0,
      polyphony_avg  REAL    NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_seg_source       ON segments (source);
    CREATE INDEX IF NOT EXISTS idx_seg_forte        ON segments (forte);
    CREATE INDEX IF NOT EXISTS idx_seg_steps        ON segments (steps);
    CREATE INDEX IF NOT EXISTS idx_seg_bpm          ON segments (bpm);
    CREATE INDEX IF NOT EXISTS idx_seg_lower_source ON segments (LOWER(source));
    CREATE INDEX IF NOT EXISTS idx_seg_forte_steps  ON segments (forte, steps);
    CREATE INDEX IF NOT EXISTS idx_seg_forte_bpm    ON segments (forte, bpm);
    CREATE INDEX IF NOT EXISTS idx_seg_source_steps ON segments (source, steps);
    CREATE INDEX IF NOT EXISTS idx_seg_note_count     ON segments (note_count);
    CREATE INDEX IF NOT EXISTS idx_seg_note_density   ON segments (note_density);
    CREATE INDEX IF NOT EXISTS idx_seg_unique_pitches ON segments (unique_pitches);
    CREATE INDEX IF NOT EXISTS idx_seg_polyphony_avg  ON segments (polyphony_avg);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO segments
      (source, start_step, end_step, trit_lo, trit_hi,
       forte, octave, bpm, numerator, denominator, steps, sequence,
       note_count, note_density, unique_pitches, polyphony_avg)
    VALUES
      (@source, @startStep, @endStep, @tritLo, @tritHi,
       @forte, @octave, @bpm, @numerator, @denominator, @steps, @sequence,
       @noteCount, @noteDensity, @uniquePitches, @polyphonyAvg)
  `);

  interface BatchRow extends SegmentRecord { sequence_str: string }

  const flushTx = db.transaction((rows: BatchRow[]) => {
    for (const row of rows) {
      insertStmt.run({
        source:        row.source,
        startStep:     row.startStep,
        endStep:       row.endStep,
        tritLo:        row.tritLo,
        tritHi:        row.tritHi,
        forte:         row.forte,
        octave:        row.octave,
        bpm:           row.bpm,
        numerator:     row.numerator,
        denominator:   row.denominator,
        steps:         row.steps,
        sequence:      row.sequence_str,
        noteCount:     row.noteCount,
        noteDensity:   row.noteDensity,
        uniquePitches: row.uniquePitches,
        polyphonyAvg:  row.polyphonyAvg,
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

      // Persist aggregate stats so the server can read them at startup
      // without running expensive GROUP BY queries.
      db.exec(`CREATE TABLE IF NOT EXISTS stats_cache (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`);
      const segCount = (db.prepare('SELECT COUNT(*) AS n FROM segments').get() as { n: number }).n;
      const sources  = db.prepare(
        'SELECT source, COUNT(*) AS count FROM segments GROUP BY source ORDER BY source'
      ).all();
      const fortes   = db.prepare(
        'SELECT forte, COUNT(*) AS count FROM segments GROUP BY forte ORDER BY count DESC'
      ).all();
      const upsert = db.prepare(
        'INSERT OR REPLACE INTO stats_cache (key, value) VALUES (?, ?)'
      );
      db.transaction(() => {
        upsert.run('count',   String(segCount));
        upsert.run('sources', JSON.stringify(sources));
        upsert.run('fortes',  JSON.stringify(fortes));
      })();

      db.close();
    },
  };
}
