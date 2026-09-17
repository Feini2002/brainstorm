/**
 * Compact regressions for the 2026-09-17 review round.
 *
 * These pin the product decisions that old task specs did not fully constrain:
 * save vs organize, frozen capture retry, start/check process load, and request
 * identity. They do not replace the existing per-feature suites.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  freezeCaptureRequest,
  organizeConflictMessage,
  shouldCallOrganize,
} from '@/features/inbox/captureSession';
import { validateFlow } from '@/domain/flow';
import type { RelationDTO } from '@/domain/knowledge';

const projectRoot = path.resolve(import.meta.dirname, '../..');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const REL = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function relation(overrides: Partial<RelationDTO> = {}): RelationDTO {
  return {
    id: REL,
    sourceId: A,
    targetId: B,
    type: 'causes',
    origin: 'ai',
    reviewStatus: 'accepted',
    score: 0.9,
    reason: '材料写了因果',
    evidence: [],
    sourceRawVersion: 1,
    targetRawVersion: 1,
    revision: 1,
    runId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    isStale: false,
    ...overrides,
  };
}

describe('审查轮：记录意图与整理终态', () => {
  it('只保存永远不调用整理', () => {
    expect(shouldCallOrganize('save')).toBe(false);
    expect(shouldCallOrganize('save-and-organize')).toBe(true);
  });

  it('冻结请求包含来源与模式，重试不能改掉身份', () => {
    const frozen = freezeCaptureRequest({
      captureRequestId: '11111111-1111-4111-8111-111111111111',
      mode: 'save',
      rawText: '先记下来',
      sourceType: 'book',
      sourceRef: '第 3 页',
      draftRevision: 4,
    });
    expect(frozen.mode).toBe('save');
    expect(frozen.sourceType).toBe('book');
    expect(frozen.sourceRef).toBe('第 3 页');
    expect(frozen.organizeRequestKey).toBeUndefined();
  });

  it('整理冲突有独立文案，不是整理完成', () => {
    expect(organizeConflictMessage()).toContain('未覆盖');
    expect(organizeConflictMessage()).not.toContain('整理完成');
  });
});

describe('审查轮：因果方向与材料依据', () => {
  it('库中 A causes B 时，模型输出 B→A 不能按原关系认证', () => {
    const result = validateFlow({
      raw: {
        title: '反向因果',
        direction: 'LR',
        nodes: [
          { id: 'n1', label: '结果', itemIds: [B] },
          { id: 'n2', label: '原因', itemIds: [A] },
        ],
        edges: [
          {
            source: 'n1',
            target: 'n2',
            kind: 'causal',
            label: '反过来',
            itemIds: [B],
            relationIds: [REL],
          },
        ],
      },
      allowedItemIds: new Set([A, B]),
      relationsById: new Map([[REL, relation()]]),
    });
    expect(result.ok).toBe(true);
    expect(result.content?.edges[0]?.relationIds).toEqual([]);
    expect(result.content?.edges[0]?.basis).not.toBe('relation');
  });

  it('原文写明因果且无已确认关系时，可以形成材料表述边', () => {
    const result = validateFlow({
      raw: {
        title: '材料因果',
        direction: 'LR',
        nodes: [
          { id: 'n1', label: '加热', itemIds: [A] },
          { id: 'n2', label: '沸腾', itemIds: [B] },
        ],
        edges: [
          {
            source: 'n1',
            target: 'n2',
            kind: 'causal',
            label: '加热导致沸腾',
            itemIds: [A],
            relationIds: [],
          },
        ],
      },
      allowedItemIds: new Set([A, B]),
      relationsById: new Map(),
    });
    expect(result.ok).toBe(true);
    expect(result.content?.edges[0]?.kind).toBe('causal');
    expect(result.content?.edges[0]?.basis).toBe('material');
  });

  it('无关 depends_on 不能给当前边当依据', () => {
    const result = validateFlow({
      raw: {
        title: '错配依赖',
        direction: 'LR',
        nodes: [
          { id: 'n1', label: '甲', itemIds: [A] },
          { id: 'n2', label: '乙', itemIds: [B] },
        ],
        edges: [
          {
            source: 'n1',
            target: 'n2',
            kind: 'dependency',
            label: '依赖',
            itemIds: [A],
            relationIds: [REL],
          },
        ],
      },
      allowedItemIds: new Set([A, B]),
      relationsById: new Map([
        [
          REL,
          relation({
            type: 'depends_on',
            sourceId: B,
            targetId: A,
            reviewStatus: 'accepted',
          }),
        ],
      ]),
    });
    expect(result.ok).toBe(true);
    expect(result.content?.edges[0]?.relationIds ?? []).not.toContain(REL);
    expect(result.content?.edges[0]?.basis).not.toBe('relation');
  });
});

describe('审查轮：日常检查不再绑历史台账', () => {
  it('npm run check 只做软件检查，不跑历史交付审计', () => {
    const pkg = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts.check).toBe('npm run lint && npm run typecheck && npm run test && npm run build');
    expect(pkg.scripts.check).not.toContain('status');
    expect(pkg.scripts.check).not.toContain('audit:history');
    expect(pkg.scripts['audit:history']).toContain('check-delivery');
  });

  it('正常启动脚本不拉起完整 doctor', () => {
    const source = readFileSync(path.join(projectRoot, 'scripts', 'start-local.mjs'), 'utf8');
    expect(source).toContain('checkNodeVersion');
    expect(source).not.toMatch(/runDoctor\(/u);
    expect(source).not.toContain('FEINI_DOCTOR_RECORD');
  });
});
