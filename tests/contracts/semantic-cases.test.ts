/**
 * T042 验收：语义样本清单的结构层断言（离线）。
 *
 * 用例规格：docs/05_tests/G2/T042_cases.md，任务规格：docs/04_tasks/G2/T042_ai_acceptance.md。
 * 审计结论是「契约点名的 `tests/e2e/gate2.spec.ts` 与 `tests/fixtures/semantic-cases.json`
 * 都不存在」，真实 Provider 连通性属 `BLOCKED_BY_EXTERNAL_CREDENTIAL`。
 *
 * 本文件只做一件事：把语义样本清单本身当成数据来校验 —— 六类样本齐不齐、每条是否
 * 真的有材料、占位符是否成对、限制条件是否指向真实关系类型。它**不**声称任何模型
 * 对这些样本给出过正确输出；真实语义验收仍然阻塞在用户自己的 Key。
 *
 * 之所以值得写：一个字段错位的 fixture 会让将来那次真实跑批得出假结论（比如
 * 「不得相连」写成空数组就永远通过），而这类错误恰恰是离线能抓住的。
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { RELATION_TYPES } from '@/domain/knowledge';

const fixturePath = path.resolve(import.meta.dirname, '../../tests/fixtures/semantic-cases.json');
const raw = readFileSync(fixturePath, 'utf8');
const fixture = JSON.parse(raw) as {
  $status: { structural: string; liveProvider: string; note: string };
  $rules: Record<string, string>;
  cases: {
    id: string;
    title: string;
    purpose: string;
    materials: Record<string, string>;
    expect: {
      allowRelationTypes: string[];
      mustNotRelateTo: string[];
      summaryMustNotIntroduce: string[];
      evidenceMustReference: string[];
      manualFieldsMustSurvive?: string[];
    };
    manualCheck: string[];
    offlineAssertions?: string[];
  }[];
  coverage: Record<string, { materials: Record<string, string> }>;
  promptInjection: {
    cases: {
      id: string;
      materials: Record<string, string>;
      expect: { summaryMustNotIntroduce: string[]; mustNotRelateTo: string[] };
    }[];
  };
};

describe('T042-C04 真实 Key 缺失时的诚实标注', () => {
  it('T042-C04 fixture 明确写着自己只是结构层，真实连接未执行', () => {
    // 谁要是把这份 fixture 当成「语义已通过」，这条断言就是反驳他的依据。
    expect(fixture.$status.structural).toBe('verified-offline');
    expect(fixture.$status.liveProvider).toBe('blocked-external-credential');
    expect(fixture.$status.note).toContain('未执行');
  });

  it('T042-C04 文件里不含任何真实 Key 形状的字符串（R04）', () => {
    // 夹具写入真实秘密是最难事后清理的事故，所以在离线阶段就拦住。
    expect(raw).not.toMatch(/\bsk-[A-Za-z0-9]{16,}/u);
    expect(raw).not.toMatch(/(?:api[_-]?key|authorization)\s*[:=]\s*["']?[A-Za-z0-9]{16,}/iu);
    expect(raw).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{16,}/u);
  });

  it('T042-C04 六条用例与用例规格文档的 C 编号一一对应', () => {
    expect(fixture.cases.map((entry) => entry.id)).toEqual([
      'T042-C01',
      'T042-C02',
      'T042-C03',
      'T042-C04',
      'T042-C05',
      'T042-C06',
    ]);
    for (const entry of fixture.cases) {
      expect(entry.title.trim().length, entry.id).toBeGreaterThan(0);
      expect(entry.purpose.trim().length, entry.id).toBeGreaterThan(0);
    }
  });
});

describe('T042-R02 六类真实语义样本齐备', () => {
  it('T042-R02 单词、带限定词的观点、转述、无关、相反主张、提示注入都被覆盖', () => {
    for (const key of ['singleWord', 'qualifiedOpinion', 'paraphrase', 'unrelated', 'contradicts', 'promptInjection']) {
      expect(fixture.coverage, `缺少样本类别 ${key}`).toHaveProperty(key);
    }
  });

  it('T042-R02 每类样本都真的有材料，不是空壳占位', () => {
    for (const [key, entry] of Object.entries(fixture.coverage)) {
      if (key.startsWith('$')) continue;
      const values = Object.values(entry.materials ?? {});
      expect(values.length, `${key} 没有材料`).toBeGreaterThan(0);
      for (const text of values) {
        expect(text.trim().length, `${key} 的材料是空的`).toBeGreaterThan(0);
      }
    }
  });

  it('T042-C01/C03 相关与矛盾两类样本各自带「允许什么关系」的判定条件', () => {
    const related = fixture.cases.find((entry) => entry.id === 'T042-C01');
    const contradicts = fixture.cases.find((entry) => entry.id === 'T042-C03');

    expect(related?.materials).toHaveProperty('$A');
    expect(related?.materials).toHaveProperty('$B');
    // R03：不以边数量计分，所以「允许不连」也必须写进判定条件里。
    expect(related?.purpose).toContain('保守');

    expect(contradicts?.expect.allowRelationTypes).toContain('contradicts');
    expect(contradicts?.expect.summaryMustNotIntroduce.length).toBeGreaterThan(0);
  });

  it('T042-C02 无关材料必须显式写出「不得相连」，空数组不算判定', () => {
    const unrelated = fixture.cases.find((entry) => entry.id === 'T042-C02');

    // 这是最容易写错、也最容易让将来跑批得出假结论的一格。
    expect(unrelated?.expect.allowRelationTypes).toEqual([]);
    expect(unrelated?.expect.mustNotRelateTo).toEqual(['$A', '$B']);
    expect(unrelated?.expect.summaryMustNotIntroduce.length).toBeGreaterThan(0);
  });
});

describe('T042 fixture 的结构完整性', () => {
  it('T042 fixture 里出现的关系类型都是领域里真实存在的枚举', () => {
    for (const entry of fixture.cases) {
      for (const type of entry.expect.allowRelationTypes) {
        expect(RELATION_TYPES, `${entry.id} 用了不存在的关系类型 ${type}`).toContain(type);
      }
    }
  });

  it('T042 每条用例的允许与禁止关系不重叠，否则判定自相矛盾', () => {
    for (const entry of fixture.cases) {
      const overlap = entry.expect.allowRelationTypes.filter((type) =>
        entry.expect.mustNotRelateTo.includes(type),
      );
      expect(overlap, entry.id).toEqual([]);
    }
  });

  it('T042 所有材料占位符都是 $A/$B 形式，运行时可被真实 UUID 替换', () => {
    const placeholders = new Set<string>();
    for (const entry of fixture.cases) {
      for (const key of Object.keys(entry.materials)) placeholders.add(key);
      for (const key of entry.expect.mustNotRelateTo) placeholders.add(key);
      for (const key of entry.expect.evidenceMustReference) placeholders.add(key);
    }
    for (const key of placeholders) {
      expect(key, `占位符 ${key} 不符合 $A 形式`).toMatch(/^\$[A-Z]+$/u);
    }
    // 夹具本身不带 UUID：样本不该与某次真实数据绑定。
    for (const entry of fixture.cases) {
      for (const text of Object.values(entry.materials)) {
        expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u);
      }
    }
  });

  it('T042-C05 人工保护用例指明了要守住的人工字段', () => {
    const manual = fixture.cases.find((entry) => entry.id === 'T042-C05');
    expect(manual?.expect.manualFieldsMustSurvive).toContain('summary');
    expect(manual?.manualCheck.length).toBeGreaterThan(0);
  });

  it('T042-C06 中断恢复用例有可人工确认的恢复判据', () => {
    const recovery = fixture.cases.find((entry) => entry.id === 'T042-C06');
    expect(recovery?.manualCheck.length).toBeGreaterThan(0);
    expect(recovery?.manualCheck.join(' ')).toContain('中断');
  });

  it('T042-INJ 提示注入样本要求摘要不得复述系统提示或泄露密钥形状', () => {
    expect(fixture.promptInjection.cases.length).toBeGreaterThanOrEqual(2);
    const joined = fixture.promptInjection.cases
      .flatMap((entry) => entry.expect.summaryMustNotIntroduce)
      .join(' ');
    expect(joined).toContain('system prompt');
    expect(joined).toContain('sk-');
  });

  it('T042-R03 fixture 的判定条件是保真与克制，没有「至少几条边」这类指标', () => {
    const text = raw;
    // 「产生多少边」不能出现在判定条件里。
    expect(text).not.toMatch(/minRelations|atLeast\w*Edges|最少\s*边|边数\s*至少/u);
    expect(fixture.$rules.R03).toContain('不以产生多少条边为成功指标');
  });
});
