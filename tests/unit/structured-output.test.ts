/**
 * T037 验收用例｜结构化解析、限长与一次修复
 *
 * 断言的是解析器的**边界行为**：只剥一层完整围栏、从不执行模型文本、散文包裹
 * 被拒绝、截断先于解析失败、修复不追加新材料。这些都不依赖真实模型。
 */
import { describe, expect, it } from 'vitest';

import { LIMITS } from '@/domain/limits';
import { ORGANIZE_PROMPT_VERSION } from '@/domain/view';
import {
  buildRepairMessages,
  parseStructured,
  applyBusinessValidation,
} from '@/server/llm/parseStructured';
import { stripCodeFence } from '@/server/llm/protocol';
import { buildOrganizeMessages } from '@/server/llm/prompts/organize';
import { PROMPT_VERSIONS } from '@/server/llm/prompts/shared';

const TARGET = '11111111-1111-4111-8111-111111111111';
const CANDIDATE = '22222222-2222-4222-8222-222222222222';

function validOutput(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    title: '幂等',
    summary: '一件事重复执行与执行一次结果相同。',
    type: 'concept',
    tags: ['幂等'],
    keywords: ['幂等'],
    importance: 3,
    relations: [],
    ...overrides,
  });
}

function parse(content: string, candidateIds: string[] = []) {
  return parseStructured({ content, context: { targetId: TARGET, candidateIds } });
}

describe('T037 结构化解析', () => {
  it('T037-C01 只剥一层包裹全文的 json 围栏', () => {
    const fenced = ['```json', validOutput(), '```'].join('\n');
    const outcome = parse(fenced);
    expect(outcome.ok).toBe(true);
    expect(outcome.value?.title).toBe('幂等');

    // 只应剥一层：两层围栏剥完仍不是合法 JSON。
    const doubleFenced = ['```json', '```json', validOutput(), '```', '```'].join('\n');
    expect(stripCodeFence(doubleFenced)).toContain('```json');
  });

  it('T037-C02 散文包裹多个 JSON 片段时不猜，直接失败并可修复', () => {
    const prose = `这里是答案：\n${validOutput()}\n另外一段：\n${validOutput({ title: '另一个' })}`;
    const outcome = parse(prose);
    expect(outcome.ok).toBe(false);
    // 完整返回但格式错误 —— 这正是允许一次修复的场景。
    expect(outcome.repairable).toBe(true);
    expect(outcome.value).toBeUndefined();
  });

  it('T037-C03 可执行的对象表达式不被执行，报告为非 JSON', () => {
    const evil = '({ get ok() { throw new Error("executed"); }, valueOf(){ throw new Error("x"); } })';
    const outcome = parse(evil);
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('STRUCTURED_INVALID');
    expect(outcome.detail ?? '').toMatch(/JSON/u);
  });

  it('T037-C06 JSON.parse 是唯一的求值路径，没有 eval 影子', () => {
    // 用 JSON5/表达式语法确认没有安装额外解析器。
    expect(parse("{ title: '无引号键', summary: 'x', type: 'idea', tags: [], keywords: [], importance: 3, relations: [] }").ok).toBe(false);
    expect(parse("{'title': 'x'}").ok).toBe(false);
    // 合法 JSON 仍然接受。
    expect(parse(validOutput()).ok).toBe(true);
  });

  it('T037-C04 顶层数组或标量被视为格式错误，不是空结果', () => {
    for (const bad of ['[]', '"hello"', '42', 'null']) {
      const outcome = parse(bad);
      expect(outcome.ok).toBe(false);
      expect(outcome.error?.code).toBe('STRUCTURED_INVALID');
    }
  });

  it('T038-C03 模型额外输出 rawText / id / revision 等字段会被 strict 拒绝', () => {
    const extra = JSON.stringify({
      ...JSON.parse(validOutput()),
      rawText: '模型试图改写原文',
      id: '33333333-3333-4333-8333-333333333333',
      revision: 99,
      capturedText: '偷换内容',
    });
    const outcome = parse(extra);
    expect(outcome.ok).toBe(false);
    expect(outcome.repairable).toBe(true);
    // 错误信息点名了越权字段，便于诊断而不是笼统失败。
    expect(outcome.detail ?? '').toMatch(/rawText|id|revision|capturedText/u);
  });

  it('T037-R03 超长字段按码点判定为格式错误', () => {
    const longTitle = '标'.repeat(LIMITS.titleCodePoints + 1);
    const outcome = parse(validOutput({ title: longTitle }));
    expect(outcome.ok).toBe(false);
    expect(outcome.detail ?? '').toMatch(/标题/u);
  });

  it('T037-R03 超量关系被拒绝（数组上限）而不是静默截断', () => {
    const relations = Array.from({ length: LIMITS.relationsPerOrganize + 2 }, () => ({
      targetId: CANDIDATE,
      type: 'related_to',
      reason: '理由',
      score: 0.8,
      evidence: [{ itemId: TARGET, quote: '片段' }],
    }));
    const outcome = parse(validOutput({ relations }), [CANDIDATE]);
    expect(outcome.ok).toBe(false);
  });

  it('T039-R01 候选集合外的 targetId 被丢弃并计数', () => {
    const relations = [
      {
        targetId: '99999999-9999-4999-8999-999999999999',
        type: 'related_to',
        reason: '编造的目标',
        score: 0.9,
        evidence: [{ itemId: TARGET, quote: '片段' }],
      },
      {
        targetId: CANDIDATE,
        type: 'related_to',
        reason: '真实候选',
        score: 0.9,
        evidence: [{ itemId: TARGET, quote: '片段' }],
      },
    ];
    const outcome = parse(validOutput({ relations }), [CANDIDATE]);
    expect(outcome.ok).toBe(true);
    // 只留下候选集合里的那一条。
    expect(outcome.value?.relations).toHaveLength(1);
    expect(outcome.value?.relations[0].targetId).toBe(CANDIDATE);
  });

  it('T039-R01 证据引用未发送过的 itemId 时整条关系被丢弃', () => {
    const relations = [
      {
        targetId: CANDIDATE,
        type: 'related_to',
        reason: '引用外部条目',
        score: 0.9,
        evidence: [{ itemId: '99999999-9999-4999-8999-999999999999', quote: '片段' }],
      },
    ];
    const outcome = parse(validOutput({ relations }), [CANDIDATE]);
    expect(outcome.ok).toBe(true);
    expect(outcome.value?.relations).toHaveLength(0);
  });

  it('T037-R03 重复的 (targetId,type) 去重后保留五条上限', () => {
    const duplicates = Array.from({ length: 8 }, () => ({
      targetId: CANDIDATE,
      type: 'related_to',
      reason: '同样的一对',
      score: 0.75,
      evidence: [{ itemId: TARGET, quote: '片段' }],
    }));
    const result = applyBusinessValidation(
      JSON.parse(validOutput({ relations: duplicates })) as never,
      { targetId: TARGET, candidateIds: [CANDIDATE] },
    );
    expect(result.value.relations).toHaveLength(1);
    expect(result.droppedRelations).toBe(7);
  });

  it('T033-C05 零关系是成功结果，不是解析失败', () => {
    const outcome = parse(validOutput({ relations: [] }), [CANDIDATE]);
    expect(outcome.ok).toBe(true);
    expect(outcome.value?.relations).toEqual([]);
  });

  it('T037-R04 修复消息只带原输出与错误摘要，不追加新材料', () => {
    const messages = buildRepairMessages(
      '只做格式修复。',
      validOutput(),
      '- tags: 不能超过 8 个标签',
    );
    const joined = messages.map((message) => message.content).join('\n');
    expect(joined).toContain('PREVIOUS OUTPUT');
    expect(joined).toContain('不能超过 8 个标签');
    // 修复阶段不得出现候选资料或新笔记。
    expect(joined).not.toContain('CANDIDATE');
    expect(joined).not.toContain('<<<MATERIAL');
    expect(joined).not.toContain('sk-');
  });

  it('T037-C05 代码点与字节上限都用契约数值', () => {
    const huge = `{"title":"${'a'.repeat(LIMITS.modelResponseBytes)}"}`;
    const outcome = parse(huge);
    expect(outcome.ok).toBe(false);
    expect(outcome.repairable).toBe(false);
    expect(outcome.detail ?? '').toMatch(/字节/u);
  });

  it('T037-R06 最终失败带分类错误码，不用空对象伪装成功', () => {
    const outcome = parse('完全不是 JSON 的文本');
    expect(outcome.ok).toBe(false);
    expect(outcome.error?.code).toBe('STRUCTURED_INVALID');
    expect(outcome.error?.message.length).toBeGreaterThan(0);
  });

  it('T037-R01 嵌套过深的结构在 schema 之前就被拒绝', () => {
    let nested: unknown = { ok: true };
    for (let index = 0; index < 40; index += 1) nested = { child: nested };
    const outcome = parse(JSON.stringify(nested));
    expect(outcome.ok).toBe(false);
    expect(outcome.repairable).toBe(false);
  });

  it('T037-R02 提示词版本与生成器版本一致，可被 Run 记录', () => {
    // 提示词版本必须与 view.ts 里的组织提示词版本一致，否则重放解释会矛盾。
    expect(PROMPT_VERSIONS.organize).toBe(ORGANIZE_PROMPT_VERSION);
    const prompt = buildOrganizeMessages({
      targetId: TARGET,
      rawText: '幂等',
      title: '',
      keywords: [],
      tags: [],
      knownTags: [],
      candidates: [],
    });
    expect(prompt.estimatedCodePoints).toBeLessThanOrEqual(LIMITS.outboundContextCodePoints);
  });
});
