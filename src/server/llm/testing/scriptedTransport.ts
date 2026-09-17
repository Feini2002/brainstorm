/**
 * Scripted LLM transport for isolated acceptance runs.
 *
 * Production FetchTransport never scans test files. This module is the only
 * place that reads BRAIN_SCRIPTED_PROVIDER, and getTransport refuses it when
 * the process is using the user's real data directory.
 */
import 'server-only';

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { AppError } from '@/domain/errors';
import { isUserDataDir, resolveDataDir } from '@/server/runtime/dataDir';
import type { Transport, TransportRequest, TransportResponse } from '../transport';

export function scriptedProviderPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.BRAIN_SCRIPTED_PROVIDER;
  return value !== undefined && value.trim().length > 0 ? path.resolve(value.trim()) : null;
}

export function scriptedTransportFromEnv(): Transport | null {
  const target = scriptedProviderPath();
  if (target === null) return null;
  if (isUserDataDir(resolveDataDir())) {
    throw new AppError(
      'INTERNAL',
      'BRAIN_SCRIPTED_PROVIDER 只允许在隔离数据目录的运行中使用，拒绝用户真实数据目录',
    );
  }
  if (!existsSync(target)) {
    throw new AppError('INTERNAL', `BRAIN_SCRIPTED_PROVIDER 指向的路径不存在：${target}`);
  }
  return new ScriptedFileTransport(target);
}

function currentScript(target: string): string {
  if (!statSync(target).isDirectory()) return target;
  const newest = readdirSync(target)
    .filter((entry) => entry.endsWith('.json'))
    .map((entry) => {
      const file = path.join(target, entry);
      const stats = statSync(file);
      return { file, mtime: stats.mtimeMs, name: entry };
    })
    .sort((left, right) => right.mtime - left.mtime || right.name.localeCompare(left.name))[0];
  if (newest === undefined) {
    throw new AppError('INTERNAL', `BRAIN_SCRIPTED_PROVIDER 目录里没有脚本：${target}`);
  }
  return newest.file;
}

let scriptedFileState: { content: string; index: number } | null = null;

class ScriptedFileTransport implements Transport {
  constructor(private readonly target: string) {}

  async send(request: TransportRequest): Promise<TransportResponse> {
    void request.url;
    void request.headers.Authorization;
    const file = currentScript(this.target);
    const content = readFileSync(file, 'utf8');
    if (scriptedFileState === null || scriptedFileState.content !== content) {
      scriptedFileState = { content, index: 0 };
    }
    const index = scriptedFileState.index;
    scriptedFileState.index += 1;
    const script = parseScript(content);
    const reply = script.replies[Math.min(index, script.replies.length - 1)];
    if (reply === undefined) {
      throw new AppError('INTERNAL', 'BRAIN_SCRIPTED_PROVIDER 文件里没有任何回复');
    }
    return reply;
  }
}

interface ScriptedReply {
  status?: number;
  content?: string;
  bodyText?: string;
  headers?: Record<string, string>;
}

function parseScript(text: string): { replies: TransportResponse[] } {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new AppError(
      'INTERNAL',
      `BRAIN_SCRIPTED_PROVIDER 文件不是合法 JSON：${error instanceof Error ? error.message : ''}`,
    );
  }
  const replies = (payload as { replies?: unknown }).replies;
  if (!Array.isArray(replies) || replies.length === 0) {
    throw new AppError('INTERNAL', 'BRAIN_SCRIPTED_PROVIDER 需要非空的 replies 数组');
  }
  return {
    replies: replies.map((entry) => {
      const reply = entry as ScriptedReply;
      const status = reply.status ?? 200;
      const bodyText =
        reply.bodyText ??
        JSON.stringify({
          choices: [
            {
              message: { role: 'assistant', content: reply.content ?? '' },
              finish_reason: 'stop',
            },
          ],
        });
      return {
        status,
        headers: { 'content-type': 'application/json', ...(reply.headers ?? {}) },
        bodyText,
      };
    }),
  };
}
