/**
 * /api/items/:id — detail, edit and delete (T018, T019, T020).
 *
 * Edits carry `expectedRevision` so two windows cannot silently overwrite each
 * other. The server derives which fields become manually locked from the actual
 * change set — the browser cannot declare a field locked or unlocked on its own.
 */
import type { DeletedId } from '@/domain/api';
import type { ItemDTO } from '@/domain/knowledge';
import { deleteItemRequestSchema, editItemRequestSchema } from '@/domain/schemas/http';
import { getDb } from '@/server/db/database';
import { createDynamicRouteHandler } from '@/server/http/routeHandler';
import { deleteItemById, patchItem } from '@/server/services/items';
import { getItem } from '@/server/repositories/items';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/items/:id — full DTO for the detail drawer. */
export const GET = createDynamicRouteHandler(
  { route: 'items.get' },
  ({ params }): ItemDTO => getItem(getDb(), params.id),
);

/** PATCH /api/items/:id — user edit with optimistic concurrency. */
export const PATCH = createDynamicRouteHandler(
  { route: 'items.patch', mutation: true, schema: editItemRequestSchema },
  ({ body, params }): ItemDTO =>
    patchItem(getDb(), {
      id: params.id,
      expectedRevision: body.expectedRevision,
      patch: body.patch,
      ...(body.unlockFields !== undefined ? { unlockFields: body.unlockFields } : {}),
    }),
);

/** DELETE /api/items/:id — delete one item; relations cascade, views do not. */
export const DELETE = createDynamicRouteHandler(
  { route: 'items.delete', mutation: true, schema: deleteItemRequestSchema },
  ({ body, params }): DeletedId => deleteItemById(getDb(), params.id, body.expectedRevision),
);
