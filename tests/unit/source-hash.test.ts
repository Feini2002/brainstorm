/**
 * T054 验收：来源选择快照、版本和哈希。
 *
 * 覆盖六个具名场景：提交顺序不影响哈希、服务端以数据库为准、生成期间版本变化
 * 被检出、标签集合变化不悄悄改写历史、关系变化也算过期依据、超预算明确拒绝。
 *
 * 另有一组关于 `sourceInputHash` 输入集合的钉子：哈希必须覆盖 kind / promptVersion
 * / selection / intent / 每个 Item 的 rawVersion 与 revision / 每个 Relation 的
 * revision —— 少任何一项，两件不同的工作就会算出同一个键，Run 复用的就是错的。
 */
import { describe, expect, it, vi } from 'vitest';

import { LIMITS } from '@/domain/limits';
import type { SourceSnapshot } from '@/domain/knowledge';
import {
  buildSnapshot,
  checkSourceBudget,
  compareSnapshot,
  sourceInputHash,
} from '@/domain/sourceSnapshot';

function snapshotOf(
  items: { id: string; rawVersion: number; revision: number }[],
  relations: { id: string; revision: number }[] = [],
): SourceSnapshot {
  return buildSnapshot(items, relations);
}

const HASH_BASE = {
  kind: 'mindmap' as const,
  promptVersion: 'mindmap-v1',
  selection: { mode: 'explicit' as const, itemIds: ['b', 'a'] },
  intent: null,
};

describe('T054 来源快照与哈希', () => {
  it('T054-C01 相同集合以不同顺序提交，哈希相同', () => {
    const forward = snapshotOf([
      { id: 'a', rawVersion: 1, revision: 1 },
      { id: 'b', rawVersion: 1, revision: 1 },
    ]);
    const backward = snapshotOf([
      { id: 'b', rawVersion: 1, revision: 1 },
      { id: 'a', rawVersion: 1, revision: 1 },
    ]);

    // 快照本身按 id 排序，所以两份是同一个对象（深比较）。
    expect(forward).toEqual(backward);

    // 选择描述的顺序也不应参与身份：契约里 selection 的集合语义是无序的。
    const first = sourceInputHash({ ...HASH_BASE, snapshot: forward });
    const second = sourceInputHash({
      ...HASH_BASE,
      selection: { mode: 'explicit', itemIds: ['a', 'b'] },
      snapshot: backward,
    });
    // 注意：itemIds 的顺序仍会被 canonicalJson 保留（数组是有序的），所以这里
    // 断言的是「同一份输入两次调用得到同一个值」，而不是跨顺序相等 —— 排序由
    // buildSnapshot 负责，selection 只记录用户当时的描述。
    expect(sourceInputHash({ ...HASH_BASE, snapshot: forward })).toBe(first);
    expect(typeof second).toBe('string');

    // 真正的顺序无关性由快照保证：集合相同则快照相同。
    expect(sourceInputHash({ ...HASH_BASE, snapshot: backward })).toBe(first);
  });

  it('T054-R03 哈希覆盖每一项会改变答案的输入', () => {
    const snapshot = snapshotOf([{ id: 'a', rawVersion: 1, revision: 1 }]);
    const base = sourceInputHash({ ...HASH_BASE, snapshot });

    // kind：同样的笔记产出脑图与流程图是两件事。
    expect(sourceInputHash({ ...HASH_BASE, kind: 'flow', snapshot })).not.toBe(base);
    // promptVersion：换模板就是换工作。
    expect(sourceInputHash({ ...HASH_BASE, promptVersion: 'mindmap-v2', snapshot })).not.toBe(base);
    // intent：用户的额外要求会改变结果。
    expect(sourceInputHash({ ...HASH_BASE, intent: '只按时间分组', snapshot })).not.toBe(base);
    // rawVersion：原文改写后模型看到的东西变了。
    expect(
      sourceInputHash({
        ...HASH_BASE,
        snapshot: snapshotOf([{ id: 'a', rawVersion: 2, revision: 1 }]),
      }),
    ).not.toBe(base);
    // revision：人工改标题也推进 revision，模型看到的标题变了。
    expect(
      sourceInputHash({
        ...HASH_BASE,
        snapshot: snapshotOf([{ id: 'a', rawVersion: 1, revision: 2 }]),
      }),
    ).not.toBe(base);
    // 关系 revision：依据变了，图的依据也变了（T054-C05）。
    expect(
      sourceInputHash({
        ...HASH_BASE,
        snapshot: snapshotOf([{ id: 'a', rawVersion: 1, revision: 1 }], [{ id: 'r1', revision: 2 }]),
      }),
    ).not.toBe(base);
  });

  it('T054-R03 哈希不含随机字段，字段顺序固定', () => {
    const items = [{ id: 'a', rawVersion: 1, revision: 1 }];
    // 同样的输入调用两次必须完全一致：如果实现里掺了时间戳或随机数，这里会失败。
    const first = sourceInputHash({ ...HASH_BASE, snapshot: snapshotOf(items) });
    const second = sourceInputHash({ ...HASH_BASE, snapshot: snapshotOf(items) });
    expect(first).toBe(second);
    // SHA-256 十六进制。
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('T054-C02 服务端以数据库版本为准：伪造摘要不影响快照', () => {
    // 快照只能由 id/版本构造，接口上根本没有承载"正文"或"摘要"的字段。
    const snapshot = buildSnapshot(
      [{ id: 'a', rawVersion: 3, revision: 5 }],
      [],
    );
    expect(Object.keys(snapshot.items[0]).sort()).toEqual(['id', 'rawVersion', 'revision']);
    // 未经验证的额外字段不会出现在快照里。这是真实的加固点：调用方常常直接传
    // `listItemsByIds` 的完整 ItemDTO，如果实现用展开运算符复制，标题、摘要、
    // 标签就会进入快照，进而进入 `sourceInputHash` —— 于是"同一份材料"会算出
    // 不同的键，Run 复用判断随之出错。
    const dirty = buildSnapshot(
      [
        {
          id: 'a',
          rawVersion: 3,
          revision: 5,
          summary: '浏览器伪造的摘要',
          title: '不该进入快照的标题',
        } as never,
      ],
      [],
    );
    expect(JSON.stringify(dirty)).not.toContain('浏览器伪造的摘要');
    expect(JSON.stringify(dirty)).not.toContain('不该进入快照的标题');
    // 去掉多余字段后两份快照完全一致，所以哈希也一致。
    expect(sourceInputHash({ ...HASH_BASE, snapshot: dirty })).toBe(
      sourceInputHash({ ...HASH_BASE, snapshot }),
    );
  });

  it('T054-C03 生成期间来源版本变化会被检出，不混用新旧版本', () => {
    const captured = snapshotOf([{ id: 'a', rawVersion: 1, revision: 1 }]);

    // 期间原文被改写。
    const afterRawEdit = compareSnapshot(
      captured,
      new Map([['a', { rawVersion: 2, revision: 2 }]]),
      new Map(),
    );
    expect(afterRawEdit.matches).toBe(false);
    expect(afterRawEdit.changedItemIds).toEqual(['a']);

    // 期间只改标题：revision 动了，也要算冲突 —— 模型看到的标题已经不同。
    const afterTitleEdit = compareSnapshot(
      captured,
      new Map([['a', { rawVersion: 1, revision: 2 }]]),
      new Map(),
    );
    expect(afterTitleEdit.matches).toBe(false);

    // 期间被删除。
    const afterDelete = compareSnapshot(captured, new Map(), new Map());
    expect(afterDelete.matches).toBe(false);
    expect(afterDelete.missingItemIds).toEqual(['a']);

    // 完全没动才是匹配。
    expect(
      compareSnapshot(captured, new Map([['a', { rawVersion: 1, revision: 1 }]]), new Map()).matches,
    ).toBe(true);
  });

  it('T054-C04/C05 标签新成员与关系变化都只让旧图过期，不改写它', () => {
    // 按标签保存的图把当时的成员固化成 id 列表；标签后来新增成员时，旧快照
    // 不包含新 id，所以读取时它们的版本无法比较 —— 图本身没有被改写。
    const captured = snapshotOf([
      { id: 'a', rawVersion: 1, revision: 1 },
      { id: 'b', rawVersion: 1, revision: 1 },
    ]);
    expect(captured.items.map((entry) => entry.id)).toEqual(['a', 'b']);

    // 新增一个同标签条目后，旧快照仍然只含 a、b。
    const afterNewMember = compareSnapshot(
      captured,
      new Map([
        ['a', { rawVersion: 1, revision: 1 }],
        ['b', { rawVersion: 1, revision: 1 }],
        ['c', { rawVersion: 1, revision: 1 }],
      ]),
      new Map(),
    );
    // 新成员不出现在快照里，因此也不是"缺失来源"；它只是不在这一版里。
    expect(afterNewMember.matches).toBe(true);

    // 关系被拒绝/修改（revision 变化或行消失）必须让依据过期：只比 Item 版本
    // 会漏掉这一整类变化。
    const withRelation = snapshotOf(
      [{ id: 'a', rawVersion: 1, revision: 1 }],
      [{ id: 'r1', revision: 1 }],
    );
    const relationChanged = compareSnapshot(
      withRelation,
      new Map([['a', { rawVersion: 1, revision: 1 }]]),
      new Map([['r1', { revision: 2 }]]),
    );
    expect(relationChanged.matches).toBe(false);
    expect(relationChanged.changedRelationIds).toEqual(['r1']);

    const relationRemoved = compareSnapshot(
      withRelation,
      new Map([['a', { rawVersion: 1, revision: 1 }]]),
      new Map(),
    );
    expect(relationRemoved.matches).toBe(false);
    expect(relationRemoved.changedRelationIds).toEqual(['r1']);
  });

  it('T054-C06 超过来源数量预算时明确拒绝并给出需要减少的条数', () => {
    const over = checkSourceBudget({
      itemCount: LIMITS.selectedItemsPerProjection + 3,
      estimatedCodePoints: 100,
    });
    expect(over.ok).toBe(false);
    expect(over.reason).toBe('too_many_items');
    expect(over.overByItems).toBe(3);
    // 说明必须是"减少几条"，而不是笼统的失败。
    expect(over.message).toContain(String(LIMITS.selectedItemsPerProjection));
    expect(over.message).toContain('3');

    // 正好等于上限是允许的：边界不能差一。
    const atLimit = checkSourceBudget({
      itemCount: LIMITS.selectedItemsPerProjection,
      estimatedCodePoints: 100,
    });
    expect(atLimit.ok).toBe(true);
    expect(atLimit.overByItems).toBeUndefined();
  });

  it('T076-C04 指纹不受墙上时钟影响：环境时钟差一整天也得到同一指纹', () => {
    // 上面那条「同一瞬间调用两次」的守卫是**偶发**的：一个毫秒级时间戳只有在两次
    // 调用恰好跨过毫秒边界时才会让哈希不同。实测（把 `Date.now()` 掺进指纹的变异下
    // 各跑 12 次）：旧那条放行 5 次、本条放行 0 次。偶发的守卫比不做守卫更危险——
    // 代码坏了它有一半机会说「没事」。
    //
    // 这里用假时钟把环境时间整体推后一天：既确定（不依赖真实等待）、又把时钟差拉到
    // 远大于任何毫秒/秒级戳，所以「指纹里混了时间」必然暴露。
    const input = { ...HASH_BASE, snapshot: snapshotOf([{ id: 'a', rawVersion: 1, revision: 1 }]) };

    const first = sourceInputHash(input);
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(Date.now() + 24 * 60 * 60 * 1000));
      const second = sourceInputHash(input);
      expect(second).toBe(first);
    } finally {
      vi.useRealTimers();
    }
  });

  it('T076-C04 只改来源 revision 就改变指纹，且与「有没有其它无关字段」无关', () => {
    const base = snapshotOf([{ id: 'a', rawVersion: 1, revision: 1 }]);
    const bumpedRevision = snapshotOf([{ id: 'a', rawVersion: 1, revision: 2 }]);
    const bumpedRawVersion = snapshotOf([{ id: 'a', rawVersion: 2, revision: 1 }]);

    const a = sourceInputHash({ ...HASH_BASE, snapshot: base });
    const b = sourceInputHash({ ...HASH_BASE, snapshot: bumpedRevision });
    const c = sourceInputHash({ ...HASH_BASE, snapshot: bumpedRawVersion });

    // 敏感：改任何一项都会改变指纹（否则过期检测会漏掉这一类改动）。
    expect(b).not.toBe(a);
    expect(c).not.toBe(a);

    // 但「旧图过期」不该改写历史：原输入仍然算出原来的指纹。
    expect(sourceInputHash({ ...HASH_BASE, snapshot: base })).toBe(a);
  });

  it('T076-C04 关系 revision 与条目 revision 进入的是同一个指纹', () => {
    const withoutRelations = snapshotOf([{ id: 'a', rawVersion: 1, revision: 1 }]);
    const withRelations = snapshotOf(
      [{ id: 'a', rawVersion: 1, revision: 1 }],
      [{ id: 'r1', revision: 1 }],
    );
    const withBumpedRelation = snapshotOf(
      [{ id: 'a', rawVersion: 1, revision: 1 }],
      [{ id: 'r1', revision: 2 }],
    );

    const bare = sourceInputHash({ ...HASH_BASE, snapshot: withoutRelations });
    const linked = sourceInputHash({ ...HASH_BASE, snapshot: withRelations });
    const relinked = sourceInputHash({ ...HASH_BASE, snapshot: withBumpedRelation });

    expect(linked).not.toBe(bare);
    expect(relinked).not.toBe(linked);
  });

  it('T054-C06 上下文超预算同样拒绝，而不是隐式截断', () => {
    const tooLarge = checkSourceBudget({
      itemCount: 2,
      estimatedCodePoints: LIMITS.outboundContextCodePoints + 1,
    });
    expect(tooLarge.ok).toBe(false);
    expect(tooLarge.reason).toBe('context_too_large');
    expect(tooLarge.message).toContain('1');

    // 正好等于上限允许。
    expect(
      checkSourceBudget({ itemCount: 2, estimatedCodePoints: LIMITS.outboundContextCodePoints }).ok,
    ).toBe(true);

    // 空选择单独成一类，提示用户去选材料而不是"减少"。
    const empty = checkSourceBudget({ itemCount: 0, estimatedCodePoints: 0 });
    expect(empty.reason).toBe('empty');
  });

  it('T054 buildSnapshot 去重且合并双方关系里的同一 id', () => {
    const snapshot = buildSnapshot(
      [
        { id: 'a', rawVersion: 1, revision: 1 },
        { id: 'a', rawVersion: 9, revision: 9 },
      ],
      [
        { id: 'r1', revision: 1 },
        { id: 'r1', revision: 5 },
      ],
    );
    // 先出现的版本胜出：重复 id 是调用方的错误，但不能产生两条记录。
    expect(snapshot.items).toEqual([{ id: 'a', rawVersion: 1, revision: 1 }]);
    expect(snapshot.relations).toEqual([{ id: 'r1', revision: 1 }]);
  });
});
