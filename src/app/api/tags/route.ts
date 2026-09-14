/**
 * GET /api/tags — the existing tag dictionary (T017).
 *
 * This is a dictionary of tags already in use, not a place to create tags: a
 * tag is created by normalizing it as part of an item or relation write, so
 * there is no endpoint that executes arbitrary tag SQL. Model-suggested tags
 * are never auto-added here.
 */
import type { TagDTO } from '@/domain/knowledge';
import { querySchema } from '@/domain/schemas/http';
import { getDb } from '@/server/db/database';
import { createRouteHandler } from '@/server/http/routeHandler';
import { listTags } from '@/server/repositories/tags';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = createRouteHandler({ route: 'tags.list' }, ({ request }): { tags: TagDTO[] } => {
  const raw = new URL(request.url).searchParams.get('q') ?? '';
  // Query length is limited but an empty query simply lists everything.
  const parsed = querySchema.safeParse(raw);
  const query = parsed.success ? parsed.data : raw.slice(0, 200);
  return { tags: listTags(getDb(), query.trim().length > 0 ? query.trim() : undefined) };
});
