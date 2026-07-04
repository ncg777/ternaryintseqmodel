import Database from 'better-sqlite3';

const db = new Database('MIDI_SEGMENTS.db', { readonly: true });

function checkForte(forte: string) {
  console.log(`\nStats for ${forte}:`);
  const total = db.prepare('SELECT COUNT(*) AS c FROM segments WHERE forte = ?').get(forte) as { c: number };
  const withNotes = db.prepare('SELECT COUNT(*) AS c FROM segments WHERE forte = ? AND note_count >= 12').get(forte) as { c: number };
  console.log(`  total: ${total.c}, note_count>=12: ${withNotes.c}`);

  const start = performance.now();
  db.prepare('SELECT id FROM segments WHERE forte = ? AND note_count >= 12 LIMIT 500').all(forte);
  console.log(`  LIMIT 500 id-only: ${(performance.now() - start).toFixed(1)}ms`);
}

checkForte('4-21.00');
checkForte('2-2.00');
checkForte('2-2.02');
checkForte('2-5.00');
checkForte('2-5.02');
