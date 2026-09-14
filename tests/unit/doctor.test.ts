import { describe, expect, it } from 'vitest';

import { checkNodeVersion, parseNodeVersion } from '../../scripts/doctor.mjs';

/**
 * T001-C01 / T001-C06 — runtime version gate.
 *
 * The gate is exposed as a pure function so the branches can be asserted without
 * installing a second Node (the machine only has one supported interpreter).
 */
describe('doctor 运行时门限', () => {
  it('解析版本号', () => {
    expect(parseNodeVersion('24.18.0')).toEqual({ major: 24, minor: 18, patch: 0 });
    expect(parseNodeVersion('22.14.0')).toEqual({ major: 22, minor: 14, patch: 0 });
  });

  it('接受受支持的 24.15 及更高 minor', () => {
    expect(checkNodeVersion('24.15.0').ok).toBe(true);
    expect(checkNodeVersion('24.18.0').ok).toBe(true);
    expect(checkNodeVersion('24.99.1').ok).toBe(true);
  });

  it('拒绝更低主版本，并报告实际主版本（T001-C01）', () => {
    const result = checkNodeVersion('22.14.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('22');
  });

  it('拒绝 24.15 以下的 minor', () => {
    const result = checkNodeVersion('24.14.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('24.15');
  });

  it('不接受未来主版本（T001-C06）', () => {
    const result = checkNodeVersion('25.0.0');
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('25');
  });
});
