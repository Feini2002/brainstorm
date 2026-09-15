// Read-only data-directory inspection for Feini Brain (T073).
//
// Purpose: answer "what is actually in this data directory, and is it intact?"
// without changing anything. That constraint is the whole design:
//
//   - The database is opened with `readOnly: true`, so SQLite itself refuses a
//     write rather than relying on this script's discipline. Integrity checking
//     and counting need no writer.
//   - No `PRAGMA` that mutates is issued (no `wal_checkpoint`, no `VACUUM`, no
//     `journal_mode` change). A diagnostic that rewrites the file destroys the
//     evidence it was run to collect (T073-R04).
//   - Output deliberately excludes note text and secret values (T073-R05). It
//     reports counts, sizes, versions and *whether* a key exists — never the key
//     itself, and never a sample of a note.
//
// A missing database is a normal, reportable state rather than an error: pointing
// `BRAIN_DATA_DIR` at the wrong path is one of the most common causes of "my data
// disappeared", and the answer is to say "this path holds no database" instead of
// alarming the user (T073-C04).
//
// Plain `.mjs` (no types) so it runs on the interpreter directly with no build
// step — a recovery tool that needs a compile step is useless exactly when it is
// needed.
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { DatabaseSync } from 'node:sqlite';

export const EXIT = {
  ok: 0,
  /** The database is unreadable or fails integrity checks. */
  damaged: 1,
  usage: 3,
};

/** Sidecar files WAL mode creates; their presence means the main file is not the whole story. */
export const SIDECAR_SUFFIXES = ['-wal', '-shm'];

function safeStatSize(file) {
  try {
    return statSync(file).size;
  } catch {
    return null;
  }
}

/**
 * Inspect a data directory without writing to it.
 *
 * Everything is reported through the return value so the CLI and the tests read
 * the same structure; the function never prints and never exits.
 */
export function inspectDataDir(dataDir) {
  const resolved = path.resolve(dataDir);
  const databasePath = path.join(resolved, 'brain.db');

  const inspection = {
    dataDir: resolved,
    exists: false,
    database: { path: databasePath, exists: false, sizeBytes: null },
    sidecars: [],
    walHasContent: false,
    readable: false,
    integrity: 'absent',
    integrityDetail: null,
    schemaVersion: null,
    counts: null,
    keyConfigured: null,
    otherFiles: [],
  };

  if (!existsSync(resolved)) {
    return inspection;
  }
  inspection.exists = true;

  inspection.database.exists = existsSync(databasePath);
  inspection.database.sizeBytes = safeStatSize(databasePath);

  inspection.sidecars = SIDECAR_SUFFIXES.map((suffix) => {
    const file = `${databasePath}${suffix}`;
    return { name: path.basename(file), exists: existsSync(file), sizeBytes: safeStatSize(file) };
  });
  // A non-empty `-wal` means recent commits live only there; copying brain.db
  // alone would lose them (T073-R02).
  inspection.walHasContent = inspection.sidecars.some(
    (sidecar) => sidecar.name.endsWith('-wal') && (sidecar.sizeBytes ?? 0) > 0,
  );

  // Files that are neither the database nor its sidecars. Reported by name only,
  // so an unexpected file is visible without dumping anyone's content.
  try {
    inspection.otherFiles = readdirSync(resolved)
      .filter((name) => !name.startsWith('brain.db'))
      .sort();
  } catch {
    inspection.otherFiles = [];
  }

  if (!inspection.database.exists) {
    return inspection;
  }

  return { ...inspection, ...inspectDatabaseRows(databasePath) };
}

/**
 * Open read-only and gather versions, counts and integrity.
 *
 * Split out so the caller's early returns stay flat. Any failure here means the
 * file exists but cannot be used, which is reported as `unreadable`/`damaged`
 * rather than thrown — the user needs to know the state of the file, and a stack
 * trace is not that.
 */
export function inspectDatabaseRows(databasePath) {
  let db;
  try {
    // `readOnly: true` also refuses to create the file, so a typo in the path
    // can never be answered by silently making an empty database.
    db = new DatabaseSync(databasePath, { readOnly: true });
  } catch (error) {
    return {
      readable: false,
      integrity: 'unreadable',
      integrityDetail: error instanceof Error ? error.message : '无法以只读方式打开',
    };
  }

  try {
    // No `PRAGMA journal_mode` / `wal_checkpoint` here: those write, and the
    // point is to observe the current state rather than change it.
    const versionRow = db.prepare('PRAGMA user_version').get();
    const schemaVersion =
      versionRow && typeof versionRow.user_version === 'number' ? versionRow.user_version : null;

    // `integrity_check` may return several rows; one is the common healthy case.
    const integrityRows = db.prepare('PRAGMA integrity_check').all();
    const results = integrityRows.map((row) => String(row.integrity_check ?? ''));
    const integrityOk = results.length === 1 && results[0] === 'ok';

    const count = (table) => {
      try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get();
        return Number(row?.n ?? 0);
      } catch {
        // A table missing because the schema is older is itself useful
        // information; report 0 rather than failing the whole inspection.
        return 0;
      }
    };

    // Whether a key exists, never its value (T073-R05).
    let keyConfigured = null;
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM secrets').get();
      keyConfigured = Number(row?.n ?? 0) > 0;
    } catch {
      keyConfigured = null;
    }

    return {
      readable: true,
      integrity: integrityOk ? 'ok' : 'damaged',
      integrityDetail: integrityOk ? null : results.join('; ').slice(0, 500),
      schemaVersion,
      counts: {
        items: count('knowledge_items'),
        tags: count('tags'),
        itemTags: count('item_tags'),
        relations: count('relations'),
        views: count('views'),
        runs: count('ai_runs'),
      },
      keyConfigured,
    };
  } catch (error) {
    return {
      readable: false,
      integrity: 'damaged',
      integrityDetail: error instanceof Error ? error.message : '读取失败',
    };
  } finally {
    try {
      db.close();
    } catch {
      // Closing a read-only handle cannot lose data.
    }
  }
}

/**
 * Human-readable report.
 *
 * Leads with the data path, because the most common false alarm is a wrong path:
 * counts of zero are only meaningful next to *which* directory was read
 * (T073-C04).
 */
export function formatInspection(inspection) {
  const lines = [];
  lines.push(`数据目录：${inspection.dataDir}`);
  lines.push(`目录存在：${inspection.exists ? '是' : '否'}`);

  if (!inspection.exists) {
    lines.push('');
    lines.push('该路径不存在。这通常意味着 BRAIN_DATA_DIR 指向了错误的目录，');
    lines.push('而不是资料被删除。请先确认配置，再在正确路径上重新运行本诊断。');
    return lines.join('\n');
  }

  lines.push(`数据库文件：${inspection.database.exists ? '存在' : '不存在'}`);
  if (inspection.database.exists && inspection.database.sizeBytes !== null) {
    lines.push(`主文件大小：${inspection.database.sizeBytes} 字节`);
  }

  for (const sidecar of inspection.sidecars) {
    lines.push(
      `日志文件 ${sidecar.name}：${sidecar.exists ? `存在（${sidecar.sizeBytes ?? 0} 字节）` : '不存在'}`,
    );
  }
  if (inspection.walHasContent) {
    lines.push('');
    lines.push('注意：-wal 文件包含尚未合并进主文件的提交。');
    lines.push('此时只复制 brain.db 会丢失最近的写入；请按 docs/operations/backup-recovery.md');
    lines.push('的停服步骤备份整个目录，或使用应用内的逻辑导出。');
  }

  if (!inspection.database.exists) {
    lines.push('');
    lines.push('该目录没有 brain.db，可能是一个新数据目录或错误的路径。');
    lines.push('本诊断不会创建空库，因此不会掩盖问题。');
    return lines.join('\n');
  }

  lines.push('');
  lines.push(`可读取：${inspection.readable ? '是' : '否'}`);
  lines.push(`完整性检查：${inspection.integrity}`);
  if (inspection.integrityDetail) {
    lines.push(`完整性详情：${inspection.integrityDetail}`);
  }
  if (inspection.schemaVersion !== null) {
    lines.push(`schema 版本：${inspection.schemaVersion}`);
  }
  if (inspection.counts) {
    const { items, tags, itemTags, relations, views, runs } = inspection.counts;
    lines.push(
      `记录计数：条目 ${items}、标签 ${tags}、标签连接 ${itemTags}、关系 ${relations}、视图 ${views}、运行 ${runs}`,
    );
  }
  if (inspection.keyConfigured !== null) {
    // Says whether, never what.
    lines.push(`是否已配置模型 Key：${inspection.keyConfigured ? '是（值未显示）' : '否'}`);
  }
  if (inspection.otherFiles.length > 0) {
    lines.push(`目录内其它文件：${inspection.otherFiles.join('、')}`);
  }

  if (inspection.integrity === 'damaged' || inspection.integrity === 'unreadable') {
    lines.push('');
    lines.push('检测到数据库可能损坏。请先停止服务，并把整个数据目录复制到一个只读的安全位置，');
    lines.push('再在副本上排查；不要删除原件，也不要用再次启动来「修复」。');
    lines.push('详见 docs/operations/backup-recovery.md。');
  }

  return lines.join('\n');
}

/** Exit code for a report: nonzero only when the file is unusable (T073-C03). */
export function exitCodeFor(inspection) {
  if (!inspection.exists || !inspection.database.exists) return EXIT.ok;
  return inspection.integrity === 'ok' ? EXIT.ok : EXIT.damaged;
}

export function resolveDefaultDataDir() {
  // Mirrors src/server/runtime/dataDir.ts without importing server-only code.
  const override = process.env.BRAIN_DATA_DIR;
  if (override !== undefined && override.trim().length > 0) return path.resolve(override.trim());
  return path.join(process.cwd(), '.data');
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('scripts', 'inspect-data.mjs'));

if (isMain) {
  const { values } = parseArgs({
    options: { 'data-dir': { type: 'string' }, json: { type: 'boolean', default: false } },
    allowPositionals: true,
  });

  const target = values['data-dir'] ?? resolveDefaultDataDir();
  const inspection = inspectDataDir(target);

  if (values.json) {
    console.log(JSON.stringify(inspection, null, 2));
  } else {
    console.log(formatInspection(inspection));
  }

  // The report is the product; the exit code only signals a damaged file so a
  // script can branch without parsing the text.
  process.exitCode = exitCodeFor(inspection);
}
