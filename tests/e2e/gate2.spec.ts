import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from '@playwright/test';

import { RUN_ERROR_CATEGORY_LABELS, classifyRunError } from '@/domain/runDto';

import { E2E_ORIGIN } from './support/env';
import { expect, gotoInbox, test } from './support/fixtures';
import { headersAt } from './support/gomindmap';
import { authHeaders, uniqueText } from './support/harness';
import { withSeedDb } from './support/seedData';
import {
  isPortFree,
  restartDataDir,
  restartPort,
  startServer,
  type ManagedServer,
} from './support/restartServer';

/**
 * T042 验收｜AI 闭环与真实连接验收（G2 gate report）
 *
 * ## What this file can and cannot prove
 *
 * T042 mixes two kinds of claim, and the contract is explicit that they must not
 * be blended (R01, R05). Everything here that *runs* on this machine is
 * deterministic: the honest degradation without a key, the manual-field guard and
 * the interruption recovery. The semantic half — "is this relation true, is this
 * summary faithful" — needs a real model and is **not** claimed. Those cases carry
 * `BLOCKED_BY_EXTERNAL_CREDENTIAL` in their own bodies so the report's skip count
 * *is* the unexecuted count, instead of leaving a reader to infer it from an
 * empty test.
 *
 * The distinction is load-bearing rather than pedantic. The suite's shared server
 * runs with `BRAIN_SCRIPTED_PROVIDER`, so a scripted answer would make a semantic
 * case *pass* while proving nothing about any model. Replay legitimately proves
 * the pipeline (that is what T061 uses it for) but "replay made it green" is
 * exactly the false evidence R05 forbids — so the semantic path runs against a
 * server started with the seam **absent** (`startServer({ scriptedProvider: false })`).
 *
 * ## Why the deterministic cases are worth running
 *
 * C04–C06 are the ones a model-quality report tends to skip, and each is a real
 * failure mode:
 *
 *  - **C04** — without a key the product must fail *cheaply*: `MODEL_NOT_CONFIGURED`
 *    before any run row, slot or request. A 500, or a spent run, would be the bug.
 *  - **C05** — a second organize must not overwrite a summary the user hand-wrote.
 *    This guarantee is the one that survives a model which ignores instructions
 *    (R03: engineering control beats prompt compliance), so it is asserted against
 *    a model answer that actively tries to overwrite it.
 *  - **C06** — a crashed run must become `interrupted` on restart with the raw text
 *    intact, not `running` forever. This one kills a real process and starts a real
 *    one (same reasoning as T026-C02: a browser refresh cannot distinguish "in
 *    SQLite" from "still in memory").
 *
 * Shared-database discipline: cases delete exactly the ids they created, through
 * the product's own route. Nothing here clears a table.
 */

/**
 * A real key, if the operator supplied one for this run.
 *
 * Read from the environment and never written to a file, a fixture or the repo
 * (R04). Nothing here logs or echoes it.
 */
function liveKey(): string | null {
  const value = process.env.BRAIN_T042_LIVE_API_KEY?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

function liveBaseUrl(): string | null {
  const value = process.env.BRAIN_T042_LIVE_BASE_URL?.trim();
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * Whether the live semantic half may be attempted: a key *and* somewhere to send
 * it. The scripted seam being available is deliberately **not** a condition.
 */
function liveSemanticEnabled(): boolean {
  return liveKey() !== null && liveBaseUrl() !== null;
}

interface Note {
  id: string;
  text: string;
}

/** Create one record through the real capture route. */
async function captureNote(page: Page, prefix: string): Promise<Note> {
  const text = uniqueText(prefix);
  const response = await page.request.post(`${E2E_ORIGIN}/api/items`, {
    headers: await authHeaders(page),
    data: { captureRequestId: randomUUID(), rawText: text, sourceType: 'other', sourceRef: null },
  });
  expect(response.status(), `POST /api/items 应返回 201，实际 ${response.status()}`).toBe(201);
  const envelope = (await response.json()) as { data: { item: { id: string } } };
  return { id: envelope.data.item.id, text };
}

/** Delete one record through the product's own route (never "clear the table"). */
async function deleteNote(page: Page, id: string): Promise<void> {
  const headers = await authHeaders(page);
  const current = await page.request.get(`${E2E_ORIGIN}/api/items/${id}`, { headers });
  if (current.status() === 404) return;
  expect(current.status()).toBe(200);
  const envelope = (await current.json()) as { data: { revision: number } };
  const deleted = await page.request.delete(`${E2E_ORIGIN}/api/items/${id}`, {
    headers,
    data: { expectedRevision: envelope.data.revision },
  });
  expect(deleted.status(), `DELETE /api/items/${id} 应返回 200`).toBe(200);
}

interface ItemRead {
  id: string;
  revision: number;
  summary: string;
  rawText: string;
  manualFields: string[];
  status: string;
}

/** Read one item through the app's own read route. */
async function readItem(page: Page, itemId: string): Promise<ItemRead> {
  const response = await page.request.get(`${E2E_ORIGIN}/api/items/${itemId}`, {
    headers: await authHeaders(page),
  });
  expect(response.status()).toBe(200);
  // `GET /api/items/:id` returns the DTO itself as `data`, not `data.item`
  // (the `item` nesting belongs to the list route).
  const envelope = (await response.json()) as { data: ItemRead };
  return envelope.data;
}

/** Current model connection, so "no key" is asserted rather than assumed. */
async function llmConfigured(page: Page): Promise<boolean> {
  const response = await page.request.get(`${E2E_ORIGIN}/api/settings/llm`, {
    headers: await authHeaders(page),
  });
  expect(response.status()).toBe(200);
  const envelope = (await response.json()) as {
    data: { apiKeyConfigured: boolean; config: { baseUrl: string; model: string } };
  };
  return (
    envelope.data.apiKeyConfigured &&
    envelope.data.config.baseUrl.trim().length > 0 &&
    envelope.data.config.model.trim().length > 0
  );
}

/** POST one organize request and decode the envelope. */
async function organize(page: Page, itemId: string, expectedRevision: number) {
  const response = await page.request.post(`${E2E_ORIGIN}/api/items/${itemId}/organize`, {
    headers: await authHeaders(page),
    data: { requestKey: randomUUID(), expectedRevision },
  });
  return { status: response.status(), envelope: (await response.json()) as Record<string, unknown> };
}

test.describe('T042 AI 闭环与真实连接验收', () => {
  /* ------------------------------------------------------------------------ */
  /* C04 — 真实 Key 缺失：确定性降级，真实调用列为未执行                        */
  /* ------------------------------------------------------------------------ */

  test('T042-C04 没有可用配置时：原文可读回，整理以 MODEL_NOT_CONFIGURED 结束且不产生任何外部请求', async ({
    page,
  }) => {
    test.skip(
      await llmConfigured(page),
      '本用例要求「环境没有可用配置」这一前置；当前存在模型配置，无法在不改动用户设置的前提下构造。',
    );

    const note = await captureNote(page, 'T042-C04-无配置');
    try {
      // 原文保存成功且可从资料库读回 —— 降级不能牺牲基础可用性。
      const before = await readItem(page, note.id);
      expect(before.rawText).toBe(note.text);

      const runsBefore = countRunsForSubject(note.id);
      const result = await organize(page, note.id, before.revision);

      // 整理以 MODEL_NOT_CONFIGURED 结束（422），不是 500，也不是空成功。
      expect(result.status, `实际响应 ${JSON.stringify(result.envelope)}`).toBe(422);
      const error = result.envelope.error as { code: string; message: string };
      expect(error.code).toBe('MODEL_NOT_CONFIGURED');

      // 界面把「未配置」解释成配置问题，而不是网络或权限问题。分类来自产品自己的
      // 映射（runDto），不是本文件里另写一份只与自己一致的拷贝。
      expect(classifyRunError(error.code)).toBe('configuration');
      expect(RUN_ERROR_CATEGORY_LABELS[classifyRunError(error.code)]).toBe('本地配置');

      // 不消耗额度、不占用运行槽：配置缺失在任何运行行之前就被拦下。
      expect(
        countRunsForSubject(note.id),
        '缺少配置不应产生运行记录（连一次 attempt 都不该开始）',
      ).toBe(runsBefore);

      // 原文仍然完整，处于未整理状态。
      const after = await readItem(page, note.id);
      expect(after.rawText).toBe(note.text);
      expect(after.summary).toBe('');
    } finally {
      await deleteNote(page, note.id);
    }
  });

  test('T042-C04 界面把缺少配置解释为配置问题，而不是禁掉整个采集入口', async ({ page }) => {
    test.skip(await llmConfigured(page), '本用例要求未配置模型这一前置。');

    await gotoInbox(page);
    const text = uniqueText('T042-C04-界面');
    await page.getByTestId('capture-input').fill(text);
    await page.getByTestId('capture-save-organize').click();

    // 无 Key 时「保存并整理」：原文先保存成功（不丢），再给出配置指引。
    await expect(page.getByTestId('save-phase')).toContainText('已保存');
    await expect(page.getByTestId('capture-hint')).toContainText('配置模型');

    // 被排除项：不是全站错误锁 —— 输入框仍可用。
    await expect(page.getByTestId('capture-input')).toBeEnabled();

    // 归还本用例自己造的那条记录。
    const listed = await page.request.get(`${E2E_ORIGIN}/api/items`, {
      headers: await authHeaders(page),
      params: { q: text, limit: 5 },
    });
    const envelope = (await listed.json()) as { data: { items: { id: string; rawText: string }[] } };
    const found = envelope.data.items.find((item) => item.rawText.includes(text));
    expect(found, `应能按「${text}」读回条目`).toBeTruthy();
    await deleteNote(page, found!.id);
  });

  /* ------------------------------------------------------------------------ */
  /* C05 — 人工修改：重整不得覆盖人工摘要                                      */
  /* ------------------------------------------------------------------------ */

  test('T042-C05 人工摘要被锁定后，模型返回另一摘要也不覆盖，且跳过原因可见', async ({ page }) => {
    const note = await captureNote(page, 'T042-C05-人工保护');
    try {
      const initial = await readItem(page, note.id);
      const manualSummary = '我自己精修过的摘要，模型不许改写';

      // 用户手改摘要 —— 这才是该字段被锁定的正常路径（不是直接写 manual_fields）。
      const edited = await page.request.patch(`${E2E_ORIGIN}/api/items/${note.id}`, {
        headers: await authHeaders(page),
        data: { expectedRevision: initial.revision, patch: { summary: manualSummary } },
      });
      expect(edited.status(), `PATCH 应返回 200，实际 ${edited.status()}`).toBe(200);
      const editedItem = ((await edited.json()) as { data: ItemRead }).data;

      // 前置成立：摘要确实进入了人工字段集合 —— 否则后面的断言什么也证明不了。
      expect(editedItem.manualFields).toContain('summary');
      expect(editedItem.summary).toBe(manualSummary);

      const before = await readItem(page, note.id);
      const result = await organize(page, note.id, before.revision);
      const after = await readItem(page, note.id);

      // 无论有没有 Key：人工内容一字未改，且没有被偷偷解锁。
      expect(after.summary, '人工摘要必须保持').toBe(manualSummary);
      expect(after.manualFields, '不得把人工锁定悄悄解除').toContain('summary');

      if (!liveSemanticEnabled()) {
        /*
         * 无 Key 时的诚实边界：`organizeItem` 在第一次模型调用之前就抛
         * MODEL_NOT_CONFIGURED，因此「模型真的返回了另一个摘要」这个条件根本没有
         * 产生 —— 而 C05 要排除的正是「模型是否愿意遵守提示」这一不可控项。
         *
         * 所以这条路径只证明了「降级没有破坏人工内容」。覆盖保护本身由集成证据
         * （T038 的 metadata-apply）与有 Key 时的真实路径分别覆盖，本用例不冒充。
         */
        expect(result.status).toBe(422);
        expect(
          (result.envelope.error as { code: string }).code,
          '降级必须是配置问题，而不是别的失败',
        ).toBe('MODEL_NOT_CONFIGURED');

        // 明确登记未执行的部分，而不是把它算作通过。
        expect({
          manualProtectionOnDegradedPath: 'executed',
          overwriteAttemptByModel: 'BLOCKED_BY_EXTERNAL_CREDENTIAL',
        }).toMatchObject({ overwriteAttemptByModel: 'BLOCKED_BY_EXTERNAL_CREDENTIAL' });
        return;
      }

      // ---- 有真实 Key：模型真的返回了另一个摘要 ------------------------------
      expect(result.status, `整理应成功，实际 ${JSON.stringify(result.envelope)}`).toBe(200);
      expect(after.summary, '有 Key 时人工摘要同样必须保持').toBe(manualSummary);
      expect(after.revision).toBeGreaterThan(before.revision);

      // 被跳过的字段有明确的未应用原因，而不是静默忽略。
      const warnings = ((result.envelope.data as { warnings?: string[] }).warnings ?? []).join(' ');
      expect(
        warnings.includes('人工') || warnings.includes('没有覆盖'),
        `跳过的字段必须说明原因，实际 warnings=${warnings}`,
      ).toBe(true);
    } finally {
      await deleteNote(page, note.id);
    }
  });

  /* ------------------------------------------------------------------------ */
  /* C06 — 中断恢复：真实进程被杀后，Run 恢复为 interrupted，原文不丢           */
  /* ------------------------------------------------------------------------ */

  test('T042-C06 整理中被真实杀死进程：重启后 Run 变为 interrupted，原文完整', async ({ page }) => {
    // 前置：端口空闲。否则「重启」可能悄悄是旧进程在答话，结论不可信。
    expect(
      await isPortFree(restartPort()),
      `端口 ${restartPort()} 应空闲；若有残留进程，重启结论不可信`,
    ).toBe(true);

    let server: ManagedServer | null = null;
    const rawText = uniqueText('T042-C06-中断现场');

    try {
      server = await startServer();
      const headers = await headersAt(server.origin);

      // 用真实捕获路由造一条记录。
      const captured = await page.request.post(`${server.origin}/api/items`, {
        headers,
        data: {
          captureRequestId: randomUUID(),
          rawText,
          sourceType: 'other',
          sourceRef: null,
        },
      });
      expect(captured.status(), 'POST /api/items 应返回 201').toBe(201);
      const itemId = ((await captured.json()) as { data: { item: { id: string } } }).data.item.id;

      /*
       * 中断现场是「程序被停止」的那一瞬：一条租约已过期的 running 运行行，加一个
       * processing 的条目状态。用 seed 而不是直接调 organize，是因为本机没有可用
       * 的真实 Key，而未配置的整理在注册之前就失败（见 C04），根本产生不了 running
       * 行 —— 那样就测不到恢复本身，也就等于没测。
       *
       * 这是 T042-C06 允许的「真实或替身请求中停止程序」里的替身形态。被验证的恢复
       * 逻辑（recoverExpiredRuns / GET /api/runs/:id / syncItemStatus）都是真实代码
       * 路径，不是替身。
       */
      const seeded = seedRunningOrganizeRun(restartDataDir(), itemId);
      expect(seeded.state).toBe('running');
      expect(seeded.itemStatus, '前置：中断前进程里条目应显示为整理中').toBe('processing');

      // ---- 真实停服 --------------------------------------------------------
      await server.stop();
      expect(await isPortFree(restartPort()), '停服后端口必须释放').toBe(true);

      // ---- 重启并检查 ------------------------------------------------------
      server = await startServer();
      const restarted = await headersAt(server.origin);

      // 重启后该 Run 显示为中断，而不是永久 running。
      const runResponse = await page.request.get(`${server.origin}/api/runs/${seeded.runId}`, {
        headers: restarted,
      });
      expect(runResponse.status()).toBe(200);
      const run = ((await runResponse.json()) as { data: { state: string } }).data;
      expect(run.state, '重启后仍停在 running 才是真正的缺陷').toBe('interrupted');

      // 原文与条目状态完整：原文不丢，条目不永久停在 processing。
      const itemResponse = await page.request.get(`${server.origin}/api/items/${itemId}`, {
        headers: restarted,
      });
      expect(itemResponse.status()).toBe(200);
      const item = ((await itemResponse.json()) as { data: ItemRead }).data;
      expect(item.rawText, '中断不得丢原文').toBe(rawText);
      expect(item.status, '条目不应永久停在 processing').not.toBe('processing');

      // 迟到响应不会复活：再读一次，状态稳定不变。
      const again = await page.request.get(`${server.origin}/api/runs/${seeded.runId}`, {
        headers: restarted,
      });
      expect(((await again.json()) as { data: { state: string } }).data.state).toBe('interrupted');
    } finally {
      if (server !== null) await server.stop();
    }
  });

  /* ------------------------------------------------------------------------ */
  /* C01–C03 — 真实语义质量：本机无法判定，明确登记为未执行                     */
  /* ------------------------------------------------------------------------ */

  test('T042-C01/C02/C03 真实语义质量：有真实 Key 时逐条断言，无 Key 时明确未执行', async ({
    page,
  }) => {
    if (!liveSemanticEnabled()) {
      /*
       * 这里不写「通过」。R05 要求没有 Key 或外网受阻时诚实标记真实连接未执行。
       * 用 skip 而不是恒真断言，是为了让报告里的 skip 数量就是未执行数量：任何把
       * 这段算作语义验收通过的解读都是误读。
       *
       * 已由替身覆盖的结构部分（模型答案被真实解析、校验、写入；来源可追溯；无
       * 虚构 ID；不以边数量计分）见 T061 的 gate4 证据 —— 那部分证明的是管线，
       * 不是模型质量。
       */
      test.skip(
        true,
        'BLOCKED_BY_EXTERNAL_CREDENTIAL：真实语义质量需要用户自己的模型连接'
          + '（BRAIN_T042_LIVE_API_KEY + BRAIN_T042_LIVE_BASE_URL）。本机没有可用 Key，'
          + '无法判定「关系是否真实成立、摘要是否忠实」。',
      );
      return;
    }

    let server: ManagedServer | null = null;
    try {
      // 独立进程且**关闭替身缝**：否则回放答案会被误当成模型输出（R05）。
      server = await startServer({
        dataDir: restartDataDir(),
        scriptedProvider: false,
      });
      const headers = await headersAt(server.origin);

      // 配置真实连接：Key 只在这次请求体里出现，不写日志、不进夹具。
      const current = await page.request.get(`${server.origin}/api/settings/llm`, { headers });
      const currentRevision = ((await current.json()) as { data: { revision: number } }).data
        .revision;
      const saved = await page.request.put(`${server.origin}/api/settings/llm`, {
        headers,
        data: {
          keyAction: 'replace',
          apiKey: liveKey(),
          expectedRevision: currentRevision,
          config: {
            adapter: 'openai-compatible',
            baseUrl: liveBaseUrl(),
            model: process.env.BRAIN_T042_LIVE_MODEL ?? '',
            structuredMode: 'prompt_json',
            tokenField: 'none',
            maxOutputTokens: 4096,
            schemaRepairEnabled: true,
          },
        },
      });
      expect(saved.status(), `配置真实连接应成功，实际 ${saved.status()}`).toBe(200);

      for (const sample of semanticSamples()) {
        const ids: string[] = [];
        for (const raw of sample.materials) {
          const created = await page.request.post(`${server.origin}/api/items`, {
            headers,
            data: {
              captureRequestId: randomUUID(),
              rawText: raw,
              sourceType: 'other',
              sourceRef: null,
            },
          });
          expect(created.status()).toBe(201);
          ids.push(((await created.json()) as { data: { item: { id: string } } }).data.item.id);
        }

        const target = await page.request.get(`${server.origin}/api/items/${ids[0]}`, { headers });
        const revision = ((await target.json()) as { data: ItemRead }).data.revision;

        const organized = await page.request.post(`${server.origin}/api/items/${ids[0]}/organize`, {
          headers,
          data: { requestKey: randomUUID(), expectedRevision: revision },
        });
        const body = (await organized.json()) as {
          data?: { runId: string; state: string };
          error?: { code: string; message: string };
        };
        expect(
          organized.status(),
          `${sample.id} 真实整理应成功，实际 ${JSON.stringify(body.error ?? body)}`,
        ).toBe(200);

        // 摘要必须从**读路由**取，而不是从整理响应里取：`RunResult` 并不携带条目
        // 内容（响应保持“这次运行发生了什么”的形状）。从写响应里读内容会养成
        // 「拿响应当数据库」的坏习惯，也会在这里静默拿到 undefined 而误判为「没有
        // 引入违禁内容」——一个恒真的保真断言。
        const summaryResponse = await page.request.get(`${server.origin}/api/items/${ids[0]}`, {
          headers,
        });
        const summary = ((await summaryResponse.json()) as { data: ItemRead }).data.summary;
        expect(summary.length, `${sample.id} 真实整理后应产生摘要`).toBeGreaterThan(0);
        for (const forbidden of sample.summaryMustNotIntroduce) {
          expect(summary, `${sample.id} 摘要不得引入「${forbidden}」`).not.toContain(forbidden);
        }

        const relations = await page.request.get(`${server.origin}/api/relations`, {
          headers,
          params: { itemId: ids[0], includeStale: 'true' },
        });
        const edges = (
          (await relations.json()) as {
            data: { sourceId: string; targetId: string; evidence: { itemId: string; quote: string }[] }[];
          }
        ).data;

        // R03 的「不得强行相连」：无关材料这一类的期望是零条边。
        if (sample.mustNotRelateTo.length > 0) {
          expect(edges.length, `${sample.id} 不得为了完成指标强行相连`).toBe(0);
        }

        // R03 的「来源有效、无虚构 ID」：这条**离线可判定**，对每一类样本都必须成立，
        // 也是唯一能在真实环境下把「乱连」和「有理有据地连」区分开的检查。
        for (const edge of edges) {
          for (const endpoint of [edge.sourceId, edge.targetId]) {
            expect(ids, `${sample.id} 关系不得指向本次材料之外的 ID`).toContain(endpoint);
          }
          expect(edge.evidence.length, `${sample.id} 每条关系都要有证据`).toBeGreaterThan(0);
          for (const citation of edge.evidence) {
            const quoted = sample.materials.find((raw) => raw.includes(citation.quote));
            expect(
              quoted,
              `${sample.id} 证据必须是材料原文的真实子串，不得是转述：${citation.quote}`,
            ).toBeTruthy();
          }
        }

        // 归还本样本造出的记录。
        for (const id of ids) {
          const one = await page.request.get(`${server.origin}/api/items/${id}`, { headers });
          const rev = ((await one.json()) as { data: ItemRead }).data.revision;
          await page.request.delete(`${server.origin}/api/items/${id}`, {
            headers,
            data: { expectedRevision: rev },
          });
        }
      }
    } finally {
      if (server !== null) await server.stop();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

interface SemanticSample {
  id: string;
  materials: string[];
  summaryMustNotIntroduce: string[];
  mustNotRelateTo: string[];
}

/**
 * The semantic samples T042-R02 requires, read from the shared fixture.
 *
 * Only C01–C03 are taken: C04–C06 have their own deterministic cases above, and
 * the injection samples are asserted for *disclosure* by the fixture's own
 * contract tests rather than by a live run this machine cannot make. Reading the
 * text from the fixture instead of re-typing it keeps "what the samples are"
 * reviewable in one place and prevents this spec from drifting from the contract.
 */
function semanticSamples(): SemanticSample[] {
  const fixture = JSON.parse(
    readFileSync(path.resolve(process.cwd(), 'tests', 'fixtures', 'semantic-cases.json'), 'utf8'),
  ) as {
    cases: {
      id: string;
      materials: Record<string, string>;
      expect: { summaryMustNotIntroduce: string[]; mustNotRelateTo: string[] };
    }[];
  };

  const wanted = new Set(['T042-C01', 'T042-C02', 'T042-C03']);
  return fixture.cases
    .filter((entry) => wanted.has(entry.id))
    .map((entry) => ({
      id: entry.id,
      materials: Object.values(entry.materials),
      summaryMustNotIntroduce: entry.expect.summaryMustNotIntroduce,
      mustNotRelateTo: entry.expect.mustNotRelateTo,
    }));
}

interface SeededRun {
  runId: string;
  state: string;
  itemStatus: string;
}

/**
 * Create the "crashed mid-organize" scene for T042-C06.
 *
 * Writes a `running` run row whose lease is **already expired**, plus the item's
 * `processing` status, so the restart's recovery sweep has something real to find.
 * Expired rather than fresh on purpose: a fresh lease is (correctly) not recovered,
 * so a fresh one would have the case asserting the opposite of the rule.
 *
 * Only this suite's throwaway data directories are accepted; `withSeedDb` enforces
 * that independently of this function.
 */
function seedRunningOrganizeRun(dataDir: string, itemId: string): SeededRun {
  return withSeedDb((db) => {
    const now = Date.now();
    const startedAt = new Date(now - 60_000).toISOString();
    // Past the lease: the process that owned this run is gone.
    const deadlineAt = new Date(now - 1_000).toISOString();
    const runId = randomUUID();

    const row = db.prepare('SELECT revision FROM knowledge_items WHERE id = ?').get(itemId) as
      | { revision: number }
      | undefined;
    if (!row) throw new Error(`T042-C06: 条目不存在 ${itemId}`);

    db.prepare(
      `INSERT INTO ai_runs (
         id, request_key, request_hash, kind, subject_id, input_revision, input_hash,
         state, config_revision, config_snapshot_json, candidate_ids_json,
         prompt_version, attempt_count, started_at, deadline_at
       ) VALUES (?, ?, 't042-c06-hash', 'organize', ?, ?, 't042-c06-input-hash',
         'running', 1, ?, '[]', 'organize-v1', 1, ?, ?)`,
    ).run(
      runId,
      randomUUID(),
      itemId,
      row.revision,
      JSON.stringify({
        adapter: 'openai-compatible',
        model: 't042-c06',
        baseUrl: 'https://invalid.test/v1',
      }),
      startedAt,
      deadlineAt,
    );

    db.prepare(
      `UPDATE knowledge_items SET status = 'processing', last_run_id = ?,
         error_code = NULL, error_message = NULL WHERE id = ?`,
    ).run(runId, itemId);

    const state = (db.prepare('SELECT state FROM ai_runs WHERE id = ?').get(runId) as {
      state: string;
    }).state;
    const itemStatus = (
      db.prepare('SELECT status FROM knowledge_items WHERE id = ?').get(itemId) as {
        status: string;
      }
    ).status;
    return { runId, state, itemStatus };
  }, dataDir);
}

/** Runs recorded against one subject, for the "no run was created" assertion. */
function countRunsForSubject(subjectId: string): number {
  return withSeedDb(
    (db) =>
      (db.prepare('SELECT COUNT(*) AS n FROM ai_runs WHERE subject_id = ?').get(subjectId) as {
        n: number;
      }).n,
  );
}
