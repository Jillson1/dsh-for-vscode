// test/dsh-availability.ts — 真实 dsh 集成测试的可用性门控（非 *.test.ts，不参与用例收集）
//
// 为什么需要它：Windows 上 Node 的 spawnSync **不能**直接执行 npm 的 POSIX shim，
// 也不能在 shell:false 下执行 .cmd（Node ≥20 抛 EINVAL）。因此
//   spawnSync('dsh', ['--version']).status === 0
// 在 Windows 上恒为 null/false —— 用这种判据的集成测试会**静默跳过**，等于没跑。
// 本助手按平台选择可执行形式，两个平台都能真实探测。
import { spawnSync } from 'node:child_process';

/** 判断 dsh 命令在本机是否可用（按平台选择可执行形式） */
export function hasDsh(): boolean {
  try {
    const r = process.platform === 'win32'
      ? spawnSync('dsh.cmd', ['--version'], { timeout: 8000, shell: true })
      : spawnSync('dsh', ['--version'], { timeout: 8000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** 探测到的 dsh 版本字符串（探测失败返回 null），用于日志与版本自适应断言 */
export function dshVersion(): string | null {
  try {
    const r = process.platform === 'win32'
      ? spawnSync('dsh.cmd', ['--version'], { timeout: 8000, shell: true })
      : spawnSync('dsh', ['--version'], { timeout: 8000 });
    if (r.status !== 0) return null;
    const out = String(r.stdout ?? '').trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}
