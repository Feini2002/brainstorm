// Delivery status guard (T083-R01, T083-R02, T083-R05).
//
// Two failure classes this catches:
//
//   1. A task marked `verified` whose evidence does not exist. "The file was
//      written" is not a result; the claim has to point at something a reader can
//      open. A dangling evidence path is exactly the defect T083-C01 names.
//   2. A secret or a real database that made it into the tracked tree. The
//      delivery step is itself a security boundary (T083-C04/R05): the check runs
//      over `git ls-files`, so an untracked-but-present `.data` is not silently
//      treated as "shipped" and a tracked one cannot be missed.
//
// Runs with plain Node, no build step, and never opens the user's database.
//
//   node scripts/check-delivery.mjs              # status + evidence integrity
//   node scripts/check-delivery.mjs --delivery   # + tracked-tree secret scan
//   node scripts/check-delivery.mjs --delivery --list <file> --root <dir>
//                                                # scan an explicit file list
//                                                # (used by the negative test)
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

export const EXIT = { ok: 0, failures: 1, usage: 3 };

/** T083-R01: the only four statuses the vocabulary allows. */
export const ALLOWED_STATUSES = ['not_started', 'in_progress', 'blocked', 'verified'];

/**
 * Records of *results*, as opposed to the source and test files that implement
 * them. A verified task must point at least one of these: a test file proves the
 * test exists, while the evidence file proves it was run and what came out.
 */
export const RESULT_RECORD_PREFIXES = ['implementation/progress/evidence/', 'docs/progress/'];

/**
 * Secret shapes worth failing a delivery over. Deliberately anchored to concrete
 * provider formats rather than "any long random string": a false positive here
 * blocks the check, and a check that cries wolf gets skipped.
 *
 * Every pattern requires a length beyond what a placeholder uses, so
 * `sk-test-…` fixtures (which the suites rely on) stay clean while a pasted real
 * key does not.
 */
export const SECRET_PATTERNS = [
  { name: 'OpenAI 风格 Key', re: /sk-[A-Za-z0-9]{20,}/u },
  { name: 'Anthropic 风格 Key', re: /sk-ant-[A-Za-z0-9_-]{20,}/u },
  { name: 'Google 风格 Key', re: /AIza[0-9A-Za-z_-]{35}/u },
  { name: 'Bearer 长令牌', re: /Bearer\s+[A-Za-z0-9._-]{40,}/u },
];

/**
 * Paths that must never be tracked. `node_modules` and `.next` are build inputs
 * restored from the lock file (T083-R05); the rest is user data or secrets.
 *
 * `test-results`/`playwright-report` matter because a Playwright trace archives
 * submitted request bodies — the T078 evidence recorded that a real key typed
 * into a form lands there. They are gitignored today; this makes the claim
 * checked rather than assumed.
 */
const FORBIDDEN_TRACKED = [
  { label: '真实数据目录 .data', test: (p) => p === '.data' || p.startsWith('.data/') || p.includes('/.data/') },
  { label: 'SQLite 数据库文件', test: (p) => /\.(db|sqlite|sqlite3|db-wal|db-shm)$/u.test(p) },
  { label: '环境变量文件', test: (p) => p === '.env' || p.startsWith('.env') || p.includes('/.env') },
  { label: '依赖目录 node_modules', test: (p) => p.startsWith('node_modules/') || p.includes('/node_modules/') },
  { label: '构建产物 .next', test: (p) => p.startsWith('.next/') || p.includes('/.next/') },
  { label: '浏览器测试产物', test: (p) => /(^|\/)(test-results|playwright-report)\//u.test(p) },
];

/** T083-R05: does one tracked path belong on the forbidden list? */
export function forbiddenTrackedReason(relativePath) {
  const normalized = relativePath.replace(/\\/gu, '/');
  for (const { label, test } of FORBIDDEN_TRACKED) {
    if (test(normalized)) return label;
  }
  return null;
}

/** Find every secret-shaped literal in a text blob, with the line number. */
export function findSecrets(text) {
  const hits = [];
  const lines = text.split('\n');
  for (const { name, re } of SECRET_PATTERNS) {
    // `matchAll` with a fresh lastIndex per line: the patterns are global-free,
    // so one `exec` per line is enough and cannot leak state between files.
    for (let index = 0; index < lines.length; index += 1) {
      const match = re.exec(lines[index]);
      if (match) {
        hits.push({ name, line: index + 1, sample: `${match[0].slice(0, 8)}…（长度 ${match[0].length}）` });
      }
    }
  }
  return hits;
}

/** Most evidence entries are `path` or `path#anchor`; the file is what must exist. */
export function evidencePath(entry) {
  return entry.split('#')[0];
}

/** The anchor part of an evidence entry, or null when there is none. */
export function evidenceAnchor(entry) {
  const index = entry.indexOf('#');
  return index === -1 ? null : entry.slice(index + 1);
}

/**
 * GitHub's heading anchor: lowercase, punctuation dropped, whitespace becomes a
 * hyphen. CJK is kept (it is a letter), so `## 5. T007 本地请求令牌` becomes
 * `5-t007-本地请求令牌`.
 *
 * Reimplementing this is the point: an anchor that merely *looks* precise can
 * point nowhere, and a reader who follows it lands at the top of the file and
 * concludes the evidence is thin.
 */
export function slugifyHeading(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .trim()
    .replace(/\s+/gu, '-');
}

/** Every anchor a markdown file actually offers: explicit `<a id>` plus headings. */
export function anchorsIn(markdown) {
  const anchors = new Set();
  for (const match of markdown.matchAll(/<a\s+id="([^"]+)"/gu)) anchors.add(match[1].toLowerCase());
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gmu)) {
    anchors.add(slugifyHeading(match[1]));
  }
  return anchors;
}

/**
 * T083-C05: can a reader navigate from this evidence entry to the thing it names?
 *
 * Markdown targets are matched against the file's real anchor set. Other files
 * (a spec file named as evidence, e.g. `gate4.spec.ts#T061-C02`) have no anchor
 * model, so the marker is matched as a case-insensitive substring — which is the
 * only sense in which a `.ts` file "contains" T061-C02.
 */
export function resolveEvidenceAnchor(root, entry) {
  const anchor = evidenceAnchor(entry);
  if (anchor === null) return null;
  const relative = evidencePath(entry);
  const text = readFileSync(path.join(root, relative), 'utf8');
  if (/\.md$/iu.test(relative)) {
    return anchorsIn(text).has(anchor.toLowerCase()) ? null : `锚点 ${anchor} 在 ${relative} 里找不到`;
  }
  return text.toLowerCase().includes(anchor.toLowerCase())
    ? null
    : `锚点 ${anchor} 在 ${relative} 里找不到`;
}


/**
 * T083-R01/R02: validate the task state file against its own claims.
 *
 * Returns failures (not throws) so the caller can report all of them at once —
 * fixing one dangling path and re-running to find the next is what makes a check
 * like this stop being run.
 */
export function inspectStatus(current, contract, root) {
  const failures = [];
  const tasks = current.tasks ?? current;
  const counts = Object.fromEntries(ALLOWED_STATUSES.map((status) => [status, 0]));

  const contractIds = (contract.tasks ?? contract).map((task) => task.id);
  const currentIds = tasks.map((task) => task.id);
  for (const id of contractIds) {
    if (!currentIds.includes(id)) failures.push(`${id}: 状态文件中缺失（契约共 ${contractIds.length} 个任务）`);
  }
  for (const id of currentIds) {
    if (!contractIds.includes(id)) failures.push(`${id}: 不在 reference/contracts/tasks.json 中`);
  }

  let evidenceEntries = 0;
  let anchorEntries = 0;
  let verifiedWithoutRecord = 0;

  for (const task of tasks) {
    if (!ALLOWED_STATUSES.includes(task.status)) {
      failures.push(
        `${task.id}: 状态 ${JSON.stringify(task.status)} 不在词表 [${ALLOWED_STATUSES.join(', ')}] 内（T083-R01）`,
      );
      continue;
    }
    counts[task.status] += 1;

    const evidence = task.evidence ?? [];
    if (task.status === 'verified' && evidence.length === 0) {
      failures.push(`${task.id}: 标为 verified 但 evidence 为空（T083-C01：代码存在不等于行为正确）`);
      continue;
    }

    let hasRecord = false;
    for (const entry of evidence) {
      evidenceEntries += 1;
      if (entry.includes('#')) anchorEntries += 1;
      const relative = evidencePath(entry);
      const absolute = path.join(root, relative);
      if (!existsSync(absolute)) {
        failures.push(`${task.id}: 证据路径不存在 -> ${relative}`);
        continue;
      }
      const anchorProblem = resolveEvidenceAnchor(root, entry);
      if (anchorProblem) failures.push(`${task.id}: ${anchorProblem}（T083-C05：锚点必须可定位）`);
      if (RESULT_RECORD_PREFIXES.some((prefix) => relative.startsWith(prefix))) hasRecord = true;
    }

    if (task.status === 'verified' && !hasRecord) {
      verifiedWithoutRecord += 1;
      failures.push(
        `${task.id}: evidence 里没有结果记录（需指向 ${RESULT_RECORD_PREFIXES.join(' 或 ')}），只有实现/测试文件不足以标 verified`,
      );
    }

    if (task.status === 'blocked' && (task.blockedBy ?? []).length === 0 && !task.evidence?.length) {
      failures.push(`${task.id}: blocked 但既没有 blockedBy 也没有证据说明原因`);
    }
  }

  return {
    failures,
    counts,
    tasks: tasks.length,
    contractTasks: contractIds.length,
    evidenceEntries,
    anchorEntries,
    verifiedWithoutRecord,
  };
}

/** T083-C04/R05: scan a list of tracked files for secrets and forbidden paths. */
export function inspectDelivery(root, files) {
  const failures = [];
  const hits = [];
  let scanned = 0;
  let bytes = 0;

  for (const relative of files) {
    const reason = forbiddenTrackedReason(relative);
    if (reason) failures.push(`交付目录含${reason} -> ${relative}`);

    const absolute = path.join(root, relative);
    if (!existsSync(absolute)) continue;
    const stat = statSync(absolute);
    // The lock file is machine-generated and checked separately; reading it as
    // text only to match nothing slows the check without covering anything.
    if (!stat.isFile() || stat.size > 2_000_000) continue;
    scanned += 1;
    bytes += stat.size;
    for (const hit of findSecrets(readFileSync(absolute, 'utf8'))) {
      hits.push(`${relative}:${hit.line}（${hit.name} ${hit.sample}）`);
    }
  }

  for (const hit of hits) failures.push(`交付目录含疑似真实密钥 -> ${hit}`);

  return { failures, hits, files: files.length, scanned, bytes };
}

function parseArgs(argv) {
  const options = { root: process.cwd(), delivery: false, list: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--delivery') options.delivery = true;
    else if (arg === '--root') options.root = path.resolve(argv[(index += 1)]);
    else if (arg === '--list') options.list = argv[(index += 1)];
    else return { error: `未知参数 ${arg}` };
  }
  return options;
}

function trackedFiles(root) {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ls-files 失败（exit ${result.status}）：${(result.stderr ?? '').trim()}`);
  }
  return result.stdout.split('\0').filter((entry) => entry.length > 0);
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.error) {
    console.error(options.error);
    console.error('用法：node scripts/check-delivery.mjs [--delivery] [--root <dir>] [--list <file>]');
    return EXIT.usage;
  }

  const root = options.root;
  const status = inspectStatus(
    JSON.parse(readFileSync(path.join(root, 'implementation/progress/tasks.current.json'), 'utf8')),
    JSON.parse(readFileSync(path.join(root, 'reference/contracts/tasks.json'), 'utf8')),
    root,
  );

  let delivery = null;
  if (options.delivery) {
    const files = options.list
      ? readFileSync(options.list, 'utf8')
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0)
      : trackedFiles(root);
    delivery = inspectDelivery(root, files);
  }

  const failures = [...status.failures, ...(delivery?.failures ?? [])];

  console.log(
    JSON.stringify(
      {
        ok: failures.length === 0,
        // Reported as counts, never as a single "passed" number: T083-C02 exists
        // because an average hides a key case that failed.
        status: {
          counts: status.counts,
          tasks: status.tasks,
          contractTasks: status.contractTasks,
          evidenceEntries: status.evidenceEntries,
          anchorEntries: status.anchorEntries,
          verifiedWithoutRecord: status.verifiedWithoutRecord,
        },
        delivery,
        failures,
      },
      null,
      2,
    ),
  );

  return failures.length === 0 ? EXIT.ok : EXIT.failures;
}

/**
 * Only run when invoked as a program. The exported functions are what the tests
 * drive; `import.meta.main` does not exist on Node 24, so the path comparison is
 * the portable form.
 */
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
