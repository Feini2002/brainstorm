/**
 * T064 验收：受限 Flow 到 Mermaid 编译器。
 *
 * 六个具名场景各自对应一类"看起来能画出来、其实画错了"的失败：注入、特殊字符、
 * 恶意临时 ID、推测被画成事实、重复箭头、以及不可复现。全部是纯函数调用，因为
 * 编译器按契约不访问数据库、浏览器或模型（T064-R06）。
 *
 * 关于"解析"：Mermaid 的解析器依赖 DOM（Node 运行时里 `DOMPurify.addHook` 不是
 * 函数），所以服务端无法用 `mermaid.parse` 自证语法。这里改用编译器自己的白名单
 * 模板检查 `assertFlowchartSource`，它是同一个谓词的复用，并且在标签位置上要求
 * `[^"]*` —— 转义函数已经移除了所有原始引号，因此"标签不可能提前结束字符串"是
 * 可以被断言的，而不是靠观察。
 */
import { describe, expect, it } from 'vitest';

import {
  FLOW_COMPILER_VERSION,
  FLOW_EDGE_STYLES,
  arrowFor,
  assertFlowchartSource,
  compileFlow,
  escapeFlowLabel,
  labelForKind,
  normalizeFlowLabel,
} from '@/domain/compileFlow';
import type { FlowContent, FlowEdge, FlowNode } from '@/domain/knowledge';
import { inspectFlow, flowReferencedItemIds } from '@/domain/validateFlow';
import { LIMITS } from '@/domain/limits';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

function node(id: string, label: string, itemIds: string[] = [A]): FlowNode {
  return { id, label, itemIds };
}

function edge(
  source: string,
  target: string,
  kind: FlowEdge['kind'],
  label: string,
  itemIds: string[] = [A],
  relationIds: string[] = [],
): FlowEdge {
  return { source, target, kind, label, itemIds, relationIds };
}

function flow(
  nodes: FlowNode[],
  edges: FlowEdge[] = [],
  direction: 'LR' | 'TB' = 'LR',
  title = '测试流程',
): FlowContent {
  return { title, direction, nodes, edges };
}

/** Compile and fail loudly, so a refusal reads as the expected value in the diff. */
function compile(content: FlowContent) {
  const result = compileFlow(content);
  if (!result.ok) {
    throw new Error(`预期编译成功，实际拒绝：${result.issues.map((i) => i.message).join('；')}`);
  }
  return result.compiled;
}

/**
 * Reverse `escapeFlowLabel` for a human-readable assertion.
 *
 * The inverse is written here rather than exported from the compiler: the compiler
 * must have no decode path (nothing in the product reads the source back), and
 * exporting one would invite a future caller to treat the source as data.
 *
 * It covers exactly the four substitutions `LABEL_ENTITIES` can make. The
 * fullwidth quote is included because it is the substituted form of `"` — and
 * that substitution is *lossy in shape but not in meaning*: the browser draws
 * `＂`, which is legible, whereas the entity forms (`&quot;`, `#quot;`, `#34;`)
 * were measured to reach the screen as their own text.
 */
function decode(text: string): string {
  return text
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/\uff02/gu, '"');
}

/**
 * The zero-width space the compiler uses to keep `direction` from being read as a
 * statement. Written as an escape here so it is visible in a diff.
 */
const ZWSP = '\u200b';

describe('T064 Flow 到 Mermaid 编译器', () => {
  it('T064-C01 指令注入：click、init、外链都只是被转义的标签文字', () => {
    const content = flow(
      [
        node('a', '第一步 click A href "http://evil.example"'),
        node('b', '第二步：```mermaid\nflowchart LR\n  init: {securityLevel: loose}\n```'),
      ],
      [edge('a', 'b', 'sequence', '然后 click')],
    );
    const compiled = compile(content);

    // 语法结构只由编译器控制：没有任何指令行出现在独立位置。
    expect(compiled.source.startsWith('flowchart LR\n')).toBe(true);
    expect(assertFlowchartSource(compiled.source)).toEqual([]);

    // 每一行都必须匹配白名单模板，换句话说 line 级已经没有"指令"这一形态。
    for (const line of compiled.source.split('\n').slice(1)) {
      expect(line).toMatch(/^ {2}N\d+(\["[^"]*"\]| (?:-->|-\.->)\|"[^"]*"\| N\d+)$/u);
    }

    // 关键词仍然作为可读文字存在，只是被限制在引号里（不是粗暴黑名单）。
    const decoded = decode(compiled.source);
    expect(decoded).toContain('click');
    expect(decoded).toContain('href');
    expect(decoded).toContain('securityLevel');
    // 而原本用来闭合标签的引号已被换成全角引号，它没有机会成为语法边界。
    expect(compiled.source).toContain('\uff02');
    // 逐行看：每行恰好两个半角引号 —— 一对定界符，标签内部没有多余的引号。
    for (const line of compiled.source.split('\n').slice(1)) {
      expect([...line].filter((character) => character === '"')).toHaveLength(2);
    }

    // 不出现 init / classDef / style / linkStyle / subgraph / click 指令形态。
    expect(compiled.source).not.toMatch(/^\s*(init|click|classDef|style|linkStyle|subgraph)\b/mu);
  });

  it('T064-C02 引号括号：中文标签被转义后仍可辨认，且语法合法', () => {
    const label = '需求（第一版）"正式"：用 [方括号] 与 {花括号}；还有 # 和 &';
    const compiled = compile(flow([node('a', label)]));
    const line = compiled.source.split('\n')[1]!;

    expect(assertFlowchartSource(compiled.source)).toEqual([]);
    expect(line).toMatch(/^ {2}N0\["[^"]*"\]$/u);
    // 反转义后与规范化后的原文一致 —— 文字没有被吃掉，只是被替换成等价写法。
    expect(decode(line.slice(line.indexOf('"') + 1, -2))).toBe(normalizeFlowLabel(label));

    // 未转义的原文绝不能直接出现在源码里（那才是注入面）。
    expect(compiled.source).not.toContain('"正式"');
    // 中文全角括号、方括号、花括号、井号都保持原样：它们在引号内无害，而且实测
    // 会被原样画出。半角 `&` 是唯一必须替换的普通标点 —— 它是实体的起始字符，
    // 不替换的话笔记里字面写下的 `&lt;` 会被 Mermaid 解码成一个真的 `<`。
    expect(compiled.source).toContain('（第一版）');
    expect(compiled.source).toContain('[方括号]');
    expect(compiled.source).toContain('{花括号}');
    expect(compiled.source).toContain('# 和 &amp;');
    // 旧的 `#NN;` 写法是死文本：实测屏幕上就显示成 `&#40;`，所以不能再出现。
    expect(compiled.source).not.toContain('#40;');
    expect(compiled.source).not.toContain('#91;');
    expect(compiled.source).not.toContain('#35;');
  });

  it('T064-C02 换行与控制字符被折成一行，不会把标签变成第二行语法', () => {
    const compiled = compile(flow([node('a', '第一行\nflowchart TB\n第三行\u0000')]));
    const lines = compiled.source.split('\n');
    // 恰好一行头部 + 一行节点：换行没有制造出额外行。
    expect(lines).toHaveLength(2);
    expect(normalizeFlowLabel('第一行\nflowchart TB\n第三行\u0000')).toBe('第一行 flowchart TB 第三行');
  });

  it('T064-C03 恶意临时 ID：模型 id 被换成受控 N0/N1，且不进入语法', () => {
    const hostile = 'n1"] --> evil["x';
    const content = flow([node(hostile, '恶意 id 节点'), node('normal', '正常节点')]);
    const compiled = compile(content);

    // 映射表保留了原 id（可审查），但它只作为数据出现。
    expect(compiled.nodeIdMap[hostile]).toBe('N0');
    expect(compiled.nodeIdMap['normal']).toBe('N1');
    expect(compiled.nodes[0]!.nodeId).toBe(hostile);

    // 语法里只有受控 id；恶意字符串一次都没有出现在源码中。
    expect(compiled.source).not.toContain('evil');
    expect(compiled.source).not.toContain('] -->');
    const ids = [...compiled.source.matchAll(/\bN\d+\b/gu)].map((match) => match[0]);
    expect(new Set(ids)).toEqual(new Set(['N0', 'N1']));
    expect(assertFlowchartSource(compiled.source)).toEqual([]);
  });

  it('T064-C04 推测样式：hypothesis 用虚线并写明推测，关联不伪装因果', () => {
    const content = flow(
      [node('a', '甲'), node('b', '乙'), node('c', '丙')],
      [
        edge('a', 'b', 'hypothesis', '可能要先做甲'),
        edge('b', 'c', 'association', '两件事常一起出现'),
      ],
    );
    const compiled = compile(content);

    const hypothesis = compiled.edges.find((entry) => entry.kind === 'hypothesis')!;
    const association = compiled.edges.find((entry) => entry.kind === 'association')!;

    expect(hypothesis.displayLabel.startsWith('推测：')).toBe(true);
    expect(association.displayLabel.startsWith('相关：')).toBe(true);

    // 线型来自唯一的样式表，且推测是虚线。
    expect(FLOW_EDGE_STYLES.hypothesis.line).toBe('dashed');
    expect(arrowFor('hypothesis')).toBe('-.->');
    expect(arrowFor('association')).toBe('-->');
    expect(compiled.source).toContain('-.->');
    expect(compiled.source).toContain('-->');
    // 推测那条边不可能出现在实线模板里。
    const lines = compiled.source.split('\n');
    const dashedLine = lines.find((line) => line.includes('-.->'))!;
    expect(decode(dashedLine)).toContain('推测：');

    // 图例只列出实际出现的类型，并且说的话来自样式表而不是组件自己编。
    expect(compiled.legend.map((entry) => entry.kind)).toEqual(['association', 'hypothesis']);
    expect(compiled.legend.find((entry) => entry.kind === 'hypothesis')!.prefix).toBe('推测：');
  });

  it('T064-C04 已经带着「推测」字样的标签不会被重复加前缀', () => {
    expect(labelForKind('hypothesis', '推测：材料不足')).toBe('推测：材料不足');
    expect(labelForKind('hypothesis', '建议再确认')).toBe('建议再确认');
    expect(labelForKind('hypothesis', '可能要先做甲')).toBe('推测：可能要先做甲');
    // 其他类型总是加上自己的词，因为箭头本身不会说明关系。
    expect(labelForKind('association', '相关：常一起出现')).toBe('相关：常一起出现');
    expect(labelForKind('causal', '甲导致乙')).toBe('因果：甲导致乙');
  });

  it('T064-C05 重复边被规范化：同一 source/target/kind/label 只画一次', () => {
    const content = flow(
      [node('a', '甲'), node('b', '乙')],
      [
        edge('a', 'b', 'sequence', '然后', [A]),
        // 完全重复，但来源不同：仍然只有一条箭头，否则会被读成两条关系。
        edge('a', 'b', 'sequence', '然后', [B]),
        // 说明不同，是另一种关系，必须保留。
        edge('a', 'b', 'sequence', '同时', [A]),
      ],
    );
    const compiled = compile(content);

    expect(compiled.edges).toHaveLength(2);
    expect(compiled.droppedDuplicateEdges).toBe(1);
    const arrows = compiled.source.split('\n').filter((line) => line.includes('-->'));
    expect(arrows).toHaveLength(2);
  });

  it('T064-C05 有依据的环被保留：不为了变成 DAG 删掉用户的材料', () => {
    const content = flow(
      [node('a', '甲'), node('b', '乙')],
      [edge('a', 'b', 'dependency', '甲是乙的前提'), edge('b', 'a', 'sequence', '乙完成后回到甲')],
    );
    const compiled = compile(content);
    expect(compiled.edges).toHaveLength(2);
    expect(assertFlowchartSource(compiled.source)).toEqual([]);
  });

  it('T064-C06 确定性：同一内容多次编译得到完全一致的源码', () => {
    const content = flow(
      [node('a', '甲'), node('b', '乙'), node('c', '丙')],
      [edge('a', 'b', 'sequence', '然后'), edge('b', 'c', 'hypothesis', '可能')],
      'TB',
    );
    const first = compile(content);
    const second = compile(content);
    expect(first.source).toBe(second.source);
    expect(second.compilerVersion).toBe(FLOW_COMPILER_VERSION);
    // 编译版本是唯一的"可变"字段，且它不写进源码。
    expect(first.source).not.toContain(FLOW_COMPILER_VERSION);
    expect(first.source.split('\n')[0]).toBe('flowchart TB');
  });

  it('T064-R02 第一行只能是 flowchart LR 或 TB，方向非法时按契约回退到 LR', () => {
    for (const direction of ['LR', 'TB'] as const) {
      const compiled = compile(flow([node('a', '甲')], [], direction));
      expect(compiled.source.split('\n')[0]).toBe(`flowchart ${direction}`);
    }
    // 手工写入的方向不是枚举值时，不把它拼进语法。
    const bad = compile(flow([node('a', '甲')], [], 'RL' as unknown as 'LR'));
    expect(bad.source.split('\n')[0]).toBe('flowchart LR');
  });

  it('T064-C03/来源校验拒绝悬空端点与自环，而不是让 Mermaid 补节点', () => {
    const dangling = flow([node('a', '甲')], [edge('a', 'ghost', 'sequence', '然后')]);
    const result = compileFlow(dangling);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.message).join('；')).toContain('端点');

    const selfLoop = flow([node('a', '甲')], [edge('a', 'a', 'sequence', '自己')]);
    expect(inspectFlow(selfLoop).map((issue) => issue.message).join('；')).toContain('自己');
  });

  it('T064 结构检查拒绝重复 id 与超限，并说明原因', () => {
    const duplicated = flow([node('a', '甲'), node('a', '乙')]);
    const issues = inspectFlow(duplicated);
    expect(issues[0]!.message).toContain('重复');

    const tooMany = flow(
      Array.from({ length: LIMITS.flowNodes + 1 }, (_, index) => node(`n${index}`, `节点 ${index}`)),
    );
    expect(inspectFlow(tooMany).map((issue) => issue.message).join('；')).toContain(
      String(LIMITS.flowNodes),
    );
  });

  it('T064 编译源码自带节点声明，引用检查能发现未声明的端点', () => {
    expect(
      assertFlowchartSource('flowchart LR\n  N0["甲"]\n  N1 -->|"顺序：然后"| N2'),
    ).toContain('第 3 行引用了没有声明的节点 N1');
    // 头部不对时立即停止，不逐行报错。
    expect(assertFlowchartSource('graph TD\n  N0["甲"]')).toHaveLength(1);
    // 多余指令一律被拒。
    expect(assertFlowchartSource('flowchart LR\n  N0["甲"]\n  click N0 "http://evil"')).toHaveLength(1);
  });

  it('T064-R03 转义是单次字符映射，一次调用里不会二次改写自己的产物', () => {
    const once = escapeFlowLabel('a"b[c]&d<e');
    expect(once).toBe('a\uff02b[c]&amp;d&lt;e');
    // 关键性质：一次调用只走一遍字符映射。`&lt;` 的 `&` 不会在**同一次**调用里再被
    // 换成 `&amp;lt;` —— 否则源码会长出越转义越长的实体链。引号用的是可见全角写法，
    // 没有 `&` 参与，所以也不会被 `&` 那条规则碰到。
    expect(once).not.toContain('&amp;amp;');
    expect([...once].filter((character) => character === '&')).toHaveLength(2);
    // 转义只对 canonical 原文执行一次。对已转义文本再转一次会把 `&amp;` 变成
    // `&amp;amp;` —— 这正是产品里**不存在**的调用路径，所以这里明确记下：不要那样用。
    expect(escapeFlowLabel(once)).toBe('a\uff02b[c]&amp;amp;d&amp;lt;e');
    expect(escapeFlowLabel('')).toBe('');
  });

  it('T064-R03 编译源码里不出现 `#NN;` 这种死文本（屏幕实测）', () => {
    // 这是本文件里最重要的一条实测结论：Mermaid 的渲染管线只把 `#<词>;` 重写成
    // `&#<词>;`，随后由浏览器解码。所以**不带 `&`** 的 `#NN;` 会原样留在屏幕上，
    // 用户读到的是 `&#60;img…&#62;` 而不是笔记里的句子（真实 Chromium 实测）。
    const compiled = compile(flow([node('a', '<img src=x onerror=alert(1)> 与 "引号"')]));
    const source = compiled.source;
    // 源码里不允许出现任何 `#NN;` 形态的转义。
    expect(source).not.toMatch(/#\d+;/u);
    // 尖括号与 `&` 用可解码实体，因此画出来就是原文。
    expect(source).toContain('&lt;img src=x onerror=alert(1)&gt;');
    // 引号换成可见的全角写法（它没有可用实体），半角定界符仍恰好一对。
    expect(source).toContain('\uff02引号\uff02');
    const body = source.split('\n')[1]!;
    expect([...body].filter((character) => character === '"')).toHaveLength(2);
    expect(assertFlowchartSource(source)).toEqual([]);
  });

  it('T064-R03 只编码真正能改变解析的字符，其余保持可读原文', () => {
    // 这四个字符各自都有实测依据：`&` 是实体起始、`<` `>` 会被当成 HTML、`"` 会
    // 闭合标签（且它没有可用实体，只能换成全角）。其余标点留在源码里，因为实测
    // 它们既安全、又能被原样画出；编码它们只会把 `&#40;` 这类死文本挂到用户眼前。
    expect(escapeFlowLabel('A"B\\C<D>E&F')).toBe('A\uff02B\\C&lt;D&gt;E&amp;F');
    for (const harmless of ['#', ';', '[', ']', '(', ')', '{', '}', '|', '`', "'", '%', '$']) {
      expect(escapeFlowLabel(`甲${harmless}乙`)).toBe(`甲${harmless}乙`);
    }
    // 笔记里字面写下的 `&lt;` 必须变成 `&amp;lt;`：否则 Mermaid 会把它解码成一个
    // 真的 `<`，也就是一段笔记变成了标记。
    expect(escapeFlowLabel('A&lt;script&gt;B')).toBe('A&amp;lt;script&amp;gt;B');
    // 空白折叠与首尾裁剪不受影响，换行不会把标签变成第二行语法。
    expect(escapeFlowLabel('  甲 \n 乙  ')).toBe('甲 乙');
  });

  it('T064-R04 direction 关键词不会吞掉节点，但读起来仍是原文', () => {
    // 实测缺陷：节点标签为 `direction TB` 时，Mermaid 把它当成语句执行，
    // 结果这个节点从图上消失了。编译器在词与参数之间插入不可见的零宽空格。
    const compiled = compile(flow([node('a', 'direction TB'), node('b', '乙')]));
    expect(compiled.source.split('\n')).toHaveLength(3);
    expect(compiled.source).toContain(`direction${ZWSP} TB`);
    // 节点声明仍然只占一行，且没有第二个 `flowchart` 头。
    expect([...compiled.source.matchAll(/^ {2}N\d+\[/gmu)]).toHaveLength(2);

    // 出现在句子中间时同样处理；大小写不同的普通词不受影响。
    expect(escapeFlowLabel('先 direction LR 再继续')).toBe(`先 direction${ZWSP} LR 再继续`);
    expect(escapeFlowLabel('Direction TB')).toBe('Direction TB');
    expect(escapeFlowLabel('direction 待定')).toBe('direction 待定');
  });

  it('T064 引用清单来自节点与边，供来源快照使用', () => {
    const content = flow(
      [node('a', '甲', [A]), node('b', '乙', [B])],
      [edge('a', 'b', 'sequence', '然后', [A, B])],
    );
    expect(flowReferencedItemIds(content)).toEqual([A, B]);
  });
});
