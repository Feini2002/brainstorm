/**
 * T056 验收：树校验与安全 Markdown 编译。
 *
 * 六个具名场景分别对应一类会被递归渲染器放大的结构错误：环、多根、悬空子树、
 * 语法注入、深度越界、以及编译不确定性。这里全部用纯函数调用，不需要数据库，
 * 因为编译器按契约就不访问任何环境（T056-R06）。
 */
import { describe, expect, it } from 'vitest';
import { Transformer } from 'markmap-lib/no-plugins';

import { LIMITS } from '@/domain/limits';
import {
  MINDMAP_COMPILER_VERSION,
  compileMindmap,
  escapeMarkdownLabel,
  inspectMindmapTree,
  isLabelStable,
  mindmapMarkdownNodeIds,
  normalizeLabel,
  validateMindmap,
} from '@/domain/compileMindmap';
import type { MindmapOutput } from '@/domain/schemas/mindmap';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const ALL = new Set([A, B, C]);

function doc(nodes: MindmapOutput['nodes'], title = '测试脑图'): MindmapOutput {
  return { title, nodes };
}

function ok(document: MindmapOutput, allowed: ReadonlySet<string> = ALL) {
  const result = validateMindmap(document, { allowedItemIds: allowed });
  if (!result.ok || !result.content) {
    throw new Error(`预期通过，实际失败：${result.errors.map((e) => e.message).join('；')}`);
  }
  return result;
}

/** A minimal well-formed tree: root group with two note children. */
function sampleTree(): MindmapOutput {
  return doc([
    { id: 'm1', parentId: null, label: '需求与自动化', itemIds: [A, B], kind: 'group' },
    { id: 'm2', parentId: 'm1', label: '问题定义', itemIds: [A], kind: 'note' },
    { id: 'm3', parentId: 'm1', label: '自动化前提', itemIds: [B], kind: 'note' },
  ]);
}

describe('T056 脑图树校验与编译', () => {
  it('T056-C01 环被拒绝并定位到节点', () => {
    // m2 的父是 m3，m3 的父是 m2：两者都非根，也与根无关。
    const cyclic = doc([
      { id: 'm1', parentId: null, label: '根', itemIds: [A], kind: 'group' },
      { id: 'm2', parentId: 'm3', label: '甲', itemIds: [A], kind: 'note' },
      { id: 'm3', parentId: 'm2', label: '乙', itemIds: [B], kind: 'note' },
    ]);
    const result = validateMindmap(cyclic, { allowedItemIds: ALL });
    expect(result.ok).toBe(false);
    const cycleError = result.errors.find((error) => error.message.includes('环'));
    expect(cycleError).toBeDefined();
    // 报错必须点名节点，否则用户无法定位是哪几个分支。
    expect([...cycleError!.nodeIds].sort()).toEqual(['m2', 'm3']);
    expect(result.content).toBeUndefined();
  });

  it('T056-C01 纯环（没有根）与自指父节点都被拒绝', () => {
    const noRoot = doc([
      { id: 'm1', parentId: 'm2', label: '甲', itemIds: [A], kind: 'note' },
      { id: 'm2', parentId: 'm1', label: '乙', itemIds: [B], kind: 'note' },
    ]);
    const noRootResult = validateMindmap(noRoot, { allowedItemIds: ALL });
    expect(noRootResult.ok).toBe(false);
    expect(noRootResult.errors.some((error) => error.message.includes('没有根节点'))).toBe(true);

    const selfParent = doc([
      { id: 'm1', parentId: null, label: '根', itemIds: [A], kind: 'group' },
      { id: 'm2', parentId: 'm2', label: '自指', itemIds: [A], kind: 'note' },
    ]);
    const selfResult = validateMindmap(selfParent, { allowedItemIds: ALL });
    expect(selfResult.ok).toBe(false);
    expect(selfResult.errors.some((error) => error.message.includes('自己'))).toBe(true);
  });

  it('T056-C02 多个根被明确拒绝，不退化成其中一棵', () => {
    const twoRoots = doc([
      { id: 'm1', parentId: null, label: '根甲', itemIds: [A], kind: 'group' },
      { id: 'm2', parentId: null, label: '根乙', itemIds: [B], kind: 'group' },
      { id: 'm3', parentId: 'm1', label: '甲的子', itemIds: [A], kind: 'note' },
    ]);
    const result = validateMindmap(twoRoots, { allowedItemIds: ALL });
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.message.includes('2 个根节点'))).toBe(true);
    // 两个根都要被点名：只报一个会让"丢掉哪棵树"成为隐含选择。
    const rootError = result.errors.find((error) => error.message.includes('根节点'));
    expect([...rootError!.nodeIds].sort()).toEqual(['m1', 'm2']);
    expect(result.content).toBeUndefined();
  });

  it('T056-C03 悬空父节点与不可达子树都被拒绝', () => {
    const dangling = doc([
      { id: 'm1', parentId: null, label: '根', itemIds: [A], kind: 'group' },
      { id: 'm2', parentId: 'missing', label: '孤儿', itemIds: [A], kind: 'note' },
    ]);
    const danglingResult = validateMindmap(dangling, { allowedItemIds: ALL });
    expect(danglingResult.ok).toBe(false);
    expect(danglingResult.errors.some((error) => error.message.includes('父节点不存在'))).toBe(true);

    // 重复 id 会让"父节点存在"的检查指向错误的对象，必须先拦。
    const duplicate = doc([
      { id: 'm1', parentId: null, label: '根', itemIds: [A], kind: 'group' },
      { id: 'm2', parentId: 'm1', label: '甲', itemIds: [A], kind: 'note' },
      { id: 'm2', parentId: 'm1', label: '乙', itemIds: [B], kind: 'note' },
    ]);
    const duplicateResult = validateMindmap(duplicate, { allowedItemIds: ALL });
    expect(duplicateResult.ok).toBe(false);
    expect(duplicateResult.errors.some((error) => error.message.includes('id 重复'))).toBe(true);
  });

  it('T056-C04 标签里的图片与 HTML 按字面文字编译，不产生语法', () => {
    const inject = doc(
      [
        {
          id: 'm1',
          parentId: null,
          label: '<img src=x onerror=alert(1)>',
          itemIds: [A],
          kind: 'group',
        },
        {
          id: 'm2',
          parentId: 'm1',
          label: '![偷图](http://evil.example/x.png)',
          itemIds: [A],
          kind: 'note',
        },
        {
          id: 'm3',
          parentId: 'm1',
          label: '[点这里](javascript:alert(1)) 与 `代码`',
          itemIds: [B],
          kind: 'note',
        },
      ],
      '# 标题也被转义',
    );
    const { content } = ok(inject);
    const markdown = compileMindmap(content!);

    // 没有真正的图片或链接语法：方括号、圆括号、感叹号都被转义。
    expect(markdown).not.toMatch(/(?<!\\)!\[/u);
    expect(markdown).not.toMatch(/(?<!\\)\]\(/u);
    expect(markdown).toContain('\\!\\[偷图\\]\\(http://evil.example/x.png\\)');
    // HTML 的尖括号被转义，因此不会被当作标签解析。断言要针对"未转义的尖括号"，
    // 而不是子串 <img —— `\<img` 里同样含 <img，那会让测试失去意义。
    expect(markdown).not.toMatch(/(?<!\\)</u);
    expect(markdown).toContain('\\<img src=x onerror=alert\\(1\\)\\>');
    // 反引号不能开启代码片段。
    expect(markdown).toContain('\\`代码\\`');
    // # 在行内被转义，不会变成第二个标题。
    expect(markdown.split('\n').filter((line) => line.startsWith('# '))).toHaveLength(1);
    expect(markdown).toContain('\\# 标题也被转义');
  });

  it('T056-C04 换行与控制字符在被存进 AST 前就被规范为空格', () => {
    const multiline = doc([
      { id: 'm1', parentId: null, label: '根节点', itemIds: [A], kind: 'group' },
      { id: 'm2', parentId: 'm1', label: '第一行\n第二行', itemIds: [A], kind: 'note' },
      { id: 'm3', parentId: 'm1', label: '带\u0000控制符\t和制表符', itemIds: [B], kind: 'note' },
    ]);
    const { content } = ok(multiline);
    const labels = content!.nodes.map((node) => node.label);
    expect(labels).toEqual(['根节点', '第一行 第二行', '带 控制符 和制表符']);
    // 换行不再存在，所以列表结构不会被标签自己打断：每个标签仍只占一行。
    const markdown = compileMindmap(content!);
    expect(markdown.split('\n').filter((line) => line.includes('第一行'))).toEqual([
      '  - 第一行 第二行',
    ]);
  });

  it('T056-C05 深度 5 通过、6 被拒绝，起点从根算 1', () => {
    // 根为第 1 层，因此 5 层意味着最多 4 层子节点。
    const depthFive = doc([
      { id: 'n1', parentId: null, label: 'L1', itemIds: [A], kind: 'group' },
      { id: 'n2', parentId: 'n1', label: 'L2', itemIds: [A], kind: 'group' },
      { id: 'n3', parentId: 'n2', label: 'L3', itemIds: [A], kind: 'group' },
      { id: 'n4', parentId: 'n3', label: 'L4', itemIds: [A], kind: 'group' },
      { id: 'n5', parentId: 'n4', label: 'L5', itemIds: [A], kind: 'note' },
    ]);
    expect(validateMindmap(depthFive, { allowedItemIds: ALL }).ok).toBe(true);

    const depthSix = doc([
      ...depthFive.nodes,
      { id: 'n6', parentId: 'n5', label: 'L6', itemIds: [A], kind: 'note' },
    ]);
    const result = validateMindmap(depthSix, { allowedItemIds: ALL });
    expect(result.ok).toBe(false);
    const depthError = result.errors.find((error) => error.message.includes('层级超过'));
    expect(depthError).toBeDefined();
    // 只有真正越界的节点被点名，第 5 层仍然合法。
    expect(depthError!.nodeIds).toEqual(['n6']);
  });

  it('T056-C06 同一 AST 编译两次得到完全相同的 Markdown 与编译版本', () => {
    const { content } = ok(sampleTree());
    const first = compileMindmap(content!);
    const second = compileMindmap(content!);
    expect(first).toBe(second);
    expect(MINDMAP_COMPILER_VERSION).toMatch(/^mindmap-compiler-v\d+$/u);

    // 校验本身是确定性的：同一份输入重复校验得到逐字节相同的 AST 与 Markdown。
    // 兄弟顺序在 AST 数组里是显式的，所以不存在"靠对象遍历碰巧得到同一棵树"的
    // 空间 —— 这也正是 T056-R02 要求固定子节点顺序的原因。
    const again = ok(sampleTree());
    expect(again.content).toEqual(content);
    expect(compileMindmap(again.content!)).toBe(first);

    // 模型换了兄弟顺序，编译结果就要跟着变：顺序是信息，不能被规范化掉。
    const swapped = {
      title: content!.title,
      nodes: [content!.nodes[0]!, content!.nodes[2]!, content!.nodes[1]!],
    };
    const swappedMarkdown = compileMindmap(swapped);
    expect(swappedMarkdown.indexOf('自动化前提')).toBeLessThan(
      swappedMarkdown.indexOf('问题定义'),
    );
    expect(swappedMarkdown).not.toBe(first);

    // 编译产物是 AST 的纯函数：改标题只改标题那一行，其余部分不受影响。
    const renamed = compileMindmap({ ...content!, title: '另一个标题' });
    expect(renamed.split('\n').slice(2)).toEqual(first.split('\n').slice(2));
  });

  it('T056-R01 合法树被规范为广度优先顺序，兄弟保持模型顺序', () => {
    const { content } = ok(sampleTree());
    // 根在前，其后是它的子节点；顺序固定，不依赖 Map 遍历偶然顺序。
    expect(content!.nodes.map((node) => node.id)).toEqual(['m1', 'm2', 'm3']);
    // 标题用文档标题，根节点标签与标题不同，因此根也作为列表项出现一次，
    // 保证 AST 里每个节点在 Markdown 中都有对应位置（来源映射需要这个对应）。
    const markdown = compileMindmap(content!);
    expect(markdown).toBe(
      ['# 测试脑图', '', '- 需求与自动化', '  - 问题定义', '  - 自动化前提'].join('\n'),
    );
  });

  it('T056-R02 group 的来源由服务端按子树重算，模型声明被忽略', () => {
    // 根声明了 [A, B]，但子树实际只用到 A：模型在根挂了未使用的"假引用"。
    const lying = doc([
      { id: 'm1', parentId: null, label: '根', itemIds: [A, B, C], kind: 'group' },
      { id: 'm2', parentId: 'm1', label: '只用了甲', itemIds: [A], kind: 'note' },
    ]);
    const result = ok(lying);
    const root = result.content!.nodes.find((node) => node.id === 'm1')!;
    expect(root.itemIds).toEqual([A]);
    // 被纠正的节点要如实报告，不能悄悄改完当成功。
    expect(result.correctedNodeIds).toEqual(['m1']);
    // note 的来源保持模型原值（已在选择范围内）。
    expect(result.content!.nodes.find((node) => node.id === 'm2')!.itemIds).toEqual([A]);
  });

  it('T056-R02/R01 无来源的节点被拒绝，不会留下空分支', () => {
    // group 的子节点引用了范围外 id 时整份文档先被拒绝。
    const fabricated = doc([
      { id: 'm1', parentId: null, label: '根', itemIds: [A], kind: 'group' },
      {
        id: 'm2',
        parentId: 'm1',
        label: '凭空事实',
        itemIds: ['99999999-9999-4999-8999-999999999999'],
        kind: 'note',
      },
    ]);
    const unknown = validateMindmap(fabricated, { allowedItemIds: ALL });
    expect(unknown.ok).toBe(false);
    expect(unknown.errors.some((error) => error.message.includes('不在本次选择中'))).toBe(true);
  });

  it('T056-C01 超过 120 个节点在结构检查之前就被拒绝', () => {
    const nodes: MindmapOutput['nodes'] = [
      { id: 'r', parentId: null, label: '根', itemIds: [A], kind: 'group' },
    ];
    for (let index = 0; index < LIMITS.mindmapNodes; index += 1) {
      nodes.push({
        id: `n${index}`,
        parentId: 'r',
        label: `节点 ${index}`,
        itemIds: [A],
        kind: 'note',
      });
    }
    expect(nodes.length).toBe(LIMITS.mindmapNodes + 1);
    const result = validateMindmap(doc(nodes), { allowedItemIds: ALL });
    expect(result.ok).toBe(false);
    expect(result.errors[0]!.message).toContain(String(LIMITS.mindmapNodes));
  });

  it('T056-R03 转义是幂等可见的：原文标签不含反斜杠噪声', () => {
    // canonical AST 里保留的是转义前的标签，Markdown 才是衍生产物。
    const label = '带*星号*与_下划线_';
    expect(escapeMarkdownLabel(label)).toBe('带\\*星号\\*与\\_下划线\\_');
    // 反斜杠本身先被转义，所以转义结果不会自我放大。
    expect(escapeMarkdownLabel('反\\斜杠')).toBe('反\\\\斜杠');
    expect(normalizeLabel('  两端空白  ')).toBe('两端空白');
    expect(isLabelStable('两端空白')).toBe(true);
    expect(isLabelStable('带\n换行')).toBe(false);
    expect(isLabelStable('')).toBe(false);
  });

  it('group 可省略来源集合，由编译器从子树 note 归并', () => {
    const omitted = doc([
      { id: 'm1', parentId: null, label: '主题', itemIds: [], kind: 'group' },
      { id: 'm2', parentId: 'm1', label: '要点甲', itemIds: [A], kind: 'note' },
      { id: 'm3', parentId: 'm1', label: '要点乙', itemIds: [B], kind: 'note' },
    ]);
    const result = ok(omitted);
    const root = result.content!.nodes.find((node) => node.id === 'm1');
    expect(root?.itemIds.sort()).toEqual([A, B].sort());
    expect(result.correctedNodeIds).toContain('m1');
  });

  it('T056-R05 编译只使用标题与列表两种结构', () => {
    const { content } = ok(sampleTree());
    const markdown = compileMindmap(content!);
    for (const line of markdown.split('\n')) {
      if (line.length === 0) continue;
      const isHeading = /^# /u.test(line);
      const isListItem = /^(?: {2})*- /u.test(line);
      // 没有第三种结构：公式块、代码围栏、引用、表格、分割线都不在允许子集里。
      expect(isHeading || isListItem).toBe(true);
    }
  });

  /**
   * T056-C06 / T057-R01 的接口钉子。
   *
   * `mindmapMarkdownNodeIds` 存在的唯一理由是"每个 AST 节点都能被认出来是画布上的
   * 哪一个"，所以拿真实的 `Transformer` 比一次，比断言某个长度常量更能说明问题。
   *
   * 这里曾经漏掉位置 0：标题与根节点同名时，`# 标题` 就是 Markmap 的根，而当时
   * 的实现把这个根从 id 列表里省掉了。后果不是"少画一个节点"，而是渲染器把
   * Markmap 的根和第一个子节点配成一对 —— 点一个节点会打开另一个节点的来源，
   * 并且每个"根与标题同名"的正常脑图都会被判为结构不一致而拒绝绘制。
   *
   * 两种形态都要钉住，因为它们的配对偏移不同：
   *  - 同名：Markmap 的根就是 AST 根，逐位置对齐；
   *  - 不同名：Markmap 的根是标题合成的、不对应任何 AST 节点，因此多出恰好一个。
   */
  it('T056-C06/R01 节点 id 顺序与 Markmap 实际建出的树逐位置对应', () => {
    const transformer = new Transformer([]);

    function flatten(node: { children: unknown[] }, out: unknown[] = []): unknown[] {
      out.push(node);
      for (const child of node.children) flatten(child as { children: unknown[] }, out);
      return out;
    }

    const cases = [
      [
        '根与标题同名',
        doc(
          [
            { id: 'm1', parentId: null, label: '需求与自动化', itemIds: [A, B], kind: 'group' },
            { id: 'm2', parentId: 'm1', label: '问题定义', itemIds: [A], kind: 'note' },
            { id: 'm3', parentId: 'm1', label: '自动化前提', itemIds: [B], kind: 'note' },
          ],
          '需求与自动化',
        ),
        // 标题就是根：渲染节点数与 id 数相同。
        0,
      ],
      [
        '根与标题不同',
        doc(
          [
            { id: 'm1', parentId: null, label: '根节点', itemIds: [A, B], kind: 'group' },
            { id: 'm2', parentId: 'm1', label: '子甲', itemIds: [A], kind: 'note' },
            { id: 'm3', parentId: 'm2', label: '孙', itemIds: [B], kind: 'note' },
          ],
          '另一个标题',
        ),
        // 多出的那一个是标题合成的根，不属于 AST。
        1,
      ],
    ] as const;

    for (const [name, document, extraRenderedNodes] of cases) {
      const { content } = ok(document);
      const ids = mindmapMarkdownNodeIds(content!);
      const transformed = flatten(transformer.transform(compileMindmap(content!)).root as never);

      // 每个 AST 节点都有一个渲染位置，且只多出标题那个合成节点。
      expect(ids, `${name}：id 数应等于 AST 节点数`).toHaveLength(content!.nodes.length);
      expect(transformed, `${name}：渲染节点数与 id 数的差`).toHaveLength(
        ids.length + extraRenderedNodes,
      );
      // 最后一个 id 与最后一个渲染节点必须同时结束：偏移只能出现在头部。
      const lastNode = content!.nodes[content!.nodes.length - 1]!;
      expect(ids[ids.length - 1], `${name}：最后一个 id 应是最后一个 AST 节点`).toBe(lastNode.id);

      // 深度优先前序：父节点一定出现在它的子节点之前。
      const positionOf = new Map(ids.map((id, index) => [id, index]));
      for (const node of content!.nodes) {
        if (node.parentId === null) continue;
        expect(
          positionOf.get(node.parentId)!,
          `${name}：${node.id} 的父节点应排在其前面`,
        ).toBeLessThan(positionOf.get(node.id)!);
      }
    }
  });

  /**
   * T057-R06 的边界：结构检查通过不等于可以递归绘制。
   *
   * 深度上限只在入库校验时检查（`validateMindmap`），因此一条深链可以合法地存进
   * 数据库 —— 旧版本限制更宽、或行被手工修改都会这样。编译与 id 遍历都必须对任意
   * 有限深度保持可用，否则渲染阶段抛 RangeError 会把整页打空白，而 T057-C06 要求
   * 的是显示大纲与可读错误。
   */
  it('T057-R06 极深链条不会被结构检查放行后压垮编译器', () => {
    const nodes: MindmapOutput['nodes'] = [
      { id: 'n0', parentId: null, label: '根', itemIds: [A], kind: 'group' },
    ];
    const depth = 20_000;
    for (let index = 1; index < depth; index += 1) {
      nodes.push({
        id: `n${index}`,
        parentId: `n${index - 1}`,
        label: `第${index}层`,
        itemIds: [A],
        kind: 'note',
      });
    }

    const content = { title: '深链', nodes } as never;
    // 结构上是一棵完整的树：这正是不设深度上限的原因，它必须能被画出来。
    expect(inspectMindmapTree(content)).toEqual([]);
    // 递归实现在这里抛 RangeError；迭代实现必须完成。
    expect(() => compileMindmap(content)).not.toThrow();
    expect(mindmapMarkdownNodeIds(content)).toHaveLength(depth);
  });
});
