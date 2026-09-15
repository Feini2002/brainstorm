/**
 * T075-C05｜原文 URL：程序不抓取 sourceRef，也不抓取正文里的链接。
 *
 * 用例规格：`docs/05_tests/G6/T075_cases.md`。契约依据
 * `docs/03_contracts/03_dto_and_version_rules.md`：「sourceRef 默认 null，只是来源记录，
 * **不会自动抓取**」；规则 T075-R04「普通笔记中的 URL 永不自动抓取」。
 *
 * ## 为什么这一条需要单独证明
 *
 * 代码里**根本没有**抓取实现，所以「没有抓取」不会失败——这正是不写断言的理由反而
 * 更充分：一个不存在的行为，任何测试都发现不了它，除非测试盯住的是「进程有没有发出
 * 计划外的连接」。R06 要求的是「安全声明不超过实现」，因此这条必须给出**证据**，
 * 而不是引用「代码里没有」。
 *
 * 本文件用两层互补的证据：
 *
 *  1. **出站账本**：全局接管 `globalThis.fetch`，记录每一次调用。断言在「保存 → 整理
 *     → 浏览/搜索 → 生成图 → 生成视图 → 导出」整条链里，落到那些 URL 上的调用数为 0。
 *     整理与生成本来就要出站去模型，所以账本不能断言「零出站」，只能断言「出站目标
 *     里没有笔记里那个 URL」——这条区分才是真正要证明的。
 *
 *  2. **内核可见的源码扫描**：`globalThis.fetch` 不是唯一的出站方式（`node:http`、
 *     `undici`、动态 import 都能绕过），所以再扫 `src/` 里所有出站原语的落点。这条也
 *     必须**非空验证**：先断言扫描器确实在 `src/` 里找到了已知的出站点，否则「只有两
 *     个文件」可能只是正则写错了。
 *
 * ## 为什么不连真实外部域名
 *
 * 两个探针域名都是 `.invalid`（RFC 2606 保留，永不解析）。即使实现真的去抓，也只
 * 会得到解析失败，不可能真的访问别人的服务。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import type { LlmConfig } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import { OpenAICompatibleAdapter } from '@/server/llm/adapter';
import { callSnapshot } from '@/server/llm/types';
import type { Transport, TransportRequest, TransportResponse } from '@/server/llm/transport';
import { exportKnowledge } from '@/server/services/exportKnowledge';
import { generateFlow } from '@/server/services/generateFlow';
import { getGraphData } from '@/server/services/getGraphData';
import { getDatasetRevision } from '@/server/db/database';
import { createCapture, listItemsService, patchItem } from '@/server/services/items';
import { organizeItem } from '@/server/services/organizeItem';
import { createGraphView } from '@/server/services/views/views';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';

const projectRoot = path.resolve(import.meta.dirname, '../..');

/** Reserved-TLD hosts: a real fetch could only ever fail to resolve. */
const EXTERNAL_URL = 'https://notes-probe.invalid/article?utm=1';
const INTERNAL_URL = 'http://127.0.0.1:9/private-admin';
const LOOPBACK_URL = 'http://localhost:8080/internal-tool';

/** The subject of the capture: two URLs plus ordinary prose. */
const NOTE_TEXT = [
  '看到一篇讲专注的文章，链接是 ' + EXTERNAL_URL + ' 。',
  '同事还给了一个内网地址 ' + INTERNAL_URL + ' ，说里面是团队手册。',
  '本机的另一份材料：' + LOOPBACK_URL + ' 。',
  '核心观点是：先减少切换，再谈方法。',
].join('\n');

const SECRET = 'sk-test-URLPROBE-00000000000000000';

const CONFIG: LlmConfig = {
  adapter: 'openai-compatible',
  baseUrl: 'https://api.example.com/v1',
  model: 'test-model',
  structuredMode: 'prompt_json',
  tokenField: 'none',
  maxOutputTokens: 4096,
  schemaRepairEnabled: false,
};

/* ------------------------------------------------------------------ *
 * Outbound ledger
 * ------------------------------------------------------------------ */

interface FetchCall {
  url: string;
  method: string;
}

/**
 * Take over `globalThis.fetch` for the duration of a case.
 *
 * `node:sqlite` never uses fetch, and the adapter's own outbound call goes through
 * it too (via `FetchTransport` only when no transport is injected) — so the ledger
 * sees the model call as well as anything the app did not intend to send.
 */
class EgressLedger {
  readonly calls: FetchCall[] = [];
  private restore: (() => void) | null = null;

  install(): void {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // Arrow function, so `this` is the ledger rather than the call site — no
      // alias variable is needed (and an alias would trip the lint rule).
      this.calls.push({ url, method: init?.method ?? 'GET' });
      throw new Error(`ledger: 拦截了出站请求 ${url}`);
    }) as typeof fetch;
    this.restore = () => {
      globalThis.fetch = original;
    };
  }

  uninstall(): void {
    this.restore?.();
    this.restore = null;
  }

  /** Calls whose URL contains one of the probe URLs, matched on origin+path. */
  touching(url: string): FetchCall[] {
    const needle = new URL(url);
    return this.calls.filter((call) => {
      try {
        const seen = new URL(call.url);
        return seen.hostname === needle.hostname && seen.pathname === needle.pathname;
      } catch {
        return call.url.includes(url);
      }
    });
  }

  /** Calls to a host that is not the configured model endpoint. */
  offEndpoint(baseUrl: string): FetchCall[] {
    const allowed = new URL(baseUrl).hostname;
    return this.calls.filter((call) => {
      try {
        return new URL(call.url).hostname !== allowed;
      } catch {
        return true;
      }
    });
  }
}

/**
 * A transport that answers locally so the organize/generate legs run to completion.
 *
 * Injected on purpose: the ledger's job is to catch calls the adapter makes, and the
 * adapter goes through this transport, so the transport itself never touches the
 * global. That keeps the ledger's "zero off-endpoint calls" assertion meaningful
 * instead of trivially satisfied by the fixture.
 */
class LocalTransport implements Transport {
  calls = 0;
  readonly urls: string[] = [];

  constructor(private readonly content: string) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    this.calls += 1;
    this.urls.push(request.url);
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      bodyText: JSON.stringify({
        choices: [{ message: { role: 'assistant', content: this.content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
      }),
    };
  }
}

function organizeEnvelope(): string {
  return JSON.stringify({
    title: '专注与切换成本',
    summary: '围绕减少任务切换的笔记。',
    type: 'idea',
    tags: ['专注', '效率'],
    keywords: ['切换成本', '专注'],
    importance: 3,
    relations: [],
  });
}

/**
 * A flow document citing the given item, in the shape `generateFlow` validates.
 *
 * The keys are `label`/`kind`/`direction`, not `title`/`relationType`: the
 * projection schema is its own contract, and a fixture that guessed the item
 * shape would be testing a rejection rather than the no-fetch property.
 */
function flowEnvelope(itemId: string): string {
  return JSON.stringify({
    title: '专注与效率',
    direction: 'LR',
    nodes: [
      { id: 'f1', label: '专注', itemIds: [itemId] },
      { id: 'f2', label: '效率', itemIds: [itemId] },
    ],
    edges: [
      {
        source: 'f1',
        target: 'f2',
        kind: 'sequence',
        label: '先减少切换，再谈效率',
        itemIds: [itemId],
        relationIds: [],
      },
    ],
  });
}

let test: TestDatabase;
let db: DatabaseSync;
let ledger: EgressLedger;

beforeEach(() => {
  test = createTestDatabase();
  db = openTestDatabase(test.databasePath);
  ledger = new EgressLedger();
  ledger.install();
});

afterEach(() => {
  ledger.uninstall();
  test.cleanup();
});

/** Capture a note whose text and sourceRef both contain URLs. */
function captureWithUrls() {
  return createCapture(db, {
    captureRequestId: newId(),
    rawText: NOTE_TEXT,
    sourceType: 'other',
    sourceRef: EXTERNAL_URL,
  }).item;
}

describe('T075-C05 保存与浏览不抓取正文或 sourceRef 里的 URL', () => {
  it('T075-C05 保存含两个内网地址的原文不发出任何请求', () => {
    const item = captureWithUrls();

    // 原文按原样入库，URL 只是文本。
    expect(item.rawText).toBe(NOTE_TEXT);
    expect(item.sourceRef).toBe(EXTERNAL_URL);
    expect(ledger.touching(EXTERNAL_URL)).toEqual([]);
    expect(ledger.touching(INTERNAL_URL)).toEqual([]);
    expect(ledger.touching(LOOPBACK_URL)).toEqual([]);
    // 保存是纯本地动作，连模型端点都不该碰。
    expect(ledger.calls, '保存不应有任何出站请求').toEqual([]);
  });

  it('T075-C05 列表与搜索命中含 URL 的原文时也不抓取', () => {
    captureWithUrls();

    const listed = listItemsService(db, {
      filters: {},
      sort: 'newest',
      limit: LIMITS.listPageSizeDefault,
    });
    const searched = listItemsService(db, {
      filters: { q: '专用手册?/private' },
      sort: 'newest',
      limit: LIMITS.listPageSizeDefault,
    });
    const byHost = listItemsService(db, {
      filters: { q: 'notes-probe.invalid' },
      sort: 'newest',
      limit: LIMITS.listPageSizeDefault,
    });

    expect(listed.items).toHaveLength(1);
    // 搜索把 URL 当普通文本匹配，不需要也不应该去访问它。
    expect(byHost.items).toHaveLength(1);
    expect(searched.items.length).toBeGreaterThanOrEqual(0);

    expect(ledger.calls, '浏览与搜索都必须是纯本地查询').toEqual([]);
    expect(ledger.touching(EXTERNAL_URL)).toEqual([]);
    expect(ledger.touching(INTERNAL_URL)).toEqual([]);
  });

  it('T075-C05 编辑原文与 sourceRef 为新 URL 时也不抓取', () => {
    const item = captureWithUrls();
    const newUrl = 'https://another-probe.invalid/page';

    const updated = patchItem(db, {
      id: item.id,
      expectedRevision: item.revision,
      patch: {
        title: '改过的标题',
        rawText: `换一个链接 ${newUrl} 继续记。`,
        sourceRef: INTERNAL_URL,
      },
    });

    expect(updated.sourceRef).toBe(INTERNAL_URL);
    expect(ledger.calls).toEqual([]);
    expect(ledger.touching(newUrl)).toEqual([]);
    expect(ledger.touching(INTERNAL_URL)).toEqual([]);
  });
});

describe('T075-C05 整理与生成只访问模型端点，不访问笔记里的 URL', () => {
  it('T075-C05 整理含 URL 的笔记：出站只到模型端点', async () => {
    const item = captureWithUrls();
    const transport = new LocalTransport(organizeEnvelope());

    const result = await organizeItem(db, {
      requestKey: newId(),
      itemId: item.id,
      expectedRevision: item.revision,
      config: callSnapshot(CONFIG, SECRET),
      configRevision: 1,
      schemaRepairEnabled: false,
      adapter: new OpenAICompatibleAdapter(transport),
    });

    // 整理确实发生了，而且确实出站过一次——不是「因为没跑」才没有抓取。
    expect(transport.calls).toBe(1);
    expect(result.item).not.toBeNull();
    expect(result.item?.title).toBe('专注与切换成本');

    // 出站的那一次去的是配置的端点，不是笔记里的任何地址。
    expect(transport.urls).toEqual([`${CONFIG.baseUrl}/chat/completions`]);
    expect(ledger.touching(EXTERNAL_URL)).toEqual([]);
    expect(ledger.touching(INTERNAL_URL)).toEqual([]);
    expect(ledger.touching(LOOPBACK_URL)).toEqual([]);

    // 请求体是提示词，但模型端点收到 URL 文本不等于程序抓取了它；这里断言的是
    // 「没有第二个出站目标」，也就是没有把 URL 变成指令去访问。
    expect(ledger.offEndpoint(CONFIG.baseUrl)).toEqual([]);
  });

  it('T075-C05 生成图同样只到模型端点，不跟着原文 URL 走', async () => {
    const item = captureWithUrls();
    const transport = new LocalTransport(flowEnvelope(item.id));

    const outcome = await generateFlow(db, {
      requestKey: newId(),
      selection: { mode: 'explicit', itemIds: [item.id] },
      intent: '看这些材料之间的先后和依赖',
      direction: 'LR',
      config: callSnapshot(CONFIG, SECRET),
      configRevision: 1,
      schemaRepairEnabled: false,
      adapter: new OpenAICompatibleAdapter(transport),
    });

    expect(transport.calls).toBe(1);
    expect(outcome).toBeDefined();
    expect(ledger.offEndpoint(CONFIG.baseUrl)).toEqual([]);
    expect(ledger.touching(EXTERNAL_URL)).toEqual([]);
    expect(ledger.touching(INTERNAL_URL)).toEqual([]);
  });

  it('T075-C05 读图数据与导出含 URL 的原文时都是纯本地操作', () => {
    const item = captureWithUrls();

    const graph = getGraphData(
      db,
      { filter: {}, itemIds: [item.id] },
      getDatasetRevision(db),
    );
    expect(graph.nodes.length).toBeGreaterThan(0);

    const exported = exportKnowledge(db);
    expect(exported).toBeDefined();
    const serialized = JSON.stringify(exported);
    // 导出里带着 URL 字符串（那是用户的原文），但它不触发任何访问。
    expect(serialized).toContain('notes-probe.invalid');
    expect(ledger.calls, '读图与导出都不应出站').toEqual([]);
    expect(ledger.touching(EXTERNAL_URL)).toEqual([]);
    expect(ledger.touching(INTERNAL_URL)).toEqual([]);
  });

  it('T075-C05 创建视图时不访问原文里的内网地址', () => {
    const item = captureWithUrls();
    const view = createGraphView(db, {
      name: '专注视图',
      selection: { mode: 'explicit', itemIds: [item.id] },
      positions: {},
      direction: 'LR',
    });

    expect(view.name).toBe('专注视图');
    expect(ledger.calls).toEqual([]);
    expect(ledger.touching(INTERNAL_URL)).toEqual([]);
  });
});

describe('T075-C05 出站原语的落点（源码扫描）', () => {
  const OUTBOUND_PATTERN =
    /(?<![\w.])fetch\s*\(|\brequire\(\s*['"]node:(https?|net|tls)['"]|from\s+['"]node:(https?|net|tls)['"]|from\s+['"](undici|axios|got|node-fetch|superagent|request)['"]/u;

  function sourceFiles(): string[] {
    const files: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/u.test(entry)) files.push(full);
      }
    };
    walk(path.join(projectRoot, 'src'));
    return files;
  }

  /**
   * Which lines make an outbound connection, and to where.
   *
   * A file counts as an egress point when it names an outbound primitive. The
   * adapter and the browser client get their destination from settings / an API
   * path; nothing here reads a URL out of an item.
   */
  function egressPoints(): { file: string; line: number; text: string }[] {
    const found: { file: string; line: number; text: string }[] = [];
    for (const file of sourceFiles()) {
      const lines = readFileSync(file, 'utf8').split(/\r?\n/u);
      lines.forEach((text, index) => {
        if (OUTBOUND_PATTERN.test(text)) {
          found.push({ file: path.relative(projectRoot, file).replaceAll('\\', '/'), line: index + 1, text: text.trim() });
        }
      });
    }
    return found;
  }

  it('T075-C05 扫描器本身有效：它在 src 里确实找到了已知的出站点', () => {
    const points = egressPoints();
    const files = new Set(points.map((point) => point.file));

    // 非空验证：如果正则写错或路径变了，这条会先失败，而不是让下面几条恒真通过。
    expect(points.length).toBeGreaterThan(0);
    expect(files.has('src/server/llm/transport.ts')).toBe(true);
    expect(files.has('src/features/shared/apiClient.ts')).toBe(true);
  });

  it('T075-C05 出站点只有两处，且都不是「拿 URL 去请求」', () => {
    const points = egressPoints();
    const byFile = new Map<string, { line: number; text: string }[]>();
    for (const point of points) {
      const list = byFile.get(point.file) ?? [];
      list.push({ line: point.line, text: point.text });
      byFile.set(point.file, list);
    }

    // 允许的出站面：生产传输（目标来自设置里的 Base URL）与浏览器 API 客户端
    // （目标由调用方给出的 /api/* 路径拼成）。
    expect([...byFile.keys()].sort()).toEqual([
      'src/features/shared/apiClient.ts',
      'src/server/llm/transport.ts',
    ]);

    // 关键否定断言：任何出站点都不吃 item / sourceRef / 笔记字段。
    for (const point of points) {
      expect(point.text, `${point.file}:${point.line} 似乎拿笔记字段去请求`).not.toMatch(
        /sourceRef|rawText|itemRaw|noteId|capturedText/iu,
      );
    }
  });

  it('T075-C05 服务层没有把 item 的 URL 交给任何抓取或摘要工具', () => {
    const serviceFiles: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/u.test(entry)) serviceFiles.push(full);
      }
    };
    walk(path.join(projectRoot, 'src/server/services'));
    expect(serviceFiles.length).toBeGreaterThan(10);

    const offenders: string[] = [];
    for (const file of serviceFiles) {
      const source = readFileSync(file, 'utf8');
      // 抓取/摘要类原语，以及「把 sourceRef 当请求目标」的写法。
      if (/(fetch|request|download|scrape|crawl)\s*\(\s*[^)]*sourceRef/iu.test(source)) {
        offenders.push(`${path.relative(projectRoot, file)}: 用 sourceRef 发起请求`);
      }
      if (/\bnew\s+URL\s*\(\s*sourceRef/iu.test(source)) {
        offenders.push(`${path.relative(projectRoot, file)}: 把 sourceRef 解析成 URL 目标`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
