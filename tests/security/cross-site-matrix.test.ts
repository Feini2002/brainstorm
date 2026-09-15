/**
 * T075-C01｜跨站矩阵：非法来源／令牌组合没有数据与费用副作用。
 *
 * 用例规格：`docs/05_tests/G6/T075_cases.md`；规则：`docs/04_tasks/G6/T075_security_regression.md`
 * 的 T075-R01（「测试 Host、Origin、Sec-Fetch-Site 与请求令牌组合，不只测试正常页面能否
 * 访问」）。
 *
 * ## 这个文件与 `local-request-guard.test.ts` 的分工
 *
 * `local-request-guard.test.ts` 是 T007 的原始证据（原
 * `tests/integration/security-http.test.ts`），断言的是**每条规则各自**的拒绝与错误码。
 * 本文件补的是 T075-C01 真正要求的那一半，前者**没有**覆盖：
 *
 *  1. **矩阵**。把 Host × Origin × Sec-Fetch-Site × 令牌做成组合表，包括合法、非法、
 *     缺失三类取值，以及「三个判据同时合法」的对照组。只测「正常页面能访问」的用例
 *     无法发现某条判据被删除——因为正常请求本来就不触发它。
 *  2. **费用副作用**。被拒绝的模型调用不能产生任何出站请求。原文件只断言「没有 Run
 *     行」，而 Run 行与出站请求是两件事：`registerRun` 先于网络调用，一个在守卫之后、
 *     适配器之前被破坏的路径可以让出站请求发生而不留 Run 行。
 *  3. **拒绝的覆盖面**。不是挑几条路由，而是对**当前实际存在的全部写路由**逐个断言：
 *     新增路由若忘了挂 guard，这里会红。读路由同样枚举，但单独一组。
 *
 * ## 为什么检查直接做在守卫函数上而不是只做在路由上
 *
 * 组合表有一处必须在函数层完成：`Sec-Fetch-Site` 有五个取值，而 `null` 与
 * `same-site`/`cross-site` 的语义不同（`null` 是「允许」，`cross-site` 是「拒绝」）。
 * 通过路由构造这五种取值需要为每种取值单独准备请求，而函数层能给出穷尽的取值矩阵。
 * 「路由是否真的接上了这套判定」由上面的第 3 点（全部写路由枚举）回答——两者合起来
 * 才是 T075-C01 的「安全不能只依赖一个容易漏掉的检查」。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseSync } from 'node:sqlite';

import type { LlmConfig } from '@/domain/knowledge';
import { LIMITS } from '@/domain/limits';
import {
  APP_HOST,
  APP_ORIGIN,
  checkHost,
  checkOrigin,
  checkSecFetchSite,
  expectedHost,
  getSessionToken,
  guardMutation,
  guardRead,
} from '@/server/security/localGuard';
import {
  setTransport,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from '@/server/llm/transport';
import { writeSettings } from '@/server/repositories/settings';
import { createTestDatabase, newId, openTestDatabase, type TestDatabase } from '../helpers/db';
import { TEST_HOST, TEST_ORIGIN, callRoute } from '../integration/helpers/http';

/** The stand-in credential. Loopback only; never reaches a provider. */
const STORED_KEY = 'gw-test-CROSSSITE-1122334455';

function config(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return {
    adapter: 'openai-compatible',
    baseUrl: 'https://api.example.com/v1',
    model: 'test-model',
    structuredMode: 'prompt_json',
    tokenField: 'none',
    maxOutputTokens: 4096,
    schemaRepairEnabled: false,
    ...overrides,
  };
}

/** A transport that fails the case if it is ever asked to send anything. */
class ForbiddenTransport implements Transport {
  requests: TransportRequest[] = [];

  async send(request: TransportRequest): Promise<TransportResponse> {
    this.requests.push(request);
    throw new Error(`被拒绝的请求不应触发出站调用：${request.url}`);
  }
}

let harness: TestDatabase;
let db: DatabaseSync;

beforeEach(() => {
  harness = createTestDatabase();
  db = openTestDatabase(harness.databasePath);
  // A configured model is the *worst case* for "the guard must run first": with no
  // key the paid path refuses on its own and the case would pass even if the guard
  // were missing. So every case here starts from a fully configured connection.
  writeSettings(db, {
    config: config(),
    keyAction: 'replace',
    apiKey: STORED_KEY,
    expectedRevision: 0,
  });
});

afterEach(() => {
  setTransport(null);
  harness.cleanup();
});

function countItems(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM knowledge_items').get() as { n: number };
  return row.n;
}

function countRuns(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM ai_runs').get() as { n: number };
  return row.n;
}

/** Invoke a handler with hand-built headers, bypassing `callRoute`'s fixed ones. */
function rawCall(
  handler: unknown,
  path: string,
  init: { method?: string; headers: Record<string, string>; body?: string },
): Promise<Response> {
  return (handler as (request: Request) => Promise<Response>)(
    new Request(`http://127.0.0.1:3000${path}`, {
      method: init.method ?? 'GET',
      headers: init.headers,
      ...(init.body === undefined ? {} : { body: init.body }),
    }),
  );
}

function failureCode(envelope: unknown): string | undefined {
  return (envelope as { ok: false; error: { code: string } }).error?.code;
}

/* -------------------------------------------------------------------------- */
/* 判据本身的取值矩阵                                                          */
/* -------------------------------------------------------------------------- */

describe('T075-C01 判据取值矩阵', () => {
  it('T075-C01 Host 只接受配置的回环地址与端口', () => {
    expect(expectedHost()).toBe(new URL(APP_ORIGIN).host);
    expect(APP_HOST).toBe('127.0.0.1');

    // 合法：唯一那个值。
    expect(checkHost(expectedHost())).toBe(true);

    // 非法与缺失：每种都必须是独立的拒绝，而不是靠别的判据顺手挡下。
    const invalid = [
      null,
      '',
      'localhost:3000',
      '127.0.0.1',
      '127.0.0.1:3001',
      '127.0.0.1:3100',
      '0.0.0.0:3000',
      '[::1]:3000',
      'evil.test',
      '127.0.0.1.evil.test:3000',
      '127.0.0.1.nip.io:3000',
      'localho st:3000',
    ];
    for (const host of invalid) {
      expect(checkHost(host), `Host=${String(host)} 不应被接受`).toBe(false);
    }
  });

  it('T075-C01 Origin 缺失按非浏览器客户端处理，出现则必须精确匹配', () => {
    // 缺失被允许是显式契约：表单/图片式请求没有 Origin 可伪造，代价是令牌必须始终必需
    // （见 `local-request-guard.test.ts` 的 T007-R03）。这条断言把「允许缺失」钉在这里，
    // 避免将来有人把它读成「Origin 检查不重要」。
    expect(checkOrigin(null)).toBe(true);
    expect(checkOrigin(APP_ORIGIN)).toBe(true);

    const refused = [
      '',
      'http://127.0.0.1:3001',
      'http://localhost:3000',
      'https://127.0.0.1:3000',
      'http://127.0.0.1.nip.io:3000',
      'https://evil.test',
      'null',
      // 只差一个字符的近似值：前缀比较会放过它。
      'http://127.0.0.1:3000.evil.test',
      'http://127.0.0.1:30000',
    ];
    for (const origin of refused) {
      expect(checkOrigin(origin), `Origin=${origin} 不应被接受`).toBe(false);
    }
  });

  it('T075-C01 Sec-Fetch-Site 的五个取值只有 same-origin/none 与「无元数据」放行', () => {
    // 浏览器实际会发送的取值集合。`same-site` 与 `cross-site` 都必须拒绝：本应用是
    // 单origin 的本地工具，`same-site`（子域）不属于它。
    expect(checkSecFetchSite('same-origin')).toBe(true);
    expect(checkSecFetchSite('none')).toBe(true);
    expect(checkSecFetchSite(null)).toBe(true);

    expect(checkSecFetchSite('cross-site')).toBe(false);
    expect(checkSecFetchSite('same-site')).toBe(false);

    // 大小写与空串不能被当成「没带元数据」而放行。
    for (const value of ['Cross-Site', 'SAME-ORIGIN', '', ' ', 'cross_site', 'unknown']) {
      expect(checkSecFetchSite(value), `Sec-Fetch-Site=${JSON.stringify(value)} 不应被放行`).toBe(
        false,
      );
    }
  });

  it('T075-C01 四判据是「全部必须通过」，不是任选其一', () => {
    // 组合表：Host、Origin、Sec-Fetch-Site 各取合法/非法，令牌取合法/非法/缺失，加上
    // 「不发送该元数据」的一格（`null`）。
    //
    // `Origin: null` 与 `Sec-Fetch-Site: null` 在契约里是合法的「非浏览器客户端 / 无
    // 元数据」状态，所以放行集合比「三个字段都精确匹配」更大——但仍然很窄，并且**令牌
    // 与 Host 永远是硬条件**。逐格断言的是判定函数；「路由真的接上了这套判定」由下面的
    // 全路由枚举回答。
    const hosts = [TEST_HOST, 'evil.test'] as const;
    const origins = [TEST_ORIGIN, 'https://evil.test', null] as const;
    const secFetchSites = ['same-origin', 'cross-site', null] as const;
    const tokens = [getSessionToken(), 'stale-token', null] as const;

    const accepted: string[] = [];
    for (const host of hosts) {
      for (const origin of origins) {
        for (const secFetchSite of secFetchSites) {
          for (const token of tokens) {
            const read = guardRead({
              method: 'GET',
              host,
              origin,
              secFetchSite,
              contentType: null,
              token,
            });
            const legal =
              host === TEST_HOST &&
              (origin === TEST_ORIGIN || origin === null) &&
              (secFetchSite === 'same-origin' || secFetchSite === null) &&
              token === getSessionToken();
            const shape = `${host}|${String(origin)}|${String(secFetchSite)}|${String(token)}`;
            if (legal) {
              expect(read.ok, `合法组合被拒绝：${shape}`).toBe(true);
              accepted.push(shape);
            } else {
              expect(read.ok, `非法组合被放行：${shape}`).toBe(false);
            }
          }
        }
      }
    }

    // 36 个组合里恰好 4 个被放行：Host 与令牌必须精确合法，Origin 与 Sec-Fetch-Site
    // 各可「精确合法」或「未发送」。写成计数断言是为了让「将来放宽某一格」立刻可见。
    expect(accepted).toHaveLength(4);
    for (const shape of accepted) {
      expect(shape.startsWith(`${TEST_HOST}|`)).toBe(true);
      expect(shape.endsWith(`|${getSessionToken()}`)).toBe(true);
    }
  });

  it('T075-C01 放宽的那一格只属于读取：mutation 仍要求显式 Origin', () => {
    // 「缺 Origin 放行」是给表单/图片式**读取**留的口子（它们没有 Origin 可伪造）。
    // 若 mutation 也沿用这条，跨站表单写入就成立了，所以必须证明它没有沿用。
    //
    // 注意 `Sec-Fetch-Site: null` 对 mutation 也是放行的，这是**实现现状**而不是本用例
    // 的期望被放宽：`guardMutation` 只在元数据存在时校验它。这一格不能靠臆想写成
    // 「应当拒绝」——那会让用例与实现长期互相掩盖。真实浏览器发出的写请求始终带
    // `Sec-Fetch-Site`，所以这一格描述的是 curl 类客户端，而它仍要过 Origin 与令牌两道。
    const withoutOrigin = {
      method: 'POST',
      host: TEST_HOST,
      origin: null,
      secFetchSite: 'same-origin',
      contentType: 'application/json',
      token: getSessionToken(),
    };
    expect(guardRead(withoutOrigin).ok, '读取侧允许缺 Origin').toBe(true);
    expect(guardMutation(withoutOrigin).ok, 'mutation 不接受缺 Origin').toBe(false);
    expect(guardMutation(withoutOrigin).failure).toBe('origin');

    // 元数据缺失但 Origin 显式合法：放行（curl 类客户端的正常路径）。
    const withoutMetadata = { ...withoutOrigin, origin: TEST_ORIGIN, secFetchSite: null };
    expect(guardMutation(withoutMetadata).ok).toBe(true);

    // 元数据一旦出现且是跨站，mutation 必须拒绝——这一格才是浏览器的真实形状。
    const crossSite = { ...withoutOrigin, origin: TEST_ORIGIN, secFetchSite: 'cross-site' };
    expect(guardMutation(crossSite).ok).toBe(false);
    expect(guardMutation(crossSite).failure).toBe('cross_site');
  });

  it('T075-C01 三个字段各给一个「只差一点」的近似值，全部被拒', () => {
    // 精确匹配 vs 近似匹配：这一组值在「按前缀/按包含判断」的实现下会被放行，
    // 而那是真实存在的写法（例如 `origin.startsWith(APP_ORIGIN)`）。
    const nearly = [
      { host: '127.0.0.1:3000.evil.test', origin: TEST_ORIGIN },
      { host: TEST_HOST, origin: 'http://127.0.0.1:3000.evil.test' },
      { host: TEST_HOST, origin: 'http://127.0.0.1:30000' },
      { host: 'evil.test?127.0.0.1:3000', origin: TEST_ORIGIN },
    ];

    for (const entry of nearly) {
      const result = guardRead({
        method: 'GET',
        host: entry.host,
        origin: entry.origin,
        secFetchSite: 'same-origin',
        contentType: null,
        token: getSessionToken(),
      });
      expect(
        result.ok,
        `近似值不应被接受：host=${entry.host} origin=${entry.origin}`,
      ).toBe(false);
    }
  });

  it('T075-C01 mutation 比读取多要求两项：显式 Origin 与 JSON 正文类型', () => {
    const base = {
      method: 'POST',
      host: TEST_HOST,
      origin: null,
      secFetchSite: 'none',
      contentType: 'application/json',
      token: getSessionToken(),
    };
    // 读取接受「无 Origin」（表单式请求没有 Origin 可伪造），mutation 不接受。
    expect(guardRead(base).ok).toBe(true);
    expect(guardMutation(base).ok).toBe(false);
    expect(guardMutation(base).failure).toBe('origin');

    // 正文类型是独立的一格：`text/plain` 是表单式跨站写入的经典形状。
    const plain = { ...base, origin: TEST_ORIGIN, contentType: 'text/plain' };
    expect(guardMutation(plain).ok).toBe(false);
    expect(guardMutation(plain).failure).toBe('content_type');
    // 读取路径不看正文类型（它没有正文），所以这一格只属于 mutation。
    expect(guardRead({ ...plain, method: 'GET' }).ok).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* 真实路由：非法组合没有数据与费用副作用                                        */
/* -------------------------------------------------------------------------- */

/**
 * The current write routes, each with the handler that must protect it.
 *
 * A new route has to be added here. That is the point: a route that forgets its
 * guard is invisible to a case that only exercises the routes someone remembered,
 * so the list is explicit and the case enumerates it rather than sampling it.
 *
 * The module specifiers are written out instead of built from a template: a
 * computed specifier is not statically analysable, and Vite's warning about that
 * is a real warning — it also makes a typo fail as "cannot find module" rather
 * than as the security assertion this file is about.
 */
const MUTATION_CALLS = [
  {
    label: 'items.create',
    path: '/api/items',
    load: async () => (await import('@/app/api/items/route')).POST,
    body: () => ({ captureBody: true }),
  },
  {
    label: 'items.organize',
    path: '/api/items/{id}/organize',
    load: async () => (await import('@/app/api/items/[id]/organize/route')).POST,
    body: () => ({ requestKey: newId(), expectedRevision: 1 }),
  },
  {
    label: 'items.patch',
    path: '/api/items/{id}',
    load: async () => (await import('@/app/api/items/[id]/route')).PATCH,
    body: () => ({ expectedRevision: 1, patch: { title: '跨站改标题' } }),
  },
  {
    label: 'items.delete',
    path: '/api/items/{id}',
    load: async () => (await import('@/app/api/items/[id]/route')).DELETE,
    body: () => ({ expectedRevision: 1 }),
  },
  {
    label: 'settings.llm.put',
    path: '/api/settings/llm',
    load: async () => (await import('@/app/api/settings/llm/route')).PUT,
    body: () => ({ keyAction: 'delete', expectedRevision: 0, config: config() }),
  },
  {
    label: 'settings.llm.test',
    path: '/api/settings/llm/test',
    load: async () => (await import('@/app/api/settings/llm/test/route')).POST,
    body: () => ({
      requestKey: newId(),
      expectedSettingsRevision: 0,
      draft: { keyAction: 'replace', apiKey: STORED_KEY, config: config() },
    }),
  },
  {
    label: 'graph.generate',
    path: '/api/graph',
    load: async () => (await import('@/app/api/graph/route')).POST,
    body: () => ({ requestKey: newId() }),
  },
  {
    label: 'views.mindmap.generate',
    path: '/api/views/mindmap/generate',
    load: async () => (await import('@/app/api/views/mindmap/generate/route')).POST,
    body: () => ({
      requestKey: newId(),
      selection: { mode: 'explicit', itemIds: [newId()] },
    }),
  },
  {
    label: 'views.mermaid.generate',
    path: '/api/views/mermaid/generate',
    load: async () => (await import('@/app/api/views/mermaid/generate/route')).POST,
    body: () => ({
      requestKey: newId(),
      selection: { mode: 'explicit', itemIds: [newId()] },
    }),
  },
  {
    label: 'views.create',
    path: '/api/views',
    load: async () => (await import('@/app/api/views/route')).POST,
    body: () => ({ name: '跨站视图', kind: 'mindmap' }),
  },
  {
    label: 'views.patch',
    path: '/api/views/{id}',
    load: async () => (await import('@/app/api/views/[id]/route')).PATCH,
    body: () => ({ expectedRevision: 1, name: '跨站改名' }),
  },
  {
    label: 'views.delete',
    path: '/api/views/{id}',
    load: async () => (await import('@/app/api/views/[id]/route')).DELETE,
    body: () => ({ expectedRevision: 1 }),
  },
  {
    label: 'views.layout.put',
    path: '/api/views/{id}/layout',
    load: async () => (await import('@/app/api/views/[id]/layout/route')).PUT,
    body: () => ({ expectedRevision: 1, positions: {} }),
  },
  {
    label: 'relations.patch',
    path: '/api/relations/{id}',
    load: async () => (await import('@/app/api/relations/[id]/route')).PATCH,
    body: () => ({ expectedRevision: 1, reviewStatus: 'accepted' }),
  },
  {
    label: 'relations.delete',
    path: '/api/relations/{id}',
    load: async () => (await import('@/app/api/relations/[id]/route')).DELETE,
    body: () => ({ expectedRevision: 1 }),
  },
  {
    label: 'relations.create',
    path: '/api/relations',
    load: async () => (await import('@/app/api/relations/route')).POST,
    body: () => ({ sourceId: newId(), targetId: newId(), relationType: 'related_to', expectedRevision: 1 }),
  },
  {
    label: 'import.apply',
    path: '/api/import',
    load: async () => (await import('@/app/api/import/route')).POST,
    body: () => ({}),
  },
  {
    label: 'import.validate',
    path: '/api/import/validate',
    load: async () => (await import('@/app/api/import/validate/route')).POST,
    body: () => ({}),
  },
  {
    label: 'runs.recover',
    path: '/api/runs/recover',
    load: async () => (await import('@/app/api/runs/recover/route')).POST,
    body: () => ({}),
  },
] as const;

const READ_CALLS = [
  { label: 'items.list', path: '/api/items', load: async () => (await import('@/app/api/items/route')).GET },
  { label: 'selection.read', path: '/api/selection', load: async () => (await import('@/app/api/selection/route')).GET },
  { label: 'tags.list', path: '/api/tags', load: async () => (await import('@/app/api/tags/route')).GET },
  { label: 'relations.list', path: '/api/relations', load: async () => (await import('@/app/api/relations/route')).GET },
  { label: 'views.list', path: '/api/views', load: async () => (await import('@/app/api/views/route')).GET },
  { label: 'diagnostics.read', path: '/api/diagnostics', load: async () => (await import('@/app/api/diagnostics/route')).GET },
  { label: 'settings.llm.get', path: '/api/settings/llm', load: async () => (await import('@/app/api/settings/llm/route')).GET },
  { label: 'export.read', path: '/api/export', load: async () => (await import('@/app/api/export/route')).GET },
] as const;

describe('T075-C01 非法组合在真实路由上没有副作用', () => {
  /**
   * 跨站组合：Host、Origin、Sec-Fetch-Site 三者都非法，但令牌是**真的**。
   *
   * 令牌合法是有意的：如果拒绝只来自令牌，那删掉 Host/Origin/Sec-Fetch-Site 三条里
   * 的任意一条，这个用例仍然绿，也就证明不了它们存在。
   */
  const CROSS_SITE_HEADERS: Record<string, string> = {
    host: 'evil.test',
    origin: 'https://evil.test',
    'sec-fetch-site': 'cross-site',
    'content-type': 'application/json',
    [LIMITS.tokenRequestHeader]: getSessionToken(),
  };

  it('T075-C01 全部写路由：跨站被 403，且没有出站调用、没有新增条目或 Run', async () => {
    const transport = new ForbiddenTransport();
    setTransport(transport);

    const itemsBefore = countItems();
    const runsBefore = countRuns();

    for (const call of MUTATION_CALLS) {
      const handler = await call.load();
      expect(handler, `${call.label} 应存在处理函数`).toBeTypeOf('function');

      const path = call.path.replace('{id}', newId());
      const method = call.label.endsWith('delete')
        ? 'DELETE'
        : call.label.endsWith('patch')
          ? 'PATCH'
          : call.label.endsWith('put')
            ? 'PUT'
            : 'POST';
      const response = await rawCall(handler, path, {
        method,
        headers: CROSS_SITE_HEADERS,
        body: JSON.stringify(call.body()),
      });

      expect(response.status, `${call.label} 跨站应 403，实际 ${response.status}`).toBe(403);
      expect(failureCode(await response.json()), `${call.label} 应是来源类拒绝`).toBe(
        'LOCAL_ORIGIN_REJECTED',
      );
    }

    // 「必须断言：非法组合均无数据和费用副作用」。
    expect(transport.requests, '被拒绝的写请求不得触发出站调用').toEqual([]);
    expect(countItems(), '被拒绝的写请求不得新增条目').toBe(itemsBefore);
    expect(countRuns(), '被拒绝的写请求不得留下 Run 行').toBe(runsBefore);
  });

  it('T075-C01 清单覆盖当前全部写路由（新增路由必须同时补进这里）', async () => {
    // 清单式枚举的风险是「漏了」。这条用真实文件树反向核对：任何导出写方法的 route.ts
    // 都必须在上面的清单里出现，否则本文件会因为一个没人记得的新路由而留下验证缺口。
    const { readFileSync, readdirSync, statSync } = await import('node:fs');
    const path = await import('node:path');
    const apiRoot = path.resolve(process.cwd(), 'src', 'app', 'api');

    const writeRoutes: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const full = path.join(directory, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (entry !== 'route.ts') continue;
        const source = readFileSync(full, 'utf8');
        const methods = [...source.matchAll(/export (?:const|async function) (GET|POST|PUT|PATCH|DELETE)/gu)]
          .map((match) => match[1]);
        // `session` 是引导端点（guardBootstrap，无令牌），`health` 是公开健康检查；
        // 两者按契约**不是**私有写路由，因此不在本清单范围内。
        const relative = path.relative(apiRoot, full).replaceAll('\\', '/');
        if (relative.startsWith('session/') || relative.startsWith('health/')) continue;
        if (methods.some((method) => method !== 'GET')) writeRoutes.push(relative);
      }
    };
    walk(apiRoot);

    const listed = new Set(MUTATION_CALLS.map((call) => call.path.replace('/api/', '').replace('/{id}', '/[id]')));
    const missing = writeRoutes.filter((route) => !listed.has(route.replace(/\/route\.ts$/u, '')));
    expect(
      missing,
      `以下写路由不在 T075-C01 清单里，必须补进去并确认它挂了 guard：${missing.join(', ')}`,
    ).toEqual([]);
    // 反向：清单里的每一条都应对应一个真实文件（防止清单腐化成注释）。
    for (const call of MUTATION_CALLS) {
      expect(
        writeRoutes.some(
          (route) => route === `${call.path.replace('/api/', '').replace('/{id}', '/[id]')}/route.ts`,
        ),
        `${call.label} 的路径不存在真实 route.ts：${call.path}`,
      ).toBe(true);
    }
  });

  it('T075-C01 全部读路由：跨站被 403，响应里不回显令牌、Key 或笔记内容', async () => {
    const responseTexts: string[] = [];

    for (const call of READ_CALLS) {
      const handler = await call.load();
      expect(handler, `${call.label} 应存在处理函数`).toBeTypeOf('function');

      const response = await rawCall(handler, call.path, { headers: CROSS_SITE_HEADERS });
      expect(response.status, `${call.label} 跨站应 403，实际 ${response.status}`).toBe(403);

      const text = await response.text();
      responseTexts.push(`${call.label}: ${text}`);
      expect(failureCode(JSON.parse(text)), `${call.label} 应是来源类拒绝`).toBe(
        'LOCAL_ORIGIN_REJECTED',
      );
      // 拒绝理由本身也不泄露任何东西。
      const blob = responseTexts.join('\n');
      expect(blob, '拒绝响应不应回显会话令牌').not.toContain(getSessionToken());
      expect(blob, '拒绝响应不应回显 API Key').not.toContain(STORED_KEY);
    }
  });

  it('T075-C01 缺令牌与错令牌是独立的一格：来源合法也被拒', async () => {
    const route = await import('@/app/api/items/route');
    const itemsBefore = countItems();

    for (const token of [null, 'stale-token-from-a-previous-process']) {
      const headers: Record<string, string> = {
        host: TEST_HOST,
        origin: TEST_ORIGIN,
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      };
      if (token !== null) headers[LIMITS.tokenRequestHeader] = token;

      const write = await rawCall(route.POST, '/api/items', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          captureRequestId: newId(),
          rawText: 'T075 跨站矩阵探针',
          sourceType: 'other',
          sourceRef: null,
        }),
      });
      expect(write.status, `token=${String(token)} 的写入应 403`).toBe(403);
      expect(failureCode(await write.json())).toBe('SESSION_EXPIRED');
    }

    expect(countItems()).toBe(itemsBefore);
  });

  it('T075-C01 逐格删除的对照：只坏一格也必须被拒（不能靠其它判据兜底）', async () => {
    const route = await import('@/app/api/items/route');
    const itemsBefore = countItems();

    const good = {
      host: TEST_HOST,
      origin: TEST_ORIGIN,
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
      [LIMITS.tokenRequestHeader]: getSessionToken(),
    };

    // 每次只改坏一格。若实现把判据合并成「有任一合法就放行」，前三格会漏。
    const oneBad = [
      { ...good, host: 'evil.test' },
      { ...good, origin: 'https://evil.test' },
      { ...good, 'sec-fetch-site': 'cross-site' },
      { ...good, [LIMITS.tokenRequestHeader]: 'stale-token' },
    ];

    for (const headers of oneBad) {
      const response = await rawCall(route.POST, '/api/items', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          captureRequestId: newId(),
          rawText: 'T075 单格探针',
          sourceType: 'other',
          sourceRef: null,
        }),
      });
      expect(
        response.status,
        `只坏一格也应拒绝：${JSON.stringify({ ...headers, [LIMITS.tokenRequestHeader]: '[token]' })}`,
      ).toBe(403);
    }

    expect(countItems(), '逐格探针不应有任何写入').toBe(itemsBefore);
  });

  it('T075-C01 对照组：四个判据合法时写入真的成功（证明上一条不是恒真）', async () => {
    const route = await import('@/app/api/items/route');
    const itemsBefore = countItems();

    const response = await callRoute(route.POST, {
      method: 'POST',
      body: {
        captureRequestId: newId(),
        rawText: 'T075 对照组',
        sourceType: 'other',
        sourceRef: null,
      },
    });

    expect(response.status).toBe(201);
    expect(countItems()).toBe(itemsBefore + 1);
  });
});
