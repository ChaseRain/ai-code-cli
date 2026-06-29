// tests/permission.test.ts
// 覆盖 docs/product-specs/permissions.md「验收（测试）」的全部要点：
//   1. 只读工具不触发确认、直接执行。
//   2. 写类工具必经确认。
//   3. 拒绝时：工具未被执行 + 上下文里出现 denial 结果。
//   4.「本会话始终允许」后，同名工具不再提问。
// 不依赖真实网络。

import { describe, it, expect, vi } from 'vitest';
import type { Tool } from '../src/core/types.js';
import {
  Permission,
  denialResult,
  DENIAL_ERROR,
  type PermissionAsker,
} from '../src/permission/index.js';

/** 构造一个最小工具桩，只关心 name / readOnly。 */
function makeTool(name: string, readOnly: boolean): Tool {
  return {
    name,
    description: `stub tool ${name}`,
    parameters: { type: 'object' },
    readOnly,
    execute: vi.fn(async () => ({ ok: true, content: 'ok' })),
  };
}

describe('Permission', () => {
  it('只读工具：不触发 asker，直接放行', async () => {
    const asker = vi.fn<PermissionAsker>();
    const perm = new Permission(asker);
    const tool = makeTool('read_file', true);

    await expect(perm.check(tool, {})).resolves.toBe('allow');
    expect(asker).not.toHaveBeenCalled();
  });

  it('写类工具：必经确认（触发 asker）', async () => {
    const asker = vi.fn<PermissionAsker>().mockResolvedValue('allow');
    const perm = new Permission(asker);
    const tool = makeTool('write_file', false);

    await expect(perm.check(tool, { path: 'a.txt' })).resolves.toBe('allow');
    expect(asker).toHaveBeenCalledTimes(1);
    expect(asker).toHaveBeenCalledWith(tool, { path: 'a.txt' });
  });

  it('拒绝：check 返回 deny，且 denialResult 是可入上下文的失败结果', async () => {
    const asker = vi.fn<PermissionAsker>().mockResolvedValue('deny');
    const perm = new Permission(asker);
    const tool = makeTool('run_shell', false);

    const decision = await perm.check(tool, { cmd: 'rm -rf /' });
    expect(decision).toBe('deny');
    // 工具未被执行（execute 从未被调用）。
    expect(tool.execute).not.toHaveBeenCalled();

    // 拒绝结果进入会话：结构化失败，error 为统一文案。
    const result = denialResult();
    expect(result).toEqual({ ok: false, error: DENIAL_ERROR });
    expect(result.ok).toBe(false);
  });

  it('本会话始终允许：always 后同名工具不再提问', async () => {
    const asker = vi.fn<PermissionAsker>().mockResolvedValue('always');
    const perm = new Permission(asker);
    const tool = makeTool('edit_file', false);

    // 第一次：触发 asker，返回 always → 放行并落 allowlist。
    await expect(perm.check(tool, {})).resolves.toBe('allow');
    expect(asker).toHaveBeenCalledTimes(1);

    // 后续同名工具：直过，不再询问。
    await expect(perm.check(tool, { x: 1 })).resolves.toBe('allow');
    await expect(perm.check(tool, { y: 2 })).resolves.toBe('allow');
    expect(asker).toHaveBeenCalledTimes(1);
  });

  it('P3：reset() 后此前 always 的工具重新触发 asker（/clear 语义）', async () => {
    const asker = vi.fn<PermissionAsker>().mockResolvedValue('always');
    const perm = new Permission(asker);
    const tool = makeTool('write_file', false);

    // 第一次：always → 放行并落 allowlist。
    await expect(perm.check(tool, {})).resolves.toBe('allow');
    expect(asker).toHaveBeenCalledTimes(1);
    // 同名工具直过，不再问。
    await expect(perm.check(tool, {})).resolves.toBe('allow');
    expect(asker).toHaveBeenCalledTimes(1);

    // /clear → reset()：清空会话级 allowlist。
    perm.reset();

    // 不变量：同名工具须重新触发确认。
    asker.mockResolvedValueOnce('deny');
    await expect(perm.check(tool, {})).resolves.toBe('deny');
    expect(asker).toHaveBeenCalledTimes(2);
  });

  it('allowlist 按工具名隔离：未授权的其它工具仍需确认', async () => {
    const asker = vi.fn<PermissionAsker>().mockResolvedValue('always');
    const perm = new Permission(asker);
    const edit = makeTool('edit_file', false);
    const shell = makeTool('run_shell', false);

    await perm.check(edit, {}); // 授权 edit_file
    asker.mockResolvedValueOnce('deny');
    await expect(perm.check(shell, {})).resolves.toBe('deny'); // shell 仍被问

    expect(asker).toHaveBeenCalledTimes(2);
  });
});
