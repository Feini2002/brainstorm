/**
 * T062 验收（单元）：流程意图、方向与材料确认的纯契约。
 *
 * 用例规格里六条场景有两条是"网络行为"（C03 编辑不产生请求）和"生成语义"
 * （C06 无依据因果），它们在 e2e 与 T063 的服务层断言；这里钉住的是其余部分
 * **唯一可以实现它们的地方**：请求体的字段集合、空意图的拒绝方式、方向与意图
 * 彼此独立，以及确认面板的计数是否真的来自解析结果。
 *
 * 每条断言都挑一种"看起来对但其实是另一回事"的实现来否定：
 *  - 空意图若被 `?? undefined` 吞掉，C02 就会变成「服务端 400」，所以这里断言
 *    空文本得到的是**具体错误**而不是一个可提交的请求；
 *  - 意图若被拼进方向字段或反向，C04 的「只改排版」就不成立，所以这里断言
 *    改方向时 intent 字节不变；
 *  - 请求体若整体展开草稿对象，`mermaid`/`style` 之类的键就会漏出去，所以这里
 *    **逐键**断言白名单。
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FLOW_DIRECTION,
  FLOW_DIRECTIONS,
  FLOW_INTENT_MAX_CODE_POINTS,
  FLOW_INTENT_PLACEHOLDER,
  buildFlowGenerationRequest,
  describeFlowMaterial,
  normalizeFlowIntent,
  summarizeFlowMaterial,
  validateFlowIntent,
} from '@/domain/flowIntent';

const ID_A = '11111111-1111-4111-8111-111111111111';
const ID_B = '22222222-2222-4222-8222-222222222222';
const ID_C = '33333333-3333-4333-8333-333333333333';

const KEY = '44444444-4444-4444-8444-444444444444';

describe('T062 流程意图', () => {
  it('T062-C02 空意图：按规范拒绝并给出可填写的提示，不产出 undefined', () => {
    for (const draft of [
      { intent: '', direction: 'LR' as const },
      { intent: '   ', direction: 'LR' as const },
      { intent: '\n\t \n', direction: 'LR' as const },
    ]) {
      const checked = validateFlowIntent(draft);
      expect(checked.ok).toBe(false);
      expect(checked.errors.intent).toBeTruthy();
      // 关键：不是「归一化后为空字符串」被当成合法值送出去。
      expect(checked.intent).toBe('');
    }

    // 整个请求构造也必须失败，而不是产出一个 intent 缺失的 body。
    const built = buildFlowGenerationRequest({
      requestKey: KEY,
      itemIds: [ID_A],
      draft: { intent: '   ', direction: 'LR' },
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.errors.intent).toBeTruthy();
  });

  it('T062-C02/R03 意图是纯文本并限长，超长给出具体字数', () => {
    const tooLong = '观'.repeat(FLOW_INTENT_MAX_CODE_POINTS + 1);
    const checked = validateFlowIntent({ intent: tooLong, direction: 'LR' });
    expect(checked.ok).toBe(false);
    // 消息里带实际数字，用户知道要删多少。
    expect(checked.errors.intent).toContain(String(FLOW_INTENT_MAX_CODE_POINTS));
    expect(checked.errors.intent).toContain(String(FLOW_INTENT_MAX_CODE_POINTS + 1));

    // 恰好等于上限必须通过（边界不是 off-by-one）。
    const exact = '观'.repeat(FLOW_INTENT_MAX_CODE_POINTS);
    expect(validateFlowIntent({ intent: exact, direction: 'LR' }).ok).toBe(true);
  });

  it('T062-C02 归一化是确定性的：同一意图必须得到同一结果', () => {
    const messy = ' 观察   顺序 \r\n\n\n\n 与依赖  ';
    const once = normalizeFlowIntent(messy);
    const twice = normalizeFlowIntent(messy);
    expect(once).toBe(twice);
    expect(once).toBe('观察 顺序\n\n与依赖');

    // 控制字符不能进入将要哈希的文本。
    expect(normalizeFlowIntent('a\u0000b\u001Fc')).toBe('a b c');
    // CRLF 与宽字符不影响计数方式。
    expect(normalizeFlowIntent('一\r\n二')).toBe('一\n二');
  });

  it('T062-C04 方向只影响排版字段：改方向不改变意图与材料', () => {
    const draft = { intent: '这些材料的先后关系', direction: 'LR' as const };
    const lr = buildFlowGenerationRequest({ requestKey: KEY, itemIds: [ID_A, ID_B], draft });
    const tb = buildFlowGenerationRequest({
      requestKey: KEY,
      itemIds: [ID_A, ID_B],
      draft: { ...draft, direction: 'TB' },
    });

    expect(lr.ok).toBe(true);
    expect(tb.ok).toBe(true);
    if (!lr.ok || !tb.ok) return;

    expect(lr.body.direction).toBe('LR');
    expect(tb.body.direction).toBe('TB');
    // 除方向外逐字段相等——方向没有机会影响材料或意图。
    expect(lr.body.intent).toBe(tb.body.intent);
    expect(lr.body.selection).toEqual(tb.body.selection);
    expect(lr.body.requestKey).toBe(tb.body.requestKey);

    // 默认值来自契约，而不是 UI 自己定的。
    expect(DEFAULT_FLOW_DIRECTION).toBe('LR');
    expect([...FLOW_DIRECTIONS]).toEqual(['LR', 'TB']);
    // 非枚举方向被拒绝，不是被悄悄改成默认值。
    const bad = validateFlowIntent({ intent: '观察', direction: 'RL' as never });
    expect(bad.ok).toBe(false);
    expect(bad.errors.direction).toBeTruthy();
  });

  it('T062-R03 请求体只含四个白名单字段，不接受 Mermaid 源码或风格指令', () => {
    const built = buildFlowGenerationRequest({
      requestKey: KEY,
      itemIds: [ID_A],
      draft: { intent: '看顺序', direction: 'LR' },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(Object.keys(built.body).sort()).toEqual([
      'direction',
      'intent',
      'requestKey',
      'selection',
    ]);
    expect(Object.keys(built.body.selection).sort()).toEqual(['itemIds', 'mode']);

    // 即便调用方塞进了额外的草稿字段（旧版 UI 或手写调用），也不会被展开到 body。
    const withExtra = buildFlowGenerationRequest({
      requestKey: KEY,
      itemIds: [ID_A],
      draft: { intent: '看顺序', direction: 'LR', mermaid: 'graph TD; click a href' } as never,
    });
    expect(withExtra.ok).toBe(true);
    if (withExtra.ok) {
      expect(JSON.stringify(withExtra.body)).not.toContain('mermaid');
      expect(JSON.stringify(withExtra.body)).not.toContain('click');
    }

    // 示例文案本身不能是「让模型证明某个结论」的引导句。
    expect(FLOW_INTENT_PLACEHOLDER).not.toMatch(/证明|一定|必然/u);
  });

  it('T062-C05 材料确认：缺失与被删除的条目必须让「集合已变化」为真', () => {
    const unchanged = summarizeFlowMaterial({
      requestedIds: [ID_A, ID_B],
      resolvedIds: [ID_A, ID_B],
    });
    expect(unchanged.changed).toBe(false);
    expect(unchanged.missingIds).toEqual([]);
    expect(describeFlowMaterial(unchanged)).toBeNull();

    // 删除一条来源：用户按了生成，但集合与勾选不一致 —— 必须能看出来。
    const shrunk = summarizeFlowMaterial({ requestedIds: [ID_A, ID_B], resolvedIds: [ID_A] });
    expect(shrunk.changed).toBe(true);
    expect(shrunk.missingIds).toEqual([ID_B]);
    expect(shrunk.count).toBe(1);
    expect(describeFlowMaterial(shrunk)).toContain('删除');

    // 范围比勾选更宽（例如标签解析结果变了）也必须说明。
    const widened = summarizeFlowMaterial({ requestedIds: [ID_A], resolvedIds: [ID_A, ID_B] });
    expect(widened.changed).toBe(true);
    expect(widened.addedIds).toEqual([ID_B]);
    expect(describeFlowMaterial(widened)).toContain('多出');
  });

  it('T062-C05 超预算的集合被标出，不会被截断成看起来正常的请求', () => {
    const many = Array.from({ length: 41 }, (_, index) => `id-${index}`);
    const summary = summarizeFlowMaterial({ requestedIds: many, resolvedIds: many });
    expect(summary.overBudget).toBe(true);
    expect(summary.count).toBe(41);
    expect(summary.limit).toBe(40);
    // 明确写出数字，而不是笼统的"超出限制"。
    expect(describeFlowMaterial(summary)).toContain('40');

    // 构造请求时同样是拒绝，不缩短。
    const built = buildFlowGenerationRequest({
      requestKey: KEY,
      itemIds: many,
      draft: { intent: '观察', direction: 'LR' },
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.errors.selection).toContain('40');
  });

  it('T062-C02 重复勾选的 id 被去重，且请求顺序保持用户的选择顺序', () => {
    const built = buildFlowGenerationRequest({
      requestKey: KEY,
      itemIds: [ID_B, ID_A, ID_B, ID_C, ID_A],
      draft: { intent: '看依赖', direction: 'TB' },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.selection.itemIds).toEqual([ID_B, ID_A, ID_C]);
    // 去重后仍在预算内。
    expect(built.body.selection.mode).toBe('explicit');
  });

  it('T062-C01 引导性提问仍走同一字段：材料不足时的结论由服务端证据门槛决定', () => {
    // 用户写下「证明 A 一定导致 B」，意图字段照原样进入请求——这里不做关键词
    // 过滤，因为把用户的问题静默改写会让人以为模型确实被限制了。真正的保护在
    // 服务端：causal 边需要已确认且未过期的 causes 关系（T063）。
    const built = buildFlowGenerationRequest({
      requestKey: KEY,
      itemIds: [ID_A, ID_B],
      draft: { intent: '请证明 A 一定导致 B', direction: 'LR' },
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.body.intent).toBe('请证明 A 一定导致 B');
    // 意图没有获得任何"提高确定性"的权限字段。
    expect(built.body).not.toHaveProperty('forceCausal');
    expect(built.body).not.toHaveProperty('evidenceMode');
  });

  it('T062 缺少材料时明确拒绝，而不是发一个空选择', () => {
    const built = buildFlowGenerationRequest({
      requestKey: KEY,
      itemIds: [],
      draft: { intent: '看顺序', direction: 'LR' },
    });
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.errors.selection).toBeTruthy();

    const noKey = buildFlowGenerationRequest({
      requestKey: '   ',
      itemIds: [ID_A],
      draft: { intent: '看顺序', direction: 'LR' },
    });
    expect(noKey.ok).toBe(false);
    if (!noKey.ok) expect(noKey.errors.requestKey).toBeTruthy();
  });
});
