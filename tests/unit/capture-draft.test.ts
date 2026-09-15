/**
 * T013 验收：极简输入框与中文输入体验（纯规则部分）。
 *
 * 用例规格：docs/05_tests/G1/T013_cases.md。审计结论是「`CaptureBox.tsx` /
 * `useCapture.ts` 无测试导入，只有 e2e 证据」。仓库的 vitest 是
 * `environment: 'node'` 且没有 jsdom / React Testing Library，所以这里不去假装
 * 断言「渲染出什么」，而是把用例里**真正是规则**的部分抽成不依赖渲染器的函数再断言：
 *   - IME 组合期间的 Enter 不得提交（T013-C02）；
 *   - 慢响应回来时只清掉它提交的那一份快照，等待期间新输入必须保留（T013-C03）；
 *   - 纯空白在发请求之前就被拒绝（T013-C04）；
 *   - 前端码点计数与服务端 wire schema 同一套限制（T013-C05）。
 *
 * 这些规则不需要文件系统或数据库，因此留在 `unit` 项目。同名的服务端与 HTTP 层
 * 断言（真正落库的那一半）在 `tests/integration/capture-draft.test.ts`，因为
 * `unit` 项目按 T011-R01 的划分是「无文件系统、无数据库」。
 *
 * 输入框的视觉状态、候选框行为与焦点管理仍只由 e2e 覆盖。
 */
import { describe, expect, it } from 'vitest';

import { LIMITS } from '@/domain/limits';
import { codePointLength } from '@/domain/text';
import {
  canSubmitDraft,
  hasUnsavedDraft,
  isComposingKey,
  shouldSubmitFromKeyboard,
} from '@/features/inbox/captureShortcuts';
import { applyAcceptedWrite } from '@/features/inbox/useCapture';

describe('T013-C02 IME 组合期间不得提交', () => {
  it('T013-C02 组合中的回车不提交，只确认候选', () => {
    // 中文输入法里回车就是选字：把它当提交会把半句话存进库。
    expect(shouldSubmitFromKeyboard({ key: 'Enter', isComposing: true })).toBe(false);
    // 即使同时按着 Ctrl 也不能例外：组合优先级高于快捷键。
    expect(
      shouldSubmitFromKeyboard({ key: 'Enter', isComposing: true, ctrlKey: true }),
    ).toBe(false);
    expect(
      shouldSubmitFromKeyboard({ key: 'Enter', isComposing: true, metaKey: true }),
    ).toBe(false);
  });

  it('T013-C02 老式输入法用 keyCode 229 标记消费按键，同样不提交', () => {
    // Safari 等实现在「结束组合的那一次回车」上给出 isComposing === false，
    // 只认 isComposing 会漏掉这个真实缺陷形态。
    expect(isComposingKey({ key: 'Enter', keyCode: 229 })).toBe(true);
    expect(shouldSubmitFromKeyboard({ key: 'Enter', keyCode: 229 })).toBe(false);
    expect(
      shouldSubmitFromKeyboard({ key: 'Enter', keyCode: 229, ctrlKey: true }),
    ).toBe(false);
  });

  it('T013-C02 组合结束后的 Ctrl+Enter 仍然提交，规则没有被过度收紧', () => {
    // 反面样本：证明上两条不是「任何按键都返回 false」的恒真结果。
    expect(shouldSubmitFromKeyboard({ key: 'Enter', isComposing: false })).toBe(false);
    expect(shouldSubmitFromKeyboard({ key: 'Enter', ctrlKey: true })).toBe(true);
    expect(shouldSubmitFromKeyboard({ key: 'Enter', metaKey: true })).toBe(true);
    expect(shouldSubmitFromKeyboard({ key: 'Enter', keyCode: 13, ctrlKey: true })).toBe(true);
  });

  it('T013-C02 单独的 Enter 只换行，其它按键不触发提交', () => {
    expect(shouldSubmitFromKeyboard({ key: 'Enter' })).toBe(false);
    expect(shouldSubmitFromKeyboard({ key: 'a', ctrlKey: true })).toBe(false);
    expect(shouldSubmitFromKeyboard({ key: 'Escape' })).toBe(false);
  });
});

describe('T013-C03 慢响应不得擦掉新草稿', () => {
  it('T013-C03 第一段提交后继续输入第二段：成功回调不清空第二段', () => {
    // 用户在等待期间又写了字：revision 变大。
    const applied = applyAcceptedWrite(
      { text: '第一段。第二段。', revision: 7 },
      { text: '第一段。', revision: 6 },
    );

    expect(applied.cleared).toBe(false);
    expect(applied.text).toBe('第一段。第二段。');
  });

  it('T013-C03 编辑后又改回完全相同的文字也算新输入，必须保留', () => {
    // 只比较字符串的实现会在这里把用户的文字清掉：revision 才是判据。
    const applied = applyAcceptedWrite(
      { text: '同样的文字。', revision: 9 },
      { text: '同样的文字。', revision: 8 },
    );

    expect(applied.cleared).toBe(false);
    expect(applied.text).toBe('同样的文字。');
  });

  it('T013-C03 没有任何新输入时才清空，且 sourceRef 一并复位', () => {
    const applied = applyAcceptedWrite(
      { text: '唯一的一段。', revision: 3 },
      { text: '唯一的一段。', revision: 3 },
    );

    expect(applied.cleared).toBe(true);
    expect(applied.text).toBe('');
  });

  it('T013-C03 未确认的草稿会被 beforeunload 保护，已保存的不再弹提示', () => {
    expect(hasUnsavedDraft('还没保存的一段。', null)).toBe(true);
    expect(hasUnsavedDraft('还没保存的一段。', '上一段已保存的。')).toBe(true);
    // 与已接受内容一致 ⇒ 没有未保存内容。
    expect(hasUnsavedDraft('已保存的一段。', '已保存的一段。')).toBe(false);
    // 空白不算草稿。
    expect(hasUnsavedDraft('   \n\t ', null)).toBe(false);
  });
});

describe('T013-C04 纯空白不产生请求', () => {
  it('T013-C04 空格、换行与制表符都不能提交', () => {
    for (const text of ['   ', '\n\n', '\t', ' \n\t ']) {
      expect(
        canSubmitDraft({ text, codePoints: codePointLength(text), limit: LIMITS.rawTextCodePoints, saving: false }),
      ).toBe(false);
    }
  });

  it('T013-C04 有内容时才可以提交，保存中不能重复提交', () => {
    expect(
      canSubmitDraft({ text: '系统架构', codePoints: 4, limit: LIMITS.rawTextCodePoints, saving: false }),
    ).toBe(true);
    // 保存中的第二次点击不能变成第二条记录。
    expect(
      canSubmitDraft({ text: '系统架构', codePoints: 4, limit: LIMITS.rawTextCodePoints, saving: true }),
    ).toBe(false);
  });
});

describe('T013-C05 码点计数与服务端一致', () => {
  it('T013-C05 emoji 按码点算：前端可提交的一定过得了后端校验', () => {
    // 4 个辅助平面 emoji：UTF-16 长度是 8，码点是 4。用 .length 计数会让界面
    // 显示的数字与用户理解的字符数不一致。
    const text = '🧠📚🔖🗂️';
    expect(text.length).toBeGreaterThan(codePointLength(text));
    expect(codePointLength(text)).toBe(5);
    expect(
      canSubmitDraft({
        text,
        codePoints: codePointLength(text),
        limit: LIMITS.rawTextCodePoints,
        saving: false,
      }),
    ).toBe(true);
  });

  it('T013-C05 恰好到上限可以提交，超一个码点就不行', () => {
    expect(
      canSubmitDraft({
        text: 'x',
        codePoints: LIMITS.rawTextCodePoints,
        limit: LIMITS.rawTextCodePoints,
        saving: false,
      }),
    ).toBe(true);
    expect(
      canSubmitDraft({
        text: 'x',
        codePoints: LIMITS.rawTextCodePoints + 1,
        limit: LIMITS.rawTextCodePoints,
        saving: false,
      }),
    ).toBe(false);

    // 前端用的上限与 wire schema 是同一个常量：两边漂移才会出现「前端放行、后端 400」。
    // 真正过一遍 HTTP 层的那一组在 tests/integration/capture-draft.test.ts。
    const atLimit = 'あ'.repeat(LIMITS.rawTextCodePoints);
    expect(codePointLength(atLimit)).toBe(LIMITS.rawTextCodePoints);
    expect(codePointLength(`${atLimit}あ`)).toBe(LIMITS.rawTextCodePoints + 1);
  });
});
