/**
 * addIndexes.ts — add missing indexes and run ANALYZE on an existing
 * MIDI_SEGMENTS.db so the server queries run fast without a full rebuild.
 *
 * Run:  npm run add-indexes
 */

import Database from 'better-sqlite3';
import path     from 'path';
import fs       from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, '..', 'MIDI_SEGMENTS.db');

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found: ${DB_PATH}`);
  console.error('Run  npm run build-dataset  first.');
  process.exit(1);
}

console.log(`Opening ${DB_PATH} …`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const indexes: { name: string; ddl: string }[] = [
  {
    name: 'idx_seg_source',
    ddl:  'CREATE INDEX IF NOT EXISTS idx_seg_source ON segments (source)',
  },
  {
    name: 'idx_seg_forte',
    ddl:  'CREATE INDEX IF NOT EXISTS idx_seg_forte ON segments (forte)',
  },
  {
    name: 'idx_seg_steps',
    ddl:  'CREATE INDEX IF NOT EXISTS idx_seg_steps ON segments (steps)',
  },
  {
    name: 'idx_seg_bpm',
    ddl:  'CREATE INDEX IF NOT EXISTS idx_seg_bpm ON segments (bpm)',
  },
  {
    name: 'idx_seg_lower_source',
    ddl:  'CREATE INDEX IF NOT EXISTS idx_seg_lower_source ON segments (LOWER(source))',
  },
  {
    name: 'idx_seg_forte_steps',
    ddl:  'CREATE INDEX IF NOT EXISTS idx_seg_forte_steps ON segments (forte, steps)',
  },
  {
    name: 'idx_seg_forte_bpm',
    ddl:  'CREATE INDEX IF NOT EXISTS idx_seg_forte_bpm ON segments (forte, bpm)',
  },
  {
    name: 'idx_seg_source_steps',
    ddl:  'CREATE INDEX IF NOT EXISTS idx_seg_source_steps ON segments (source, steps)',
  },
  {
    name: 'idx_seg_note_count',
    ddl:  'CREATE INDEX IF NOT EXISTS idx_seg_note_count ON segments (note_count)',
  },
  {
    name: 'idx_seg_note_density',
    ddl:  'CREATE INDEX IF NOT EXISTS idx_seg_note_density ON segments (note_density)',
  },
  {
    name: 'idx_seg_unique_pitches',
    ddl:  'CREATE INDEX IF NOT EXISTS idx_seg_unique_pitches ON segments (unique_pitches)',
  },
  {
    name: 'idx_seg_polyphony_avg',
    ddl:  'CREATE INDEX IF NOT EXISTS idx_seg_polyphony_avg ON segments (polyphony_avg)',
  },
];

const existing = new Set<string>(
  (db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[])
    .map(r => r.name),
);

for (const { name, ddl } of indexes) {
  if (existing.has(name)) {
    console.log(`  already exists: ${name}`);
  } else {
    process.stdout.write(`  creating ${name} … `);
    db.exec(ddl);
    console.log('done');
  }
}

process.stdout.write('  running ANALYZE … ');
db.exec('ANALYZE');
console.log('done');

db.close();
console.log('Finished.');
