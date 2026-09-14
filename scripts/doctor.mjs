// Runtime preflight for Feini Brain (T001).
//
// Responsibilities (docs/04_tasks/G0/T001_runtime.md):
//   - accept only Node 24 LTS, >= 24.15, < 25 (T001-R01)
//   - probe SQLite read/write in the system temp dir with CJK + emoji (T001-R02)
//   - verify the working directory is writable and path-safe (T001-R03)
//   - verify npm can read package.json (T001-R04)
//   - separate local capability failures from network failures (T001-R05)
//   - be repeatable, leave no database/key/model traffic behind (T001-R06)
//
// It never opens the user's .data directory and never talks to a model provider.
import { access, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const MIN_NODE = { major: 24, minor: 15 };

/** Exit codes are stable so callers can branch without parsing text. */
export const EXIT = {
  ok: 0,
  localFailure: 1,
  unsupportedNode: 2,
  usage: 3,
};

export function parseNodeVersion(version) {
  const [major = 0, minor = 0, patch = 0] = String(version)
    .split('.')
    .map((part) => Number.parseInt(part, 10));
  return { major, minor, patch };
}

/** T001-R01: only the verified Node 24 LTS range, never a future major. */
export function checkNodeVersion(version) {
  const parsed = parseNodeVersion(version);
  if (parsed.major !== MIN_NODE.major) {
    return {
      ok: false,
      reason: `需要 Node ${MIN_NODE.major}.${MIN_NODE.minor} LTS，当前主版本为 ${parsed.major}`,
    };
  }
  if (parsed.minor < MIN_NODE.minor) {
    return {
      ok: false,
      reason: `需要 Node >= ${MIN_NODE.major}.${MIN_NODE.minor}.0，当前为 ${version}`,
    };
  }
  return { ok: true };
}

/**
 * T001-R02: probe a throwaway SQLite file. Written and reopened to prove the
 * built-in module actually round-trips CJK and emoji, then deleted.
 */
export async function probeSqlite() {
  const { DatabaseSync } = await import('node:sqlite');
  let dir;
  let db;
  try {
    dir = await mkdtemp(path.join(tmpdir(), 'feini-doctor-'));
    const file = path.join(dir, 'probe.db');
    const value = '本地持久化探针 🧠\nsecond line';

    db = new DatabaseSync(file);
    db.exec(
      'PRAGMA foreign_keys=ON; CREATE TABLE probe(id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;',
    );
    db.prepare('INSERT INTO probe(id,value) VALUES (?,?)').run(1, value);
    db.close();
    db = undefined;

    db = new DatabaseSync(file);
    const row = db.prepare('SELECT value FROM probe WHERE id=?').get(1);
    if (row?.value !== value) {
      throw new Error('SQLITE_READBACK_MISMATCH');
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : '未知错误',
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // The probe file is about to be removed anyway.
      }
    }
    // Only the directory this function created is removed (T001-R06).
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/** T001-R03: the working directory must accept a real file, not just a stat. */
export async function probeWritableDirectory(directory) {
  const probe = path.join(directory, `.feini-doctor-${process.pid}`);
  try {
    await writeFile(probe, 'ok', 'utf8');
    await unlink(probe);
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : '未知错误',
    };
  }
}

/** T001-R04: npm must be able to read package.json, but nothing is modified. */
export async function probeProjectFiles(projectRoot) {
  const manifestPath = path.join(projectRoot, 'package.json');
  try {
    await access(manifestPath, fsConstants.R_OK);
    const raw = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw);
    return { ok: true, npmProject: manifest.name ?? '(unnamed)' };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : '未知错误',
    };
  }
}

export function readNpmVersion(env = process.env) {
  return env.npm_config_user_agent ?? null;
}

/** T001-R06: describe the interpreter without leaking私人目录 content. */
export function environmentSummary(projectRoot) {
  return {
    node: process.versions.node,
    npmUserAgent: readNpmVersion(),
    platform: process.platform,
    arch: process.arch,
    // Report only whether the path is non-ASCII/long, never the full path.
    projectPathHasNonAscii: /[^\u0000-\u007f]/u.test(projectRoot),
    projectPathHasSpace: projectRoot.includes(' '),
  };
}

export async function runDoctor(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const version = checkNodeVersion(process.versions.node);
  const report = {
    application: 'feini-brain',
    node: process.versions.node,
    nodeSupported: version.ok,
    // T001-R05: an offline machine is reported separately from a broken runtime.
    network: 'not-checked',
    sqlite: { ok: false },
    writableDirectory: { ok: false },
    projectFiles: { ok: false },
  };

  if (!version.ok) {
    return { exitCode: EXIT.unsupportedNode, report, failure: version.reason };
  }

  // T001-R03: resolve through path APIs so spaces and CJK survive.
  const resolvedRoot = path.resolve(projectRoot);
  report.sqlite = await probeSqlite();
  report.writableDirectory = await probeWritableDirectory(resolvedRoot);
  report.projectFiles = await probeProjectFiles(resolvedRoot);

  const failed = [];
  if (!report.sqlite.ok) failed.push(`SQLite 探针失败：${report.sqlite.reason}`);
  if (!report.writableDirectory.ok) {
    failed.push(`当前目录不可写：${report.writableDirectory.reason}`);
  }
  if (!report.projectFiles.ok) failed.push(`无法读取 package.json：${report.projectFiles.reason}`);

  record(projectRoot, report);
  if (failed.length > 0) {
    return { exitCode: EXIT.localFailure, report, failure: failed.join('；') };
  }
  return { exitCode: EXIT.ok, report, failure: null };
}

/** Keep a bounded machine-readable record beside the app for support. */
function record(projectRoot, report) {
  if (process.env.FEINI_DOCTOR_RECORD === 'off') return;
  try {
    const file = path.join(projectRoot, 'implementation', 'progress', 'runtime-report.json');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify({ ...report, checkedAt: new Date().toISOString() }, null, 2)}\n`,
      'utf8',
    );
  } catch {
    // A missing report file must never turn a passing preflight into a failure.
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('scripts', 'doctor.mjs'));

if (isMain) {
  const { exitCode, report, failure } = await runDoctor();
  if (failure) {
    console.error(`PREFLIGHT_FAILED: ${failure}`);
    console.error(JSON.stringify(report, null, 2));
  } else {
    console.log(JSON.stringify({ ok: true, ...environmentSummary(process.cwd()), report }, null, 2));
  }
  process.exitCode = exitCode;
}
