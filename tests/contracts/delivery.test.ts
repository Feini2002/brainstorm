// T083 交付状态与证据完整性（T083-C01…C06）。
//
// 这些用例驱动 `scripts/check-delivery.mjs` 导出**函数**，而不是只断言脚本能退出 0：
// T083-C01 的核心是「证据不存在时必须报错」，所以要在临时副本里制造悬空路径再观察结果。
//
// 关于秘密样本：本文件里没有、也不会有任何像真实密钥的字节。C04 的注入用的是
// 运行时拼接（`'sk-' + 'A'.repeat(32)`），保证仓库全文扫描永远命中不了这一条——
// 否则守卫会在自己唯一的负向用例上失败，那种"武器化的假 Key"正是要避免的形态。
import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  ALLOWED_STATUSES,
  RESULT_RECORD_PREFIXES,
  evidencePath,
  findSecrets,
  forbiddenTrackedReason,
  inspectDelivery,
  inspectStatus,
  resolveEvidenceAnchor,
} from '../../scripts/check-delivery.mjs';

const projectRoot = path.resolve(import.meta.dirname, '../..');

const temporaries: string[] = [];

function scratch(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'feini-delivery-'));
  temporaries.push(directory);
  mkdirSync(path.join(directory, 'implementation/progress/evidence'), { recursive: true });
  mkdirSync(path.join(directory, 'docs/progress'), { recursive: true });
  mkdirSync(path.join(directory, 'tests/unit'), { recursive: true });
  return directory;
}

function write(directory: string, relative: string, contents = 'x\n'): void {
  writeFileSync(path.join(directory, relative), contents, 'utf8');
}

/** 造一份最小可用的「状态文件 + 契约」对，便于逐项改坏。 */
function statusFixture(directory: string, task: Record<string, unknown>, contractIds = ['T001']) {
  const contract = { tasks: contractIds.map((id) => ({ id })) };
  return { tasks: [{ id: 'T001', status: 'verified', evidence: [], blockedBy: [], ...task }], contract };
}

function cleanup(): void {
  for (const directory of temporaries) rmSync(directory, { recursive: true, force: true });
  temporaries.length = 0;
}

afterAll(cleanup);

describe('T083 交付守卫', () => {
  it('T083-R01 词表只允许四种状态，且与 tasks.current.json 的实际取值一致', async () => {
    expect(ALLOWED_STATUSES).toEqual(['not_started', 'in_progress', 'blocked', 'verified']);

    const { readFileSync } = await import('node:fs');
    const current = JSON.parse(
      readFileSync(path.join(projectRoot, 'implementation/progress/tasks.current.json'), 'utf8'),
    ) as { tasks: { id: string; status: string }[] };
    const seen = [...new Set(current.tasks.map((task) => task.status))].sort();
    // `implemented` 是 G0 起用过的第五个词，G-2 拍板后不再产生；这里钉住它不再回来。
    expect(seen).toEqual(['blocked', 'not_started', 'verified']);
    for (const status of seen) expect(ALLOWED_STATUSES).toContain(status);
  });

  it('T083-C01 证据路径不存在时必须报错，不能凭代码存在就标 verified', () => {
    const directory = scratch();
    write(directory, 'implementation/progress/evidence/G1.md');
    const { tasks, contract } = statusFixture(directory, {
      evidence: ['implementation/progress/evidence/G1.md', 'tests/unit/ghost.test.ts'],
    });

    const report = inspectStatus({ tasks }, contract, directory);
    expect(report.failures.join('\n')).toContain('tests/unit/ghost.test.ts');
    expect(report.failures.join('\n')).toContain('证据路径不存在');

    // 反向样本：把悬空那条换成真实存在的文件后，同一份输入必须转为通过。
    // 少了这一半，上面的断言可能只是"任何输入都报错"。
    write(directory, 'tests/unit/ghost.test.ts');
    const fixed = inspectStatus({ tasks }, contract, directory);
    expect(fixed.failures).toEqual([]);
  });

  it('T083-C01 只有实现与测试文件、没有结果记录时，verified 不成立', () => {
    const directory = scratch();
    write(directory, 'tests/unit/only-tests.test.ts');
    const { tasks, contract } = statusFixture(directory, {
      evidence: ['tests/unit/only-tests.test.ts'],
    });

    const report = inspectStatus({ tasks }, contract, directory);
    expect(report.verifiedWithoutRecord).toBe(1);
    expect(report.failures.join('\n')).toContain('没有结果记录');
    expect(RESULT_RECORD_PREFIXES).toContain('implementation/progress/evidence/');

    // 补一条证据文件即通过——证明这条规则认的是"结果记录"，不是文件数量。
    write(directory, 'implementation/progress/evidence/G1.md');
    const fixed = inspectStatus(
      { tasks: tasks.map((task) => ({ ...task, evidence: [...task.evidence, 'implementation/progress/evidence/G1.md'] })) },
      contract,
      directory,
    );
    expect(fixed.failures).toEqual([]);
  });

  it('T083-C01 状态文件缺任务、多任务、或用词表外的状态都会被拦下', () => {
    const directory = scratch();
    write(directory, 'implementation/progress/evidence/G1.md');

    const missing = inspectStatus(
      { tasks: [] },
      { tasks: [{ id: 'T001' }, { id: 'T002' }] },
      directory,
    );
    expect(missing.failures.join('\n')).toContain('T001: 状态文件中缺失');
    expect(missing.failures.join('\n')).toContain('T002: 状态文件中缺失');

    const extra = inspectStatus(
      { tasks: [{ id: 'T999', status: 'verified', evidence: ['implementation/progress/evidence/G1.md'] }] },
      { tasks: [{ id: 'T001' }] },
      directory,
    );
    expect(extra.failures.join('\n')).toContain('T999: 不在 reference/contracts/tasks.json 中');

    // 这是 G-2 拍板要防的那个词：它曾经是合法的第五种状态。
    const legacy = inspectStatus(
      { tasks: [{ id: 'T001', status: 'implemented', evidence: ['implementation/progress/evidence/G1.md'] }] },
      { tasks: [{ id: 'T001' }] },
      directory,
    );
    expect(legacy.failures.join('\n')).toContain('implemented');
    expect(legacy.failures.join('\n')).toContain('不在词表');
  });

  it('T083-C02 计数逐状态分别报出，不把未完成的任务折进"通过率"', () => {
    const directory = scratch();
    write(directory, 'implementation/progress/evidence/G1.md');
    const tasks = [
      { id: 'T001', status: 'verified', evidence: ['implementation/progress/evidence/G1.md'], blockedBy: [] },
      { id: 'T002', status: 'blocked', evidence: ['implementation/progress/evidence/G1.md'], blockedBy: [] },
      { id: 'T003', status: 'not_started', evidence: [], blockedBy: [] },
      { id: 'T004', status: 'in_progress', evidence: [], blockedBy: [] },
    ];
    const report = inspectStatus({ tasks }, { tasks: tasks.map(({ id }) => ({ id })) }, directory);

    expect(report.failures).toEqual([]);
    // 四个计数都在，且相加等于任务总数——没有被平均掉的那一项。
    expect(report.counts).toEqual({ not_started: 1, in_progress: 1, blocked: 0 + 1, verified: 1 });
    expect(Object.values(report.counts).reduce((sum, n) => sum + n, 0)).toBe(4);
  });

  it('T083-C03 blocked 必须带原因，否则只是一句无法执行的结论', () => {
    const directory = scratch();
    const blockedWithoutReason = inspectStatus(
      { tasks: [{ id: 'T001', status: 'blocked', evidence: [], blockedBy: [] }] },
      { tasks: [{ id: 'T001' }] },
      directory,
    );
    expect(blockedWithoutReason.failures.join('\n')).toContain('blocked 但既没有 blockedBy 也没有证据');

    // 现实里的 T042 走的是"有证据文件说明原因"这条路，同一份检查必须接受它。
    write(directory, 'implementation/progress/evidence/G2.md');
    const blockedWithReason = inspectStatus(
      { tasks: [{ id: 'T001', status: 'blocked', evidence: ['implementation/progress/evidence/G2.md'], blockedBy: [] }] },
      { tasks: [{ id: 'T001' }] },
      directory,
    );
    expect(blockedWithReason.failures).toEqual([]);
  });

  it('T083-C04 交付目录里的真实密钥会被拦下，且占位用 Key 不会被误报', () => {
    const directory = scratch();
    // 运行时拼接：本文件被全文扫描时也命中不了这条模式。
    const injected = ['sk', 'A'.repeat(40)].join('-');
    write(directory, 'implementation/progress/notes.md', `api_key = ${injected}\n`);

    const hit = inspectDelivery(directory, ['implementation/progress/notes.md']);
    expect(hit.hits).toHaveLength(1);
    expect(hit.failures.join('\n')).toContain('疑似真实密钥');
    // 只报长度与来源，不把密钥本身回显进报告——检查的输出也会被贴进交付材料。
    expect(hit.failures.join('\n')).not.toContain(injected);

    // 反向样本：测试夹具用的假 Key 必须干净，否则这条规则每天都会被触发。
    // 长度门槛就是这个用途：`sk-test-…` 这类占位符永远短于阈值。
    write(directory, 'tests/unit/fixture.test.ts', "const key = 'sk-test-DELIVERY083-placeholder';\n");
    const clean = inspectDelivery(directory, ['tests/unit/fixture.test.ts']);
    expect(clean.hits).toEqual([]);
    expect(clean.failures).toEqual([]);
  });

  it('T083-C05 失败项带得出负责模块：路径就是路由，锚点可定位', () => {
    const directory = scratch();
    write(directory, 'implementation/progress/evidence/G6.md', '## T082-1. 中文文案\n');
    const { tasks, contract } = statusFixture(directory, {
      evidence: ['implementation/progress/evidence/G6.md#T082-1', 'tests/unit/ghost.test.ts'],
    });

    const report = inspectStatus({ tasks }, contract, directory);
    // 报错文本必须含**完整相对路径**，否则读报告的人还要自己猜文件在哪。
    expect(report.failures.join('\n')).toContain('tests/unit/ghost.test.ts');
    expect(report.anchorEntries).toBe(1);
    // 带锚点的条目校验的是锚点前的文件部分。
    expect(evidencePath('implementation/progress/evidence/G6.md#T082-1')).toBe(
      'implementation/progress/evidence/G6.md',
    );

    // 锚点可定位性实测：逐条核对状态文件里**每一个**带锚点的条目，
    // 其锚点真的能定位到目标文件里的某个标题或 `<a id>`。少了这一步，
    // `#somewhere` 这种拼错的锚点会让证据看着很具体、却指不到任何地方
    // （G0.md 里那条 T007 锚点就是这么断的：标题里的空格没转成连字符）。
    const current = JSON.parse(
      readFileSync(path.join(projectRoot, 'implementation/progress/tasks.current.json'), 'utf8'),
    ) as { tasks: { id: string; evidence: string[] }[] };
    const anchors = current.tasks.flatMap((task) =>
      task.evidence.filter((entry) => entry.includes('#')).map((entry) => ({ task: task.id, entry })),
    );
    expect(anchors.length).toBeGreaterThan(0);

    const unresolved: string[] = [];
    for (const { task, entry } of anchors) {
      const problem = resolveEvidenceAnchor(projectRoot, entry);
      if (problem) unresolved.push(`${task} -> ${entry}（${problem}）`);
    }
    expect(unresolved, `这些锚点定位不到：\n${unresolved.join('\n')}`).toEqual([]);

    // 拼错的锚点必须真的进入 `inspectStatus` 的失败列表，而不只是被那个纯函数
    // 拒绝一次。少了这一半，接线断掉（比如忘了把 anchorProblem 计进 failures）
    // 时用例仍然全绿。
    const bogus = inspectStatus(
      {
        tasks: [
          {
            id: 'T001',
            status: 'verified',
            evidence: ['implementation/progress/evidence/G6.md#不存在的锚点'],
            blockedBy: [],
          },
        ],
      },
      { tasks: [{ id: 'T001' }] },
      directory,
    );
    expect(bogus.failures.join('\n')).toContain('T083-C05');
    expect(bogus.failures.join('\n')).toContain('找不到');

    // 反向样本：把锚点改坏一个字，同一份检查必须报出来——否则上面的"全绿"
    // 可能只是 slugify 恰好宽到匹配任何东西。
    expect(resolveEvidenceAnchor(projectRoot, 'implementation/progress/evidence/G0.md#不存在的锚点')).toContain(
      '找不到',
    );
  });

  it('T083-C06 硬性不变量由守卫兜住：真实数据目录与浏览器产物不得进入交付', () => {
    // 这四类路径对应 R05/R06 里"交付目录不含真实 .data"的那条硬性不变量。
    expect(forbiddenTrackedReason('.data/brain.db')).toBe('真实数据目录 .data');
    expect(forbiddenTrackedReason('tests/e2e/.data/brain.db')).toBe('真实数据目录 .data');
    expect(forbiddenTrackedReason('.env.local')).toBe('环境变量文件');
    expect(forbiddenTrackedReason('node_modules/next/package.json')).toBe('依赖目录 node_modules');
    expect(forbiddenTrackedReason('.next/BUILD_ID')).toBe('构建产物 .next');
    // T078 记录过的真实风险：Playwright trace 会归档已提交的请求体。
    expect(forbiddenTrackedReason('test-results/abc/trace.zip')).toBe('浏览器测试产物');
    expect(forbiddenTrackedReason('playwright-report/index.html')).toBe('浏览器测试产物');
    expect(forbiddenTrackedReason('src/domain/view.ts')).toBeNull();

    // 端到端：注入一个路径，同一份检查必须拦下它。
    const directory = scratch();
    const report = inspectDelivery(directory, ['tests/e2e/.data/brain.db']);
    expect(report.failures.join('\n')).toContain('真实数据目录 .data');

    // 且当前仓库真的干净——不是"规则存在但没人跑"。
    const clean = inspectDelivery(projectRoot, [
      'src/domain/view.ts',
      'README.md',
      'package-lock.json',
    ]);
    expect(clean.failures).toEqual([]);
    expect(findSecrets('普通文本，没有密钥')).toEqual([]);
  });
});

describe('T083 守卫在真实仓库上的终态', () => {
  it('当前仓库通过全部检查（含交付扫描）', () => {
    const result = spawnSync(
      process.execPath,
      [path.join(projectRoot, 'scripts/check-delivery.mjs'), '--delivery'],
      { cwd: projectRoot, encoding: 'utf8' },
    );
    const report = JSON.parse(result.stdout) as {
      ok: boolean;
      failures: string[];
      status: { counts: Record<string, number> };
      delivery: { files: number; scanned: number };
    };
    expect(report.failures, report.failures.join('\n')).toEqual([]);
    expect(report.ok).toBe(true);
    expect(result.status).toBe(0);
    // 交付扫描必须真的扫过整个跟踪树，而不是空转。
    expect(report.delivery.files).toBeGreaterThan(500);
    expect(report.status.counts.verified).toBeGreaterThan(0);
  });
});
