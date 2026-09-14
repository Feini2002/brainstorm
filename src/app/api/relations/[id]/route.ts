/**
 * /api/relations/:id — review and delete (T023).
 *
 * Accept/reject/restore only apply to AI rows; a manual relation is removed with
 * DELETE instead, because a rejected manual row would contradict the data model
 * (manual is always accepted). DELETE on an AI row is not offered by the UI —
 * rejecting keeps the tombstone that stops the same suggestion from coming back.
 */
import { expectedRevisionSchema, reviewRelationRequestSchema } from '@/domain/schemas/http';
import { getDb } from '@/server/db/database';
import { createDynamicRouteHandler } from '@/server/http/routeHandler';
import { removeRelation, reviewRelation } from '@/server/services/relations';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** PATCH /api/relations/:id — apply a review action under optimistic concurrency. */
export const PATCH = createDynamicRouteHandler(
  { route: 'relations.review', mutation: true, schema: reviewRelationRequestSchema },
  ({ body, params }) =>
    reviewRelation(getDb(), {
      id: params.id ?? '',
      expectedRevision: body.expectedRevision,
      action: body.action,
    }),
);

/** DELETE /api/relations/:id — manual relations are removed, not rejected. */
export const DELETE = createDynamicRouteHandler(
  { route: 'relations.delete', mutation: true, schema: expectedRevisionSchema },
  ({ body, params }) => removeRelation(getDb(), params.id ?? '', body.expectedRevision),
);
