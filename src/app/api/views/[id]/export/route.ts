/**
 * /api/views/{id}/export — download one saved mindmap (T060).
 *
 * The registry types this response as `File`, so it is deliberately *not* wrapped
 * in the `{ok, data, requestId}` envelope: an envelope would make the download a
 * JSON document containing a document, and no editor would open it as Markdown.
 *
 * The read guard is still applied by hand, in the same order as every other route
 * (host → origin → token → query), because "this route returns a file" must not
 * become "this route is unguarded". A failure is reported as the normal JSON error
 * envelope with its real status, so a stale session shows the session-expired
 * message rather than a downloaded file full of an error message — which is
 * exactly the failure `docs/03_contracts/10_backup_bundle.md` §2 warns about
 * (下载失败显示 JSON 错误，不把错误正文另存为看起来正常的备份).
 */
import { AppError, toSafeError } from '@/domain/errors';
import { viewExportQuerySchema } from '@/domain/schemas/http';
import { isViewExportFormat } from '@/domain/viewExport';
import { getDb } from '@/server/db/database';
import { guardError, logRequestFailure } from '@/server/http/errors';
import { jsonFailure, requestFacts, requestIdFrom } from '@/server/http/respond';
import { guardRead } from '@/server/security/localGuard';
import type { RouteContext } from '@/server/http/routeHandler';
import { exportView } from '@/server/services/views/exportView';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: RouteContext): Promise<Response> {
  const requestId = requestIdFrom(request.headers.get('x-request-id'));
  try {
    const guard = guardRead(requestFacts(request));
    if (!guard.ok) throw guardError(guard.failure ?? 'origin');

    const params = context?.params ? await context.params : {};
    const parsed = viewExportQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams.entries()),
    );
    if (!parsed.success) {
      throw new AppError('VALIDATION', '导出格式不合法，只支持 markdown 与 json');
    }
    const format = parsed.data.format;
    if (!isViewExportFormat(format)) {
      throw new AppError('VALIDATION', '导出格式不合法，只支持 markdown 与 json');
    }

    const file = exportView(getDb(), {
      id: params.id ?? '',
      format,
      now: new Date().toISOString(),
    });

    const body = new TextEncoder().encode(file.body);
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': file.contentType,
        // The filename is built from the view id and a date, so it is safe to
        // place in a header verbatim (T060-R03).
        'Content-Disposition': `attachment; filename="${file.fileName}"`,
        'Content-Length': String(body.byteLength),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'x-request-id': requestId,
      },
    });
  } catch (error) {
    const safe = toSafeError(error);
    logRequestFailure({ requestId, route: 'views.export', error, safe });
    return jsonFailure(error, requestId);
  }
}
