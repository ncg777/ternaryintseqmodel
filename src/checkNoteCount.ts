import Database from 'better-sqlite3';

const db = new Database('MIDI_SEGMENTS.db', { readonly: true });

console.log('Counting rows with note_count >= 12...');
const start = performance.now();
const total = db.prepare('SELECT COUNT(*) AS c FROM segments WHERE note_count >= 12').get() as { c: number };
console.log(`  ${total.c} in ${(performance.now() - start).toFixed(1)}ms`);

console.log('Fetching 5000 ids with note_count >= 12...');
const start2 = performance.now();
const rows = db.prepare('SELECT id, forte FROM segments WHERE note_count >= 12 LIMIT 5000').all() as { id: number; forte: string }[];
console.log(`  ${rows.length} rows in ${(performance.now() - start2).toFixed(1)}ms`);
