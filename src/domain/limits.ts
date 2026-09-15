/**
 * Numeric limits shared by every layer.
 *
 * This is the single in-code source for the values published in
 * reference/contracts/limits.json. Contracts (docs/03_contracts/*) describe how
 * each limit is applied; this module only carries the numbers so that UI, HTTP
 * validation, domain validation and SQL agree. `scripts/check-contracts.mjs`
 * fails the build when this file and limits.json drift apart.
 */
export const LIMITS = {
  appPort: 3000,
  host: '127.0.0.1',

  // Item text
  rawTextCodePoints: 10000,
  titleCodePoints: 100,
  summaryCodePoints: 500,
  tagsPerItem: 8,
  tagCodePoints: 32,
  keywordsPerItem: 10,
  keywordCodePoints: 32,
  sourceRefCodePoints: 2048,
  importanceMin: 1,
  importanceMax: 5,

  // Relations
  relationsPerOrganize: 5,
  relationScoreFloor: 0.7,
  relationReasonCodePoints: 300,
  relationEvidenceCount: 4,
  evidenceQuoteCodePoints: 120,

  // Retrieval
  candidateCount: 40,
  recentCandidateCount: 12,
  candidateBriefCodePoints: 240,
  candidateBriefTitleCodePoints: 50,
  candidateBriefSummaryCodePoints: 70,
  candidateBriefTagsCodePoints: 30,
  candidateBriefEvidenceCodePoints: 90,
  candidatePoolMax: 200,
  queryTermsMax: 24,
  substringTermsMax: 16,
  wordTermsMax: 16,
  literalHitsPerTerm: 50,

  // Views
  selectedItemsPerProjection: 40,
  graphNodes: 200,
  graphEdges: 600,
  mindmapNodes: 120,
  mindmapMaxDepth: 5,
  flowNodes: 40,
  flowEdges: 80,
  flowLabelCodePoints: 100,
  mindmapLabelCodePoints: 100,
  mindmapNodeIdCodePoints: 64,
  viewNameCodePoints: 100,
  viewCoordinateAbsMax: 10_000_000,
  viewZoomMin: 0.05,
  viewZoomMax: 10,

  // Request/response bytes
  requestBodyBytes: 65536,
  layoutBodyBytes: 262144,
  importBodyBytes: 20971520,
  viewJsonBytes: 262144,
  modelResponseBytes: 262144,
  exportBytesMax: 20971520,

  // Timeouts and budgets
  outboundContextCodePoints: 24000,
  providerCallTimeoutMs: 45000,
  operationDeadlineMs: 120000,
  runLeaseMs: 180000,
  connectionTestTimeoutMs: 15000,
  schemaRepairAttempts: 1,
  paidAutomaticNetworkRetries: 0,
  maxAttemptCount: 2,

  // Lists
  listPageSizeDefault: 30,
  listPageSizeMax: 100,
  activeRunPollMs: 1500,

  // Local diagnostics journal (T074-R04). The retention cap and the repeat
  // window are contract values, not implementation details, because the user is
  // told what they are on the settings page and a test asserts the bound.
  diagnosticJournalCapacity: 200,
  diagnosticRepeatLimit: 3,
  diagnosticRepeatWindowMs: 60000,
  diagnosticLatencySamples: 50,
  diagnosticRecentRuns: 50,

  // Import
  importItemsMax: 10000,
  importRelationsMax: 50000,
  importViewsMax: 200,

  // Settings
  intentCodePoints: 1000,
  baseUrlCodePoints: 2048,
  modelCodePoints: 200,
  apiKeyBytes: 4096,
  queryCodePoints: 200,
  maxOutputTokens: 32768,
  defaultOutputTokenLimit: 4096,

  // Local session
  tokenRequestHeader: 'X-Brain-Token',
  tokenBytes: 32,
} as const;

/** JSON body cap per route family (docs/03_contracts/04_api_contract.md). */
export const ROUTE_BODY_LIMITS = {
  default: LIMITS.requestBodyBytes,
  layout: LIMITS.layoutBodyBytes,
  import: LIMITS.importBodyBytes,
} as const;
