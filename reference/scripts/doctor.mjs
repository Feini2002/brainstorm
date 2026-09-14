// Reference preflight. Copy to scripts/doctor.mjs during T001.
// It never opens the user's data directory. Node >=24.15 <25 is required.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 15) {
  console.error('NODE_UNSUPPORTED: install Node 24 LTS >=24.15 and reopen the terminal.');
  process.exitCode = 2;
} else {
  let dir;
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    dir = await mkdtemp(join(tmpdir(), 'feini-doctor-'));
    const file = join(dir, 'probe.db');
    db = new DatabaseSync(file);
    db.exec('PRAGMA foreign_keys=ON; CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;');
    const value = '本地持久化探针 🧠\nsecond line';
    db.prepare('INSERT INTO probe(id,value) VALUES (?,?)').run(1, value);
    db.close(); db = undefined;
    db = new DatabaseSync(file);
    if (db.prepare('SELECT value FROM probe WHERE id=?').get(1)?.value !== value) {
      throw new Error('SQLITE_READBACK_MISMATCH');
    }
    console.log(JSON.stringify({ok:true,node:process.versions.node,sqliteReadback:true}));
  } catch (error) {
    console.error('PREFLIGHT_FAILED:', error instanceof Error ? error.name : 'UnknownError');
    process.exitCode = 1;
  } finally {
    if (db) db.close();
    if (dir) await rm(dir, {recursive:true, force:true});
  }
}
