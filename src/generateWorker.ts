/**
 * generateWorker.ts — run ambient generation off the main event loop.
 *
 * The server spawns this as a Node.js Worker Thread.  It opens its own
 * read-only SQLite connection (Database instances cannot be transferred
 * across threads) and executes generate().  The resulting MIDI buffer is
 * transferred, not copied, back to the parent.
 */

import { parentPort, workerData } from 'worker_threads';
import Database from 'better-sqlite3';
import { PCS12 } from 'ultra-mega-enumerator';
import { generate } from './generate.ts';
import type { GenerateParams } from './generate.ts';

interface WorkerRequest {
  id: number;
  params: GenerateParams;
}

const { dbPath } = workerData as { dbPath: string };
if (!dbPath || typeof dbPath !== 'string') {
  throw new Error('generateWorker: dbPath is required in workerData');
}

const db = new Database(dbPath, { readonly: true });
db.pragma('journal_mode = WAL');
db.pragma('mmap_size = 2147483648');
db.pragma('cache_size = -32768');

parentPort!.on('message', async (req: WorkerRequest) => {
  try {
    await PCS12.init();
    const result = await generate(db, req.params);

    // Copy the MIDI data into a plain Uint8Array for the parent.  We avoid
    // transferring the Buffer's underlying ArrayBuffer because Node's pooled
    // Buffer allocation can make the buffer non-transferable in some cases.
    const midiView = new Uint8Array(result.midi.byteLength);
    midiView.set(result.midi);

    parentPort!.postMessage({
      id: req.id,
      result: {
        midi: midiView,
        bpm: result.bpm,
        forte: result.forte,
        segments: result.segments,
      },
    });
  } catch (err) {
    parentPort!.postMessage({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});
