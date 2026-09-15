/**
 * Shared route handler (T006, T007, T014-R01).
 *
 * Every API route follows the same order, and the order is the security
 * property: validate the request (host, origin, token, body bytes, schema)
 * before opening a write transaction. A rejected request must never reach the
 * database or an LLM provider.
 */
import 'server-only';

import type { ZodType } from 'zod';

import { AppError, type SafeError } from '@/domain/errors';
import { guardError, logRequestFailure } from '@/server/http/errors';
import { stripAbsolutePaths } from '@/server/observability/redaction';
import {
  jsonFailure,
  jsonSuccess,
  readJsonBody,
  requestFacts,
  requestIdFrom,
  type BodyLimitKind,
} from '@/server/http/respond';
import { guardMutation, guardRead, type RequestFacts } from '@/server/security/localGuard';

export interface HandlerContext {
  request: Request;
  requestId: string;
  facts: RequestFacts;
  /** Response status for this call; override via `status(201, data)`. */
  status: (code: number, data: unknown) => RouteReply;
}

/**
 * Return this from a handler to choose a status other than 200. The contract
 * needs 201 on first capture and 200 on an idempotent replay of the same
 * request key (docs/03_contracts/04_api_contract.md §2).
 */
export interface RouteReply {
  readonly __routeReply: true;
  status: number;
  data: unknown;
}

export function respond(status: number, data: unknown): RouteReply {
  return { __routeReply: true, status, data };
}

function isRouteReply(value: unknown): value is RouteReply {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __routeReply?: unknown }).__routeReply === true
  );
}

/**
 * Log a failure once and convert it into the contract envelope.
 *
 * `AppError` messages are already safe by construction, but one class of them is
 * not: the runtime errors raised while opening the data directory embed the
 * absolute path (`无法创建数据目录 C:\...\nested：ENOTDIR ...`). A local tool still
 * must not hand its filesystem layout to whatever asked, and T006-C03 asks for a
 * safe error with controlled detail instead of a stack or a path. So a response
 * message is stripped of absolute paths before it leaves the process; the log
 * keeps the same scrubbed projection, since `logSafe` is allow-listed by field
 * and `message` is one of them.
 */
function fail(error: unknown, requestId: string, route: string): Response {
  const base: SafeError =
    error instanceof AppError
      ? error.toSafeError()
      : { code: 'INTERNAL', message: '本地服务出现未预期错误', retryable: false };
  const safe = scrubSafeError(base);
  logRequestFailure({ requestId, route, error, safe });
  // Rebuilt as an AppError so the envelope keeps the original code, message,
  // retryability and field errors; `retryable` is derived from the code, so it
  // survives the round trip unchanged.
  return jsonFailure(
    new AppError(safe.code, safe.message, safe.fieldErrors),
    requestId,
  );
}

/** Remove absolute paths (and therefore internal directory layout) from a safe error. */
function scrubSafeError(safe: SafeError): SafeError {
  return { ...safe, message: stripAbsolutePaths(safe.message) };
}

function guardOrThrow(facts: RequestFacts, mutation: boolean): void {
  const result = mutation ? guardMutation(facts) : guardRead(facts);
  if (!result.ok) throw guardError(result.failure ?? 'origin');
}

export interface RouteOptions<TSchema extends ZodType | undefined> {
  /** Route label used in logs, e.g. `items.create`. */
  route: string;
  /** `true` selects the stricter origin+token+JSON guard. */
  mutation?: boolean;
  /** Body limit family; only meaningful when a schema is supplied. */
  bodyLimit?: BodyLimitKind;
  /** When provided, the body is read and validated with this schema. */
  schema?: TSchema;
}

type Parsed<TSchema extends ZodType | undefined> = TSchema extends ZodType
  ? ReturnType<TSchema['parse']>
  : undefined;

/** Next.js passes dynamic segments as a promise of the raw string map. */
export interface RouteContext {
  params: Promise<Record<string, string>>;
}

interface CoreArgs<TSchema extends ZodType | undefined> {
  request: Request;
  requestId: string;
  facts: RequestFacts;
  body: Parsed<TSchema>;
  params: Record<string, string>;
}

async function core<TSchema extends ZodType | undefined>(
  options: RouteOptions<TSchema>,
  handler: (context: CoreArgs<TSchema> & HandlerContext) => Promise<unknown> | unknown,
  request: Request,
  params: Record<string, string>,
): Promise<Response> {
  const requestId = requestIdFrom(request.headers.get('x-request-id'));
  try {
    const facts = requestFacts(request);
    guardOrThrow(facts, options.mutation === true);

    let body = undefined as Parsed<TSchema>;
    if (options.schema) {
      const raw = await readJsonBody(request, options.bodyLimit ?? 'default');
      const parsed = options.schema.safeParse(raw);
      if (!parsed.success) {
        throw new AppError('VALIDATION', '输入不合法', zodFieldErrors(parsed.error));
      }
      body = parsed.data as Parsed<TSchema>;
    }

    const data = await handler({ request, requestId, facts, status: respond, body, params });
    if (isRouteReply(data)) return jsonSuccess(data.data, requestId, data.status);
    return jsonSuccess(data, requestId);
  } catch (error) {
    return fail(error, requestId, options.route);
  }
}

/**
 * Build a static-route handler. `mutation: true` selects the stricter guard so
 * the read and write families cannot drift apart route by route.
 */
export function createRouteHandler<TSchema extends ZodType | undefined = undefined>(
  options: RouteOptions<TSchema>,
  handler: (context: HandlerContext & { body: Parsed<TSchema> }) => Promise<unknown> | unknown,
): (request: Request) => Promise<Response> {
  return (request) => core(options, handler, request, {});
}

/** Build a dynamic-route handler; `params.id` and friends are resolved first. */
export function createDynamicRouteHandler<TSchema extends ZodType | undefined = undefined>(
  options: RouteOptions<TSchema>,
  handler: (
    context: HandlerContext & { body: Parsed<TSchema>; params: Record<string, string> },
  ) => Promise<unknown> | unknown,
): (request: Request, context: RouteContext) => Promise<Response> {
  return async (request, context) => {
    const params = context?.params ? await context.params : {};
    return core(options, handler as never, request, params);
  };
}

/** Convert a Zod failure into `field -> messages` for the client. */
export function zodFieldErrors(error: {
  issues: ReadonlyArray<{
    path: ReadonlyArray<PropertyKey>;
    message: string;
    code?: string;
    keys?: ReadonlyArray<string>;
  }>;
}): Record<string, string[]> {
  // A `Map`, not an object literal. The keys here are **client-supplied field
  // names**, so a key such as `constructor`, `toString`, `valueOf` or
  // `hasOwnProperty` would read `Object.prototype`'s member instead of the
  // undefined a fresh accumulator should give — and `(fieldErrors[key] ??= []).push`
  // would then call `.push` on a function, throwing a `TypeError` that escapes as
  // `500 INTERNAL`. The request was supposed to be rejected with a readable
  // `400 VALIDATION` naming the offending field, so the diagnostic itself must not
  // be the thing that breaks (T006-C01: invalid input is a protocol error, never an
  // unhandled one).
  const fieldErrors = new Map<string, string[]>();
  const add = (key: string, message: string): void => {
    const existing = fieldErrors.get(key);
    if (existing === undefined) fieldErrors.set(key, [message]);
    else existing.push(message);
  };

  for (const issue of error.issues) {
    // Strict objects report unknown fields as one issue listing every key, so
    // each rejected field must be named individually for the client to mark it.
    if (issue.code === 'unrecognized_keys' && issue.keys && issue.keys.length > 0) {
      for (const key of issue.keys) {
        add(key, '该字段不允许由客户端提交');
      }
      continue;
    }
    const key = issue.path.length > 0 ? issue.path.map(String).join('.') : '_';
    add(key, issue.message);
  }
  // Back to a plain object for the wire. Every key is now an own property, so
  // `{"constructor":[…]}` serialises as written instead of vanishing.
  return Object.fromEntries(fieldErrors);
}

/**
 * Parse query parameters with a schema, raising the standard 400 on failure.
 *
 * A parameter that appears more than once is collected into an array of its
 * values, in first-seen order, rather than letting the last occurrence overwrite
 * the earlier ones. That overwrite was a data-loss bug for the one documented
 * repeated parameter — `SelectionQuery.itemId` (`?itemId=a&itemId=b`), which is how
 * the flow/mindmap pages ask the server to confirm a whole selection: only the
 * last id survived, so the "what will be sent" panel described a subset of the
 * material and a deleted record could hide behind the truncation (T062-C05).
 *
 * A schema that expects a scalar will now reject a duplicated parameter with a 400
 * rather than silently truncating it, which is the honest failure for an ambiguous
 * request.
 */
export function parseQuery<T>(request: Request, schema: ZodType<T>): T {
  const url = new URL(request.url);
  // A `Map` for the same reason as `zodFieldErrors` above: these keys are query
  // parameter names chosen by the client, and a plain object would let
  // `constructor`/`toString`/`valueOf`/`hasOwnProperty` masquerade as an
  // already-present value (the prototype member is not `undefined`), so a second
  // occurrence would push a *function* into the collected array.
  const raw = new Map<string, string | string[]>();
  for (const [key, value] of url.searchParams.entries()) {
    const existing = raw.get(key);
    if (existing === undefined) {
      raw.set(key, value);
    } else if (Array.isArray(existing)) {
      existing.push(value);
    } else {
      raw.set(key, [existing, value]);
    }
  }
  const parsed = schema.safeParse(Object.fromEntries(raw));
  if (!parsed.success) {
    throw new AppError('VALIDATION', '查询参数不合法', zodFieldErrors(parsed.error));
  }
  return parsed.data;
}
