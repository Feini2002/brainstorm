// Runtime preflight for Feini Brain (T001, extended by T080).
//
// Responsibilities (docs/04_tasks/G0/T001_runtime.md):
//   - accept only Node 24 LTS, >= 24.15, < 25 (T001-R01)
//   - probe SQLite read/write in the system temp dir with CJK + emoji (T001-R02)
//   - verify the working directory is writable and path-safe (T001-R03)
//   - verify npm can read package.json (T001-R04)
//   - separate local capability failures from network failures (T001-R05)
//   - be repeatable, leave no database/key/model traffic behind (T001-R06)
//
// Added for the Windows runbook (docs/04_tasks/G6/T080_windows_runbook.md):
//   - report whether the app port is already taken, and *who* holds it, so the
//     advice is "close that instance" instead of "kill every node process"
//     (T080-R06, T080-C04)
//   - report which `node` PATH resolves to versus the interpreter actually
//     running (T080-R02/C02): installing Node does not change an open terminal
//   - report proxy/CA/TLS environment *presence* (redacted) so a download
//     failure can be told apart from a broken dependency tree (T080-R05/C03)
//
// Everything here is read-only: it binds a socket, spawns `netstat`/`where` and
// reads environment variables. It never opens the user's .data directory, never
// changes a proxy/TLS setting, and never talks to a model provider.
import { access, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const MIN_NODE = { major: 24, minor: 15 };

/**
 * Defaults mirror `scripts/start-local.mjs` on purpose.
 *
 * If the preflight checked a different address than the launcher binds, "port is
 * free" would be a claim about a port nobody uses.
 */
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 3000;

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

/**
 * T080-R02 / T080-C02: which `node` a *new* shell would pick.
 *
 * The interpreter running this script is `process.execPath`. If PATH resolves to
 * a different file, a terminal opened before the install (or a second Node in
 * PATH) is still in play — and that is a different failure than "Node is too
 * old". Reported as a comparison rather than a verdict, because both PATHs can
 * legitimately point at the same installation through different shims.
 *
 * Never runs a shell command string: `where.exe`/`command -v` are invoked as
 * real arguments, so a path with spaces or CJK cannot be re-parsed (T080-R01).
 */
export function probePathInterpreter(env = process.env, platform = process.platform) {
  const command = platform === 'win32' ? 'where.exe' : 'command';
  const args = platform === 'win32' ? ['node'] : ['-v', 'node'];
  let found = [];
  let ok = false;
  try {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, env });
    ok = result.status === 0;
    found = (result.stdout ?? '')
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    // A PATH probe that cannot run is reported as unknown, not as a failure:
    // "we could not ask" is a different fact from "the wrong Node is selected".
    ok = false;
  }
  const normalized = (value) => {
    try {
      return path.resolve(value).toLowerCase();
    } catch {
      return value.toLowerCase();
    }
  };
  return {
    ok,
    candidates: found,
    /** Whether some PATH entry is the very interpreter running this preflight. */
    includesRunning: found.some((entry) => normalized(entry) === normalized(process.execPath)),
    running: process.execPath,
  };
}

/**
 * T080-C04: is the app port free, and if not, which process holds it?
 *
 * Binding the port is the only honest test — a connect attempt would report a
 * firewall drop the same way as a free port. When it is taken, the owner is
 * looked up read-only so the user is told *which* PID to close.
 *
 * The owner lookup is best-effort by design: `netstat -ano` is present on every
 * supported Windows, but a locked-down machine may refuse it. Returning
 * `ownerKnown: false` keeps "I don't know who holds it" from reading as "the port
 * is free".
 */
export function probePortAvailability(host = DEFAULT_HOST, port = DEFAULT_PORT) {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (error) => {
      resolve({ free: false, host, port, reason: error.code ?? error.message, owner: null });
    });
    probe.once('listening', () => {
      probe.close(() => resolve({ free: true, host, port, reason: null, owner: null }));
    });
    probe.listen(port, host);
  });
}

/** Which process owns a listening port. Read-only; `null` when it cannot be told. */
export function findPortOwner(port) {
  try {
    const result = spawnSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 8000 });
    if (result.status !== 0) return null;
    const line = (result.stdout ?? '')
      .split(/\r?\n/u)
      .find((row) => new RegExp(`[.:]${port}\\s`, 'u').test(row) && /LISTENING/iu.test(row));
    if (!line) return null;
    const pid = Number.parseInt(line.trim().split(/\s+/u).pop() ?? '', 10);
    if (!Number.isInteger(pid)) return null;
    return { pid, line: line.trim() };
  } catch {
    return null;
  }
}

/**
 * T080-R05 / T080-C03: are proxy/CA/TLS settings in play?
 *
 * Only **names and whether they are set** are reported. A proxy URL can embed
 * credentials (`http://user:pass@proxy`), so the values are never printed and
 * never written to the report file.
 *
 * `disableTlsCheck` is reported separately and loudly: setting the `NODE_TLS_*`
 * "reject unauthorized" variable to `0` turns off certificate verification for the
 * whole process, which is a debugging leftover that must not be normalised into
 * the install instructions (T080-R05).
 */
export function probeNetworkEnv(env = process.env) {
  const proxyVars = [
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'NO_PROXY',
    'http_proxy',
    'https_proxy',
    'no_proxy',
    'npm_config_proxy',
    'npm_config_https_proxy',
    'npm_config_registry',
  ];
  const caVars = ['NODE_EXTRA_CA_CERTS', 'NODE_OPTIONS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE'];
  const set = (names) => names.filter((name) => (env[name] ?? '').trim().length > 0);
  return {
    proxyConfigured: set(proxyVars),
    caConfigured: set(caVars),
    /** Whether the `NODE_TLS_*` "reject unauthorized" switch was turned off. */
    tlsVerificationDisabled: (env.NODE_TLS_REJECT_UNAUTHORIZED ?? '').trim() === '0',
    /** npm's own escape hatches, which hide a real incompatibility (T002-C06). */
    npmEscapeHatch: ['npm_config_force', 'npm_config_legacy_peer_deps'].filter(
      (name) => (env[name] ?? '').trim().length > 0,
    ),
  };
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

/**
 * Which address the launcher would bind, i.e. the port worth checking.
 *
 * Reads the same two variables `scripts/start-local.mjs` reads, so the preflight
 * and the launch cannot disagree about which port is "the app port". A value that
 * is not a usable port falls back to the default rather than failing the preflight:
 * the launcher already rejects it with its own message.
 */
export function resolveLaunchTarget(env = process.env) {
  const host = (env.APP_HOST ?? DEFAULT_HOST).trim() || DEFAULT_HOST;
  const parsed = Number.parseInt(env.APP_PORT ?? String(DEFAULT_PORT), 10);
  const port = Number.isInteger(parsed) && parsed > 0 && parsed < 65536 ? parsed : DEFAULT_PORT;
  return { host, port };
}

export async function runDoctor(options = {}) {
  const projectRoot = options.projectRoot ?? process.cwd();
  const env = options.env ?? process.env;
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

  /*
   * T080's three diagnostics.
   *
   * They are recorded **after** the T001 verdict and never added to `failed`:
   * a held port is exactly what an already-correct install looks like when the
   * user simply left the app running. Folding it into the exit code would make
   * `npm run start` refuse to start the second instance with a message about a
   * broken runtime, which is the wrong advice (T080-R06).
   */
  const { host, port } = resolveLaunchTarget(env);
  const availability = await probePortAvailability(host, port);
  if (!availability.free) {
    const owner = findPortOwner(port);
    report.port = { ...availability, owner, ownerKnown: owner !== null };
  } else {
    report.port = availability;
  }
  report.pathInterpreter = probePathInterpreter(env);
  report.networkEnvironment = probeNetworkEnv(env);

  record(projectRoot, report, env);
  if (failed.length > 0) {
    return { exitCode: EXIT.localFailure, report, failure: failed.join('；') };
  }
  return { exitCode: EXIT.ok, report, failure: null };
}

/** Keep a bounded machine-readable record beside the app for support. */
function record(projectRoot, report, env = process.env) {
  if (env.FEINI_DOCTOR_RECORD === 'off') return;
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
