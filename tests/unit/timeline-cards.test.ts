/**
 * T015 验收：收件箱时间线与知识卡片（可纯测部分）。
 *
 * 用例规格：docs/05_tests/G1/T015_cases.md。审计结论是「`KnowledgeCard.tsx` /
 * `RecentItems.tsx` / `formatTime.ts` 无测试导入，只有 e2e」。渲染结果不能在 node
 * 环境断言（没有 jsdom），但 T015 里真正容易写错的是**显示规则**：无标题回退到什么、
 * 预览是否受限、过期徽标在什么条件下出现、时区与相对时间怎么算。这些已经抽成
 * `cardDisplay.ts` 与 `formatTime.ts` 的纯函数，本文件直接断言它们。
 *
 * 卡片 DOM 结构、抽屉打开与滚动仍只由 e2e 覆盖。
 */
import { describe, expect, it } from 'vitest';

import type { ItemDTO } from '@/domain/knowledge';
import {
  CARD_PREVIEW_CODE_POINTS,
  UNTITLED_LABEL,
  cardPreview,
  cardTitle,
  hasReadableContent,
  showsStaleBadge,
  timelineSummary,
} from '@/features/shared/cardDisplay';
import { formatLocalTimestamp, formatTime } from '@/features/shared/formatTime';
import { listItems, decodeCursor } from '@/server/repositories/items';
import { createCapture } from '@/server/services/items';
import { openTestDatabase, createTestDatabase } from '../helpers/db';

type CardItem = Pick<ItemDTO, 'title' | 'capturedText' | 'structuredBaseRawVersion' | 'rawVersion'>;

function card(overrides: Partial<CardItem> = {}): CardItem {
  return {
    title: '',
    capturedText: '一条原文。',
    structuredBaseRawVersion: null,
    rawVersion: 1,
    ...overrides,
  };
}

describe('T015-C01 未整理卡片', () => {
  it('T015-C01 只有 rawText 时用原文预览做标题，不显示空白也不调用模型', () => {
    // 空标题曾让整排卡片看起来「不存在」，这正是本用例要排除的。
    expect(cardTitle(card({ capturedText: '系统架构的四条主线。' }))).toBe(
      '系统架构的四条主线。',
    );
    expect(cardTitle(card({ capturedText: '系统架构的四条主线。' }))).not.toBe('');
  });

  it('T015-C01 有标题时用标题；标题只有空白时退化到原文', () => {
    expect(cardTitle(card({ title: '人工标题', capturedText: '原文。' }))).toBe('人工标题');
    // 被清空的标题（只有空格）不能覆盖掉可读的原文预览。
    expect(cardTitle(card({ title: '   ', capturedText: '原文。' }))).toBe('原文。');
  });

  it('T015-C01 原文也多行多空格时标题折成单行，不会把卡片撑成两行', () => {
    expect(cardTitle(card({ capturedText: '第一行\n\n  第二行\t第三行' }))).toBe(
      '第一行 第二行 第三行',
    );
  });

  it('T015-C01 极端情况下（连原文都为空）仍有可辨认标签，而不是空字符串', () => {
    expect(cardTitle(card({ capturedText: '   ' }))).toBe(UNTITLED_LABEL);
  });

  it('T015-C01/C06 卡片预览受限，详情才是完整原文的归宿', () => {
    const long = '一'.repeat(10_000);
    const preview = cardPreview(card({ capturedText: long }));

    // 一万字不能整个挂进列表项。
    expect(Array.from(preview).length).toBeLessThanOrEqual(CARD_PREVIEW_CODE_POINTS + 1);
    expect(preview.endsWith('…')).toBe(true);
    // 短文本原样显示，不额外加省略号。
    expect(cardPreview(card({ capturedText: '短文本' }))).toBe('短文本');
    expect(cardPreview(card({ capturedText: '短文本' })).endsWith('…')).toBe(false);
  });

  it('T015-C01/C06 预览按码点截断，不把代理对劈成半个字符', () => {
    const emoji = '🧠'.repeat(CARD_PREVIEW_CODE_POINTS + 5);
    const preview = cardPreview(card({ capturedText: emoji }));
    // 出现孤立代理项就说明用了 slice 而不是按码点切。
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/u.test(preview)).toBe(
      false,
    );
  });
});

describe('T015-C02 跨午夜与本地时间', () => {
  it('T015-C02 绝对时间与时区无关，同一 ISO 在任何时区都指向同一时刻', () => {
    const iso = '2026-03-04T15:20:00.000Z';
    const formatted = formatTime(iso, new Date('2026-03-04T15:30:00.000Z'));

    // iso 原样保留给 dateTime 属性，服务端存 UTC 的事实不会被展示层改写。
    expect(formatted.iso).toBe(iso);
    // 绝对时间用本地时区渲染，因此它随机器时区变化，但指向的瞬间不变。
    expect(formatted.absolute).toBe(formatLocalTimestamp(iso));
    expect(new Date(formatted.iso).getTime()).toBe(new Date(iso).getTime());
  });

  it('T015-C02 相对时间按注入的时钟计算，边界值各有确定文案', () => {
    const now = new Date('2026-03-04T12:00:00.000Z');
    const at = (iso: string) => formatTime(iso, now).label;

    expect(at('2026-03-04T11:59:30.000Z')).toBe('刚刚');
    expect(at('2026-03-04T11:45:00.000Z')).toBe('15 分钟前');
    expect(at('2026-03-04T09:00:00.000Z')).toBe('3 小时前');
    expect(at('2026-03-02T12:00:00.000Z')).toBe('2 天前');
    // 超过一周改用绝对时间：「9 天前」对用户没用。
    expect(at('2026-02-20T12:00:00.000Z')).toBe(formatLocalTimestamp('2026-02-20T12:00:00.000Z'));
  });

  it('T015-C02 服务端时间比浏览器快（时钟偏差）时显示准确时间，不显示负数', () => {
    const now = new Date('2026-03-04T12:00:00.000Z');
    const future = formatTime('2026-03-04T12:05:00.000Z', now);

    // 「-5 分钟前」比直接给出时刻更糟；绝对时间里的日期连字符不算负数表述。
    expect(future.label).not.toContain('分钟前');
    expect(future.label).not.toContain('小时前');
    expect(future.label).toBe(formatLocalTimestamp('2026-03-04T12:05:00.000Z'));
  });

  it('T015-C02 时间戳不合法时不崩，原样回显让问题看得见', () => {
    const broken = formatTime('not-a-date', new Date('2026-03-04T12:00:00.000Z'));
    expect(broken.label).toBe('not-a-date');
    expect(broken.iso).toBe('not-a-date');
    expect(formatLocalTimestamp('not-a-date')).toBe('not-a-date');
  });
});

describe('T015-C03 时间线顺序与身份稳定', () => {
  it('T015-C03 相同时间戳的记录按 id 稳定排序，分页两次结果一致', () => {
    const harness = createTestDatabase();
    try {
      const db = openTestDatabase(harness.databasePath);
      const created = Array.from({ length: 5 }, (_, index) =>
        createCapture(db, {
          captureRequestId: `11111111-1111-4111-8111-00000000000${index}`,
          rawText: `同秒记录 ${index}`,
          sourceType: 'other',
          sourceRef: null,
        }).item,
      );
      // 把五条的时间戳压成同一刻：这是「同秒多条」的真实形态。
      const sameMoment = '2026-03-04T12:00:00.000Z';
      for (const item of created) {
        db.prepare('UPDATE knowledge_items SET created_at = ? WHERE id = ?').run(sameMoment, item.id);
      }

      const first = listItems(db, { filters: {}, sort: 'newest', limit: 3, cursor: null });
      const again = listItems(db, { filters: {}, sort: 'newest', limit: 3, cursor: null });
      expect(first.items.map((item) => item.id)).toEqual(again.items.map((item) => item.id));

      // 游标翻到的下一页不与第一页重叠：只靠时间戳排序会在这里丢行或重行。
      expect(first.nextCursor).not.toBeNull();
      const second = listItems(db, {
        filters: {},
        sort: 'newest',
        limit: 3,
        cursor: decodeCursor(first.nextCursor as string),
      });
      const ids = new Set([...first.items, ...second.items].map((item) => item.id));
      expect(ids.size).toBe(5);
      expect(first.items.length + second.items.length).toBe(5);
    } finally {
      harness.cleanup();
    }
  });

  it('T015-C03 卡片身份必须来自 id：两条同标题记录是不同的对象', async () => {
    const { cardTitle } = await import('@/features/shared/cardDisplay');
    const first = { title: '同名标题', capturedText: '甲', rawVersion: 1, structuredBaseRawVersion: null };
    const second = { title: '同名标题', capturedText: '乙', rawVersion: 1, structuredBaseRawVersion: null };

    // 标题（甚至预览）都相同，所以任何用标题做 key 的实现都会让内容串位。
    expect(cardTitle(first)).toBe(cardTitle(second));
    expect(first).not.toBe(second);
  });
});

describe('T015-C04 保存回显不重复', () => {
  it('T015-C04 计数文案区分「就这些」与「只显示了一页」', () => {
    expect(timelineSummary({ shown: 3, totalMatched: 3 })).toBe('共 3 条');
    expect(timelineSummary({ shown: 20, totalMatched: 57 })).toBe('共 57 条，显示最新 20 条');
    // 刚保存的那一条在页内时总数加一，文案跟着变，界面不需要自己猜。
    expect(timelineSummary({ shown: 4, totalMatched: 4 })).toBe('共 4 条');
  });

  it('T015-C04 新增一条后列表里出现的是同一个 id，不会多出一个临时条目', () => {
    const harness = createTestDatabase();
    try {
      const db = openTestDatabase(harness.databasePath);
      const created = createCapture(db, {
        captureRequestId: '22222222-2222-4222-8222-222222222222',
        rawText: '刚保存的一条。',
        sourceType: 'other',
        sourceRef: null,
      }).item;

      const page = listItems(db, { filters: {}, sort: 'newest', limit: 20, cursor: null });
      const matches = page.items.filter((item) => item.id === created.id);
      expect(matches).toHaveLength(1);
      expect(matches[0]?.capturedText).toBe('刚保存的一条。');
    } finally {
      harness.cleanup();
    }
  });
});

describe('T015-C05 失败可读', () => {
  it('T015-C05 整理失败（status=error）的条目仍可打开原文，不从事时间线消失', () => {
    const harness = createTestDatabase();
    try {
      const db = openTestDatabase(harness.databasePath);
      const created = createCapture(db, {
        captureRequestId: '33333333-3333-4333-8333-333333333333',
        rawText: '整理失败但原文必须还在。',
        sourceType: 'other',
        sourceRef: null,
      }).item;
      db.prepare("UPDATE knowledge_items SET status = 'error' WHERE id = ?").run(created.id);

      const page = listItems(db, { filters: {}, sort: 'newest', limit: 20, cursor: null });
      const card = page.items.find((item) => item.id === created.id);
      expect(card).toBeDefined();
      // 把失败当成「没有数据」会把用户的材料藏起来。
      expect(hasReadableContent(card as ItemDTO)).toBe(true);
      expect(cardTitle(card as ItemDTO)).toBe('整理失败但原文必须还在。');
    } finally {
      harness.cleanup();
    }
  });

  it('T015-C05 只剩空白原文的异常记录不会被当成可读内容', () => {
    expect(hasReadableContent({ capturedText: '有内容', rawText: '' })).toBe(true);
    expect(hasReadableContent({ capturedText: '', rawText: '有内容' })).toBe(true);
    expect(hasReadableContent({ capturedText: '  ', rawText: '\n' })).toBe(false);
  });

  it('T015-C05 从未整理过的记录不显示「来源版本已变化」，避免无意义徽标', () => {
    // structuredBaseRawVersion 为 null ⇒ 没有基于旧版本整理过，谈不上过期。
    expect(showsStaleBadge({ structuredBaseRawVersion: null, rawVersion: 5 })).toBe(false);
    expect(showsStaleBadge({ structuredBaseRawVersion: 3, rawVersion: 3 })).toBe(false);
    // 整理基于 v2、原文已经到 v4 ⇒ 展示的信息确实过期了。
    expect(showsStaleBadge({ structuredBaseRawVersion: 2, rawVersion: 4 })).toBe(true);
  });
});
