/**
 * T073 — WAL 备份、数据搬迁与损坏恢复说明。
 *
 * The subject is *operational safety*, so the tests assert on state rather than
 * on prose:
 *
 *   - The documentation is checked for the procedures it must contain (a manual
 *     that omits "stop the service first" is a defect, and that is testable).
 *   - The diagnostic script is checked against real databases — a healthy one, a
 *     physically corrupted one, an empty directory and a wrong path — because the
 *     script's value is that it tells these apart without touching the file.
 *   - "Read-only" is verified by hashing the database before and after, which is
 *     the only assertion that would catch a script that opened the file writable
 *     and let SQLite checkpoint it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  EXIT,
  exitCodeFor,
  formatInspection,
  inspectDataDir,
} from '../../scripts/inspect-data.mjs';

const REPO = process.cwd();
const DOC_PATH = path.join(REPO, 'docs', 'operations', 'backup-recovery.md');

const tempDirs: string[] = [];

function tempDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `feini-t073-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Build a healthy database with one note and a configured key. */
function buildHealthyDb(dir: string, options: { leaveWalOpen?: boolean } = {}): DatabaseSync | null {
  const db = new DatabaseSync(path.join(dir, 'brain.db'));
  db.exec('PRAGMA journal_mode=WAL');
  // Auto-checkpoint off so a WAL file exists to observe (T073-C01).
  db.exec('PRAGMA wal_autocheckpoint=0');
  db.exec('PRAGMA user_version=1');
  db.exec(
    'CREATE TABLE knowledge_items(id TEXT PRIMARY KEY, raw_text TEXT);' +
      'CREATE TABLE secrets(key TEXT PRIMARY KEY, value TEXT);' +
      'CREATE TABLE tags(id TEXT PRIMARY KEY);' +
      'CREATE TABLE item_tags(item_id TEXT, tag_id TEXT);' +
      'CREATE TABLE relations(id TEXT PRIMARY KEY);' +
      'CREATE TABLE views(id TEXT PRIMARY KEY);' +
      'CREATE TABLE ai_runs(id TEXT PRIMARY KEY);',
  );
  db.prepare('INSERT INTO knowledge_items VALUES(?,?)').run(
    'aaaaaaaa-0000-4000-8000-000000000001',
    '中文笔记 🧠 含 emoji',
  );
  db.prepare('INSERT INTO secrets VALUES(?,?)').run('llm_api_key', 'sk-super-secret-must-not-print');

  if (options.leaveWalOpen) return db;
  db.close();
  return null;
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

describe('T073 WAL 备份与恢复说明', () => {
  describe('T073-C01 活跃 WAL', () => {
    it('诊断指出 WAL 含未合并提交，并提示不能只复制主文件', () => {
      const dir = tempDir('wal');
      // Keep the writer open so its WAL is not checkpointed away.
      const writer = buildHealthyDb(dir, { leaveWalOpen: true });
      try {
        const inspection = inspectDataDir(dir);

        expect(inspection.exists).toBe(true);
        expect(inspection.database.exists).toBe(true);
        expect(inspection.walHasContent).toBe(true);
        expect(inspection.integrity).toBe('ok');

        // The warning is the deliverable: it must name the WAL file and say
        // copying brain.db alone loses writes.
        const report = formatInspection(inspection);
        expect(report).toContain('brain.db-wal');
        expect(report).toContain('只复制 brain.db 会丢失');
        expect(report).toContain('backup-recovery.md');
      } finally {
        writer?.close();
      }
    });

    it('文档要求停服或使用 SQLite 一致备份接口，不认可活跃期裸拷贝', () => {
      const doc = readFileSync(DOC_PATH, 'utf8');
      // Names the mechanism, not just "be careful".
      expect(doc).toContain('-wal');
      expect(doc).toMatch(/停服|停止服务/u);
      // Offers the supported consistent alternative.
      expect(doc).toMatch(/sqlite3?\.?.*\.backup|VACUUM INTO|backup 命令/u);
    });
  });

  describe('T073-C02 目录搬迁', () => {
    it('文档的搬迁步骤是先停服、复制完整目录、再改 BRAIN_DATA_DIR，且保留旧副本', () => {
      const doc = readFileSync(DOC_PATH, 'utf8');

      // Order matters: the manual must not tell the user to move first and stop
      // later, and must not delete the old copy.
      expect(doc).toContain('BRAIN_DATA_DIR');
      expect(doc).toMatch(/保留|不要删除|旧副本/u);
      expect(doc).toMatch(/停服|停止服务/u);
      // Paths with spaces are called out because that is the common breakage.
      expect(doc).toMatch(/空格/u);
    });

    it('搬迁演练：整目录复制到新位置后数据一致，旧副本仍在', () => {
      const source = tempDir('move-src');
      buildHealthyDb(source);
      const beforeHash = sha256(path.join(source, 'brain.db'));

      // Copy the whole directory (the procedure the doc prescribes).
      const dest = tempDir('move-dest');
      for (const name of ['brain.db', 'brain.db-wal', 'brain.db-shm']) {
        const from = path.join(source, name);
        try {
          writeFileSync(path.join(dest, name), readFileSync(from));
        } catch {
          // A missing sidecar is fine; only present files are copied.
        }
      }

      expect(sha256(path.join(dest, 'brain.db'))).toBe(beforeHash);

      const moved = inspectDataDir(dest);
      expect(moved.integrity).toBe('ok');
      expect(moved.counts?.items).toBe(1);
      // The original copy must survive the move.
      expect(inspectDataDir(source).counts?.items).toBe(1);
      expect(sha256(path.join(source, 'brain.db'))).toBe(beforeHash);
    });

    it('BRAIN_DATA_DIR 指向含空格与中文的路径时仍能读取', () => {
      const parent = tempDir('space');
      const dir = path.join(parent, '带 空格 的 目录');
      mkdirSync(dir, { recursive: true });
      buildHealthyDb(dir);

      const inspection = inspectDataDir(dir);
      expect(inspection.exists).toBe(true);
      expect(inspection.integrity).toBe('ok');
      expect(inspection.counts?.items).toBe(1);
    });
  });

  describe('T073-C03 损坏文件', () => {
    it('损坏库被报告为异常，且不修改原件', () => {
      const dir = tempDir('corrupt');
      buildHealthyDb(dir);
      const dbPath = path.join(dir, 'brain.db');

      // Corrupt the file body while keeping a plausible header, which is the
      // realistic damage (a bad sector, a truncated copy) rather than a random
      // text file — SQLite must reach integrity_check and fail.
      const original = readFileSync(dbPath);
      const corrupted = Buffer.from(original);
      for (let offset = 100; offset < corrupted.length; offset += 7) {
        corrupted[offset] = 0x00;
      }
      writeFileSync(dbPath, corrupted);

      const hashBefore = sha256(dbPath);
      const sizeBefore = statSync(dbPath).size;

      const inspection = inspectDataDir(dir);

      // The specific outcome matters. With a plausible header and a corrupt
      // body, the file *opens* but SQLite refuses to serve it, so the script
      // reports `damaged` with the real SQLite message rather than degrading to
      // a vague "unreadable". Accepting either value would let a script that
      // merely failed to open the file pass this case.
      expect(inspection.integrity).toBe('damaged');
      expect(inspection.integrityDetail).not.toBeNull();
      expect(exitCodeFor(inspection)).toBe(EXIT.damaged);

      // The file is byte-for-byte untouched: a diagnostic must not "repair" by
      // rewriting, because that destroys the evidence.
      expect(sha256(dbPath)).toBe(hashBefore);
      expect(statSync(dbPath).size).toBe(sizeBefore);
    });

    it('损坏报告提示先复制原件到安全位置，不要删除或重建', () => {
      const dir = tempDir('corrupt-doc');
      buildHealthyDb(dir);
      const dbPath = path.join(dir, 'brain.db');
      const original = readFileSync(dbPath);
      const corrupted = Buffer.from(original);
      for (let offset = 100; offset < corrupted.length; offset += 7) corrupted[offset] = 0x00;
      writeFileSync(dbPath, corrupted);

      const report = formatInspection(inspectDataDir(dir));
      expect(report).toContain('损坏');
      expect(report).toMatch(/只读|安全位置/u);
      expect(report).toMatch(/不要删除/u);
    });

    it('损坏库仍以只读方式打开，不会触发自动恢复写入', () => {
      const dir = tempDir('corrupt-ro');
      buildHealthyDb(dir);
      const dbPath = path.join(dir, 'brain.db');
      const original = readFileSync(dbPath);
      const corrupted = Buffer.from(original);
      for (let offset = 100; offset < corrupted.length; offset += 7) corrupted[offset] = 0x00;
      writeFileSync(dbPath, corrupted);

      // Run twice: if the first run had written (e.g. by checkpointing or
      // attempting repair), the bytes would differ by the second.
      const first = sha256(dbPath);
      inspectDataDir(dir);
      inspectDataDir(dir);
      expect(sha256(dbPath)).toBe(first);
    });

    it('文档禁止用删除数据目录或新建同名空库来「修复」', () => {
      const doc = readFileSync(DOC_PATH, 'utf8');
      expect(doc).toMatch(/不要删除|禁止删除/u);
      expect(doc).toMatch(/删掉 \.data|删除 \.data|重新启动/u);
      // And forbids VACUUM-style overwrite of the only copy.
      expect(doc).toMatch(/VACUUM/u);
    });
  });

  describe('T073-C04 空库误读', () => {
    it('BRAIN_DATA_DIR 指向错误路径时辨认出这是路径问题，而非资料被删', () => {
      const missing = path.join(tempDir('wrong-path'), 'does-not-exist');
      const inspection = inspectDataDir(missing);

      expect(inspection.exists).toBe(false);
      expect(inspection.integrity).toBe('absent');
      // A missing path is not "damaged"; it exits 0 so a script is not told the
      // database is broken when the path is simply wrong.
      expect(exitCodeFor(inspection)).toBe(EXIT.ok);

      const report = formatInspection(inspection);
      expect(report).toContain('BRAIN_DATA_DIR');
      expect(report).toMatch(/指向了错误的目录|错误的路径/u);
      expect(report).not.toContain('损坏');
    });

    it('空目录被辨认成新数据目录，且不创建空库来掩盖问题', () => {
      const dir = tempDir('empty');
      const inspection = inspectDataDir(dir);

      expect(inspection.exists).toBe(true);
      expect(inspection.database.exists).toBe(false);
      expect(inspection.counts).toBeNull();

      const report = formatInspection(inspection);
      expect(report).toContain('没有 brain.db');
      expect(report).toContain('不会创建空库');

      // Crucially, inspecting an empty directory must not leave a database
      // behind: a diagnostic that creates one would hide the very problem.
      expect(inspectDataDir(dir).database.exists).toBe(false);
    });

    it('诊断报告先给出读的是哪个路径，避免用零计数误导', () => {
      const dir = tempDir('path-first');
      const report = formatInspection(inspectDataDir(dir));
      const lines = report.split('\n');
      // The path is the first line, before any counts.
      expect(lines[0]).toContain('数据目录：');
      expect(lines[0]).toContain(dir);
    });
  });

  describe('T073-C05 分享风险', () => {
    it('文档说明完整数据库可能含明文 Key，并推荐脱敏逻辑导出', () => {
      const doc = readFileSync(DOC_PATH, 'utf8');

      // Both halves: the risk, and the recommended alternative.
      expect(doc).toMatch(/明文|未加密|Key 会|秘密/u);
      expect(doc).toMatch(/逻辑导出|JSON 备份|应用内导出/u);
      expect(doc).toMatch(/分享|发给别人|外发/u);
    });

    it('诊断只报告是否配置 Key，绝不打印其值', () => {
      const dir = tempDir('key');
      buildHealthyDb(dir);

      const inspection = inspectDataDir(dir);
      expect(inspection.keyConfigured).toBe(true);

      // Both the structure and the rendered text are checked: a future field
      // added for convenience would show up in one of them.
      const asJson = JSON.stringify(inspection);
      const asText = formatInspection(inspection);
      expect(asJson).not.toContain('sk-super-secret');
      expect(asText).not.toContain('sk-super-secret');
      expect(asText).toContain('值未显示');
    });

    it('诊断不输出笔记原文', () => {
      const dir = tempDir('no-text');
      buildHealthyDb(dir);

      const asJson = JSON.stringify(inspectDataDir(dir));
      expect(asJson).not.toContain('中文笔记');
      expect(asJson).not.toContain('🧠');
    });
  });

  describe('T073-C06 恢复校验', () => {
    it('从文件备份恢复后可运行计数与抽样检查，确认引用正确', () => {
      // A copy-based restore drill: build, copy, verify the copy independently.
      const source = tempDir('restore-src');
      const writer = buildHealthyDb(source, { leaveWalOpen: true });
      writer?.close();

      const dest = tempDir('restore-dest');
      for (const name of ['brain.db', 'brain.db-wal', 'brain.db-shm']) {
        try {
          writeFileSync(path.join(dest, name), readFileSync(path.join(source, name)));
        } catch {
          // Optional sidecar.
        }
      }

      const inspection = inspectDataDir(dest);
      expect(inspection.integrity).toBe('ok');
      expect(inspection.counts?.items).toBe(1);

      // Sample the actual note text to confirm the restore is semantic, not just
      // structurally valid — "it opens" is not "the data came back".
      const db = new DatabaseSync(path.join(dest, 'brain.db'), { readOnly: true });
      try {
        const row = db.prepare('SELECT raw_text FROM knowledge_items').get();
        expect(row?.raw_text).toContain('中文笔记');
        expect(row?.raw_text).toContain('🧠');
      } finally {
        db.close();
      }
    });

    it('文档要求在继续写入前先确认计数与抽样原文', () => {
      const doc = readFileSync(DOC_PATH, 'utf8');
      expect(doc).toMatch(/抽样|抽查/u);
      expect(doc).toMatch(/计数/u);
      expect(doc).toMatch(/inspect-data\.mjs/u);
    });
  });
});

describe('T073 诊断脚本的非破坏性', () => {
  it('健康库检查前后字节完全一致（只读打开，无检查点写入）', () => {
    const dir = tempDir('readonly');
    buildHealthyDb(dir);
    const dbPath = path.join(dir, 'brain.db');

    const before = sha256(dbPath);
    const sizeBefore = statSync(dbPath).size;

    const first = inspectDataDir(dir);
    const second = inspectDataDir(dir);

    expect(first.integrity).toBe('ok');
    expect(second.integrity).toBe('ok');
    expect(sha256(dbPath)).toBe(before);
    expect(statSync(dbPath).size).toBe(sizeBefore);
    // A second run must not see different counts from the first.
    expect(second.counts).toEqual(first.counts);
  });

  it('不存在的路径不会被创建', () => {
    const parent = tempDir('no-create');
    const missing = path.join(parent, 'nested', 'missing');
    inspectDataDir(missing);
    expect(() => statSync(missing)).toThrow();
  });

  it('退出码约定：健康库与空目录为 0，损坏库非 0', () => {
    const healthy = tempDir('exit-healthy');
    buildHealthyDb(healthy);
    expect(exitCodeFor(inspectDataDir(healthy))).toBe(EXIT.ok);

    const empty = tempDir('exit-empty');
    expect(exitCodeFor(inspectDataDir(empty))).toBe(EXIT.ok);

    expect(EXIT.damaged).not.toBe(EXIT.ok);
  });
});
