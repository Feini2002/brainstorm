/**
 * Test-side view of the contract limits.
 *
 * Tests assert against the same numbers the app uses, so a limit change fails
 * the boundary cases instead of silently drifting. Values are re-exported from
 * the domain module — never copied — so there is a single source.
 */
export { LIMITS as MAX } from '@/domain/limits';
