/**
 * T076-C01 验收：长度边界，重点是**码点与 UTF-16 单元/UTF-8 字节的区分**。
 *
 * 已有边界测试全部用 `'标'`（1 码点 = 1 UTF-16 单元 = 3 字节）或 `'k'`（1 = 1 = 1），
 * 它们只能区分「码点 vs 字节」中的一部分，**无法**在"码点 vs UTF-16 单元"上分叉：
 * `'标'.length === 1`，用 `.length` 计数照样通过。真正能分叉的是辅助平面字符
 * （`'🧠'.length === 2` 但只有 1 码点），所以本文件用它们钉住契约单位。
 *
 * 契约：`src/domain/text.ts` 明确「按 Unicode 码点计字符，JSON/网络大小按 UTF-8 字节」，
 * 并称混淆两者为已知缺陷类。
 */
import { describe, expect, it } from 'vitest';

import { validateUserPatch } from '@/domain/itemFields';
import { LIMITS } from '@/domain/limits';
import { codePointLength, truncateCodePoints, utf8ByteLength } from '@/domain/text';

/** 辅助平面字符：1 码点、2 个 UTF-16 单元、4 个 UTF-8 字节。 */
const EMOJI = '🧠';
/** 基本多文种平面中文：1 码点、1 个 UTF-16 单元、3 个 UTF-8 字节。 */
const HAN = '标';
/** 组合字符：基底 + 组合记号是两个码点，视觉上是一个字。 */
const COMBINING = 'e\u0301'; // é

describe('T076-C01 计数单位：码点 ≠ UTF-16 单元 ≠ UTF-8 字节', () => {
  it('T076-C01 三种单位在同一段文本上确实不同，先钉住前提', () => {
    expect(EMOJI.length, 'UTF-16 单元').toBe(2);
    expect(codePointLength(EMOJI), '码点').toBe(1);
    expect(utf8ByteLength(EMOJI), 'UTF-8 字节').toBe(4);

    expect(HAN.length).toBe(1);
    expect(codePointLength(HAN)).toBe(1);
    expect(utf8ByteLength(HAN)).toBe(3);

    // 组合字符是 2 个码点：契约按码点算，所以它是"两个字符"。
    expect(codePointLength(COMBINING)).toBe(2);
    expect(utf8ByteLength(COMBINING)).toBe(3);
  });

  it('T076-C01 标题上限按码点判定：上限内用 emoji 填充必须通过', () => {
    // 100 个 emoji = 100 码点，但 UTF-16 长度是 200。用 `.length` 计数会误判超限。
    const atLimit = EMOJI.repeat(LIMITS.titleCodePoints);
    expect(atLimit.length).toBe(LIMITS.titleCodePoints * 2);
    expect(codePointLength(atLimit)).toBe(LIMITS.titleCodePoints);

    const issues = validateUserPatch({ title: atLimit });
    expect(issues.fieldErrors.title, '恰好到上限不应报错').toBeUndefined();
  });

  it('T076-C01 标题超一个码点即被拒，而不是超两个 UTF-16 单元才拒', () => {
    const overByOneCodePoint = EMOJI.repeat(LIMITS.titleCodePoints + 1);
    // 若是按 UTF-16 单元判定，需要 202 个单元；按码点判定则是 101 个码点。
    const issues = validateUserPatch({ title: overByOneCodePoint });
    expect(issues.fieldErrors.title).toBeDefined();
    expect(issues.fieldErrors.title?.[0]).toContain(String(LIMITS.titleCodePoints));
  });

  it('T076-C01 摘要上限同样按码点，汉字与 emoji 混排不因字节数被拒', () => {
    // 500 个汉字是 1500 字节；若把字节当字符，这里会被误判超限。
    const han = HAN.repeat(LIMITS.summaryCodePoints);
    expect(utf8ByteLength(han)).toBe(LIMITS.summaryCodePoints * 3);
    expect(validateUserPatch({ summary: han }).fieldErrors.summary).toBeUndefined();

    // 500 个 emoji 是 2000 字节，仍是 500 码点，同样通过。
    const emoji = EMOJI.repeat(LIMITS.summaryCodePoints);
    expect(utf8ByteLength(emoji)).toBe(LIMITS.summaryCodePoints * 4);
    expect(validateUserPatch({ summary: emoji }).fieldErrors.summary).toBeUndefined();

    expect(
      validateUserPatch({ summary: HAN.repeat(LIMITS.summaryCodePoints + 1) }).fieldErrors.summary,
    ).toBeDefined();
  });

  it('T076-C01 原文上限按码点，且空白文本先被拒而不是先算长度', () => {
    const atLimit = EMOJI.repeat(LIMITS.rawTextCodePoints);
    expect(codePointLength(atLimit)).toBe(LIMITS.rawTextCodePoints);
    expect(validateUserPatch({ rawText: atLimit }).fieldErrors.rawText).toBeUndefined();

    expect(
      validateUserPatch({ rawText: EMOJI.repeat(LIMITS.rawTextCodePoints + 1) }).fieldErrors.rawText,
    ).toBeDefined();

    // 空白与空串是"没有可见内容"，与长度无关。
    expect(validateUserPatch({ rawText: '   \n\t ' }).fieldErrors.rawText).toEqual(['原文不能为空']);
    expect(validateUserPatch({ rawText: '' }).fieldErrors.rawText).toEqual(['原文不能为空']);
  });

  it('T076-C01 码点截断不劈开代理对，且截断结果自己就是合法字符串', () => {
    const text = EMOJI.repeat(5);
    const cut = truncateCodePoints(text, 3);

    expect(codePointLength(cut)).toBe(3);
    // 劈开代理对会留下孤立的半个字符：`codePointLength` 仍会数成 3 但内容已损坏。
    // 逐码点比对能发现这一点。
    expect(Array.from(cut).every((point) => point === EMOJI)).toBe(true);
    expect(cut).toBe(EMOJI.repeat(3));

    // 上限大于长度时原样返回，不产生无谓改写。
    expect(truncateCodePoints(text, 99)).toBe(text);
    // 上限为 0 或负数返回空串，不是负数切片那种怪结果。
    expect(truncateCodePoints(text, 0)).toBe('');
    expect(truncateCodePoints(text, -1)).toBe('');
  });
});
