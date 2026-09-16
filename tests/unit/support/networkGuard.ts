/**
 * T076-C06 网络隔离：单元测试进程对外网 fail-closed。
 *
 * 规格要求「单元测试环境禁外网」且「全部确定性用例不需要模型 Key」。只在文档里写
 * 这句话没有约束力：一个不小心加了 `await fetch(...)` 的测试会照常跑、照常收费，
 * 只是慢一点。所以这里在进程层面把出口堵上——非回环主机的 `fetch` 与
 * `net.Socket.connect` 直接抛错，回环放行（同进程的临时服务器、端口探测仍可用）。
 *
 * 只挂在 `unit` project 上：`integration` 与 `e2e` 需要真实 HTTP，它们各自的
 * 隔离策略在别处（`tests/e2e/support/` 的 traffic 账本）。
 *
 * 这不是「防御机制」而是测试装置：它保证本任务的 C06 结论是**被强制**的，
 * 而不是靠约定。
 */
import { afterAll } from 'vitest';
import net from 'node:net';

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0', '']);

/** Strict IPv4 dotted-quad check. `127.0.0.1.evil.com` is a hostname, not an IP. */
const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

export function isLoopbackHost(hostname: string | null): boolean {
  if (hostname === null) return false;
  if (LOOPBACK.has(hostname)) return true;
  // The whole 127.0.0.0/8 block is loopback, but only as a *literal IPv4*.
  // A prefix test (`^127\.`) would also accept `127.0.0.1.evil.com`, i.e. let a
  // malicious hostname through the guard — so the whole address is matched and
  // every octet is range-checked.
  const match = IPV4.exec(hostname);
  if (match === null) return false;
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) return false;
  return octets[0] === 127;
}

function hostOfFetchInput(input: RequestInfo | URL): string | null {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    if (typeof input === 'object' && input !== null && 'url' in input) {
      return new URL((input as Request).url).hostname;
    }
    return null;
  } catch {
    // 相对路径在单元测试里没有 base，视为不可判定 → fail-closed。
    return null;
  }
}

const originalFetch = globalThis.fetch;
const originalConnect = net.Socket.prototype.connect;

type ConnectArgs = Parameters<typeof net.Socket.prototype.connect>;

/**
 * Host a `Socket.connect` call is aimed at, or `null` when it cannot be told.
 *
 * Node calls this as `connect(options, cb)` — but `net.connect(...)` re-applies
 * the arguments, so the shape actually recorded can be `[[options, cb]]`. A
 * leading array is therefore unwrapped first. Getting this wrong is not benign:
 * an unreadable host would reject *every* loopback connection too, which is
 * fail-closed but breaks the harness's own helpers.
 */
function connectHost(args: readonly unknown[]): string | null {
  let first: unknown = args[0];
  if (Array.isArray(first)) first = first[0];

  if (typeof first === 'number') return '127.0.0.1';
  if (typeof first === 'string') {
    // 可能是 unix socket 路径，也可能是 host。
    return first.startsWith('/') ? null : first;
  }
  if (typeof first === 'object' && first !== null && 'host' in first) {
    const host = (first as { host?: unknown }).host;
    return typeof host === 'string' ? host : null;
  }
  return null;
}

globalThis.fetch = function guardedFetch(
  this: unknown,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const host = hostOfFetchInput(input);
  if (!isLoopbackHost(host)) {
    throw new Error(
      `T076-C06 单元测试禁止访问外部网络（目标主机：${host ?? '不可判定'}）。` +
        '确定性用例不应依赖真实模型或外网；需要真实 HTTP 的断言请放进 integration/e2e。',
    );
  }
  return originalFetch.call(globalThis, input, init);
} as typeof globalThis.fetch;

net.Socket.prototype.connect = function guardedConnect(
  this: net.Socket,
  ...args: ConnectArgs
): net.Socket {
  const host = connectHost(args);
  if (!isLoopbackHost(host)) {
    throw new Error(
      `T076-C06 单元测试禁止建立外部 TCP 连接（目标主机：${host ?? '不可判定'}）。`,
    );
  }
  return originalConnect.apply(this, args);
} as typeof net.Socket.prototype.connect;

afterAll(() => {
  globalThis.fetch = originalFetch;
  net.Socket.prototype.connect = originalConnect;
});
