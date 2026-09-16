/**
 * T079-C06: the report's measurement metadata.
 *
 * C06's exclusion is "a speed number detached from its environment cannot be
 * reused", so the case has to fail when a number arrives without the facts that
 * make it comparable. The report is written by hand from a run's output, which is
 * exactly where a number can lose its environment — so the check is mechanical:
 * parse `docs/performance-report.md` and refuse the parts that cannot stand alone.
 *
 * This is the one T079 case with no server: it checks the artefact rather than the
 * app, and running it does not need a seeded database.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

import { environmentFacts } from './support/perfEnv';

const reportPath = path.join(process.cwd(), 'docs', 'performance-report.md');

/** Facts that must be present for a number to be reproducible elsewhere. */
const REQUIRED_FACTS = [
  { label: '操作系统', pattern: /平台：|OS[:：]/u },
  { label: 'CPU', pattern: /CPU[:：]/u },
  { label: '内存', pattern: /内存[:：]/u },
  { label: 'Node 版本', pattern: /Node[:：]\s*v?\d/u },
  { label: '浏览器版本', pattern: /Chromium[:：]\s*\d/u },
  { label: '构建类型（生产/开发分开）', pattern: /生产构建/u },
  { label: '数据规模', pattern: /规模[:：]|条目 \d+/u },
];

test.describe('T079 环境说明', () => {
  test('T079-C06 性能报告包含机器、浏览器、构建与规模元信息', async ({ page }) => {
    const text = readFileSync(reportPath, 'utf8');

    for (const fact of REQUIRED_FACTS) {
      expect(text, `性能报告必须写明${fact.label}`).toMatch(fact.pattern);
    }

    /*
     * Every asserted number must sit next to its environment, and the strongest
     * mechanical form of that is: the report states the environment block *before*
     * the first measurement table. A report that measures first and explains later
     * is the case C06 calls unreusable.
     */
    const environmentAt = text.search(/##.*测量环境|##.*环境/u);
    const firstTableAt = text.search(/^\|.*中位数.*\|/mu);
    expect(environmentAt, '报告应有明确的测量环境小节').toBeGreaterThanOrEqual(0);
    expect(firstTableAt, '报告应有测量表格').toBeGreaterThanOrEqual(0);
    expect(
      environmentAt,
      '测量环境必须写在第一张测量表之前，否则数字与环境的先后关系无法核对',
    ).toBeLessThan(firstTableAt);

    /*
     * R02's split must be visible as separate columns/rows rather than one blended
     * figure: cold start, warm requests and model network time are different costs.
     */
    expect(text, '报告必须把冷启动单独列出').toMatch(/冷启动/u);
    expect(text, '报告必须说明真实模型网络耗时未测').toMatch(/真实模型|模型网络|未测/u);
    expect(text, '报告必须把开发模式单独说明').toMatch(/开发模式|HMR/u);

    /*
     * R05: the budget is a *target*, not a measured fact, and a report that blurs
     * the two makes an unmet target look like a pass.
     */
    expect(text, '报告必须区分预算（目标）与实测').toMatch(/预算/u);

    // And the report must not claim an unrun case as done.
    expect(text, '报告必须如实列出未执行项').toMatch(/未执行|未覆盖/u);

    // The reader's tool: the exact commands this file's numbers came from.
    expect(text, '报告必须给出可复现命令').toMatch(/seed-benchmark\.mjs/u);
    expect(text, '报告必须给出可复现命令').toMatch(/test:perf/u);

    const facts = await environmentFacts(page);
    console.log(
      [
        '',
        '===== T079-C06 环境说明 =====',
        `报告：${reportPath}`,
        '本次运行环境（与报告中的块比对）：',
        `平台：${facts.platform}（${facts.osRelease}）`,
        `CPU：${facts.cpuModel} × ${facts.cpuCount}`,
        `内存：${facts.totalMemoryGiB} GiB`,
        `Node：${facts.nodeVersion}`,
        `Chromium：${facts.browserVersion}`,
        `构建：${facts.buildType}`,
        '',
      ].join('\n'),
    );
  });
});
