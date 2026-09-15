/**
 * T003-R01 / T054-R03：`domain/hash.ts` 的自实现 SHA-256。
 *
 * 这个模块是手写的，所以"它真的是 SHA-256"必须由测试来钉，而不是由注释来声明。
 * 两份证据缺一不可：
 *
 *  1. **公开测试向量** —— 空串、`abc`、多字节句子的规范摘要。只比长度的测试
 *     无法发现轮函数写错（错一位也是 64 位十六进制）。
 *  2. **与 `node:crypto` 逐字节一致** —— 覆盖跨越 64 字节分块边界的长度、非 ASCII
 *     字符和长文本。域层不能引用 `node:crypto`（T003-R01），但测试可以：这里是
 *     唯一一处可以拿权威实现做对照的地方。
 *
 * 之所以要这么严，是因为这个摘要在多处承担身份：抓取指纹、Run 输入、View
 * contentHash、导入包校验。它一旦偏移，备份文件之间、以及和
 * `reference/fixtures/backup_valid.json` 里钉住的 contentHash 就会静默失配 ——
 * 表现是"内容相同但哈希不同"，而不是报错。
 */
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalJson } from '@/domain/canonicalJson';
import { hashCanonical, hashSha256 } from '@/domain/hash';

/** The local implementation must agree with the platform's, byte for byte. */
function reference(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

describe('T054-R03 domain/hash 自实现 SHA-256', () => {
  it('T054-R03 空串与官方测试向量', () => {
    expect(hashSha256('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(hashSha256('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // 448 位边界：55 字节正好塞进一个分块，56 字节就必须补出第二块。
    expect(hashSha256('a'.repeat(55))).toBe(reference('a'.repeat(55)));
    expect(hashSha256('a'.repeat(56))).toBe(reference('a'.repeat(56)));
    // 512 位边界。
    expect(hashSha256('a'.repeat(64))).toBe(reference('a'.repeat(64)));
  });

  it('T054-R03 与 node:crypto 在各类长度与内容上完全一致', () => {
    const samples = [
      '',
      ' ',
      'Feini Brain',
      '中文内容与标点：脑图、流程图、关系。',
      'emoji 属于基本多文种平面之外：🧠🕸️🗺️',
      'a'.repeat(63),
      'a'.repeat(64),
      'a'.repeat(65),
      'a'.repeat(119),
      'a'.repeat(120),
      'a'.repeat(121),
      '字'.repeat(21), // 63 UTF-8 字节，但只有 21 个码点。
      JSON.stringify({ title: '知识碎片', items: [1, 2, 3] }),
      '换行\n制表\t回车\r引号"反斜杠\\',
      'a'.repeat(10_000),
    ];

    for (const sample of samples) {
      expect(hashSha256(sample), `样本：${sample.slice(0, 24)}`).toBe(reference(sample));
    }
  });

  it('T054-R03 十六进制小写、固定长度、对输入敏感', () => {
    const digest = hashSha256('Feini Brain');
    expect(digest).toMatch(/^[0-9a-f]{64}$/u);
    // 一个码点的差异必须改变摘要：否则"内容变了但哈希没变"会让过期检测失效。
    expect(hashSha256('Feini Brain ')).not.toBe(digest);
    expect(hashSha256('feini Brain')).not.toBe(digest);
  });

  it('T054-R03 hashCanonical 与规范化 JSON 一致，且键序无关', () => {
    // 契约规定 canonicalJson 在每个深度按键名排序，所以两个键序不同的对象是
    // 同一个规范串 —— 哈希也因此相同。
    expect(hashCanonical({ b: 1, a: 2 })).toBe(hashCanonical({ a: 2, b: 1 }));
    expect(hashCanonical({ b: 1, a: 2 })).toBe(hashSha256(canonicalJson({ a: 2, b: 1 })));
    expect(hashCanonical({ b: 1, a: 2 })).toBe(hashCanonical({ a: 2, b: 1 }));
    // 嵌套结构同样按深度排序，不只是顶层。
    expect(hashCanonical({ outer: { z: 1, a: 2 } })).toBe(hashSha256('{"outer":{"a":2,"z":1}}'));
    // 数组是语义有序的，顺序变化必须改变哈希。
    expect(hashCanonical({ list: [1, 2] })).not.toBe(hashCanonical({ list: [2, 1] }));
    // 值变化必须改变哈希。
    expect(hashCanonical({ a: 1 })).not.toBe(hashCanonical({ a: 2 }));
  });

  it('T054-R03 hashCanonical 对非法输入明确失败，而不是静默产出摘要', () => {
    // 无法确定性表示的值必须抛错：静默派生一个"看起来合法"的哈希，
    // 会让两份不同的内容被当成同一份。
    expect(() => hashCanonical({ a: Number.NaN })).toThrow();
    expect(() => hashCanonical({ a: undefined })).toThrow();
    // 大整数用构造函数而不是字面量：本项目 target 为 ES2017，字面量不被支持。
    expect(() => hashCanonical({ a: BigInt(1) })).toThrow();
  });
});
