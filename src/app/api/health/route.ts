import type { HealthInfo } from '@/domain/api';
import { jsonSuccess, requestIdFrom } from '@/server/http/respond';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const PROTOCOL_VERSION = 1;

/**
 * GET /api/health — fixed shape only.
 *
 * Deliberately reveals nothing beyond the app name and a healthy flag: no row
 * counts, no data paths, no model address (docs/03_contracts/04_api_contract.md §6).
 */
export async function GET(request: Request): Promise<Response> {
  const requestId = requestIdFrom(request.headers.get('x-request-id'));
  const data: HealthInfo = {
    application: 'feini-brain',
    healthy: true,
    protocolVersion: PROTOCOL_VERSION,
  };
  return jsonSuccess(data, requestId);
}
