// Contract guard (T012-R01).
//
// Drift between the machine-readable contracts, the SQL CHECK constraints and
// the in-code constants is the defect class this catches: a title limited to 100
// code points in the domain but 200 in the database, or an item type the UI can
// send but the schema rejects.
//
// Runs with plain Node, no build step, and never touches the database.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const failures = [];
const notes = [];

function read(relative) {
  return readFileSync(path.join(projectRoot, relative), 'utf8');
}

function readJson(relative) {
  return JSON.parse(read(relative));
}

/**
 * Pull a quoted tuple out of a `CHECK(column IN ('a','b'))` clause.
 *
 * The leading boundary must not be a word character or `_` so that a check for
 * `type` cannot accidentally match `source_type` or `relation_type`.
 */
function checkEnumValues(sql, column) {
  const pattern = new RegExp(`(?:^|[\\s,(])${column}\\s+IN\\s*\\(([^)]*)\\)`, 'u');
  const match = pattern.exec(sql);
  if (!match) return null;
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]).sort();
}

/* -------------------------------------------------------------------------- */
/* 1. limits.json <-> src/domain/limits.ts                                    */
/* -------------------------------------------------------------------------- */

const limitsJson = readJson('reference/contracts/limits.json');
const limitsTs = read('src/domain/limits.ts');

for (const [key, value] of Object.entries(limitsJson)) {
  if (typeof value !== 'number' && typeof value !== 'string') continue;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  // Numbers end at a word boundary; quoted strings end at the closing quote.
  const literal =
    typeof value === 'number'
      ? `${value}\\b`
      : `'${value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}'`;
  const pattern = new RegExp(`\\b${escapedKey}\\s*:\\s*${literal}`, 'u');
  if (!pattern.test(limitsTs)) {
    failures.push(`limits 漂移：${key} 在 limits.json 为 ${JSON.stringify(value)}，limits.ts 中未找到相同字面量`);
  }
}

/* -------------------------------------------------------------------------- */
/* 2. domain enums <-> SQL CHECK constraints                                  */
/* -------------------------------------------------------------------------- */

const sql = read('src/server/db/migrations/001_initial.sql');
const knowledgeTs = read('src/domain/knowledge.ts');

function domainEnum(name) {
  const pattern = new RegExp(`export const ${name} = \\[([\\s\\S]*?)\\] as const`, 'u');
  const match = pattern.exec(knowledgeTs);
  if (!match) return null;
  return [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]).sort();
}

const enumChecks = [
  { domain: 'ITEM_TYPES', column: 'type', label: 'knowledge_items.type' },
  { domain: 'SOURCE_TYPES', column: 'source_type', label: 'knowledge_items.source_type' },
  { domain: 'ITEM_STATUSES', column: 'status', label: 'knowledge_items.status' },
  { domain: 'RELATION_TYPES', column: 'relation_type', label: 'relations.relation_type' },
  { domain: 'RELATION_ORIGINS', column: 'origin', label: 'relations.origin' },
  { domain: 'REVIEW_STATUSES', column: 'review_status', label: 'relations.review_status' },
  { domain: 'RUN_KINDS', column: 'kind', label: 'ai_runs.kind' },
  { domain: 'RUN_STATES', column: 'state', label: 'ai_runs.state' },
];

for (const { domain, column, label } of enumChecks) {
  const domainValues = domainEnum(domain);
  if (!domainValues) {
    failures.push(`契约检查：src/domain/knowledge.ts 中找不到枚举 ${domain}`);
    continue;
  }
  const sqlValues = checkEnumValues(sql, column);
  if (!sqlValues) {
    failures.push(`契约检查：${label} 缺少 CHECK ... IN 约束`);
    continue;
  }
  if (JSON.stringify(domainValues) !== JSON.stringify(sqlValues)) {
    failures.push(
      `枚举漂移：${domain} = [${domainValues.join(', ')}] 与 SQL ${label} = [${sqlValues.join(', ')}] 不一致`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 3. error_codes.json <-> src/domain/errors.ts                               */
/* -------------------------------------------------------------------------- */

const errorCodesJson = readJson('reference/contracts/error_codes.json');
const errorsTs = read('src/domain/errors.ts');

for (const entry of errorCodesJson) {
  const pattern = new RegExp(
    `\\b${entry.code}:\\s*\\{\\s*httpStatus:\\s*${entry.httpStatus},\\s*retryable:\\s*${entry.retryable}\\b`,
    'u',
  );
  if (!pattern.test(errorsTs)) {
    failures.push(
      `错误码漂移：${entry.code} 期望 httpStatus=${entry.httpStatus} retryable=${entry.retryable}`,
    );
  }
}

/* -------------------------------------------------------------------------- */
/* 4. api_registry.json <-> route files                                       */
/* -------------------------------------------------------------------------- */

const apiRegistry = readJson('reference/contracts/api_registry.json');

/** Turn `/api/items/{id}/organize` into the App Router file path. */
function routeFileFor(endpointPath) {
  const segments = endpointPath
    .replace(/^\//u, '')
    .split('/')
    .map((segment) => (segment.startsWith('{') ? `[${segment.slice(1, -1)}]` : segment));
  return path.join('src/app', ...segments, 'route.ts');
}

/** Routes not yet implemented are listed here with their owning task. */
const PENDING_ROUTES = {
  '/api/views/mermaid/generate': 'T063',
  '/api/export': 'T070',
  '/api/import/validate': 'T071',
  '/api/import': 'T072',
  '/api/diagnostics': 'T074',
};

/**
 * Routes this build implements that api_registry.json does not name.
 *
 * The registry lists the endpoints the product contract commits to. A route can
 * still be a legitimate implementation of a task without belonging there: the
 * run *diagnostics* projection (T041) is deliberately larger than `RunDTO` and
 * has its own disclosure rules, so it is its own endpoint rather than more
 * fields on `/api/runs/{id}`. Declaring it here keeps it from being either
 * silently forgotten or mistaken for a contract endpoint — the check below
 * verifies it exists and that it has *not* been added to the registry, in which
 * case the registry should be the one to list it.
 */
const LOCAL_EXTENSION_ROUTES = {
  '/api/runs/{id}/diagnostics': 'T041',
  '/api/views/{id}/layout': 'T047',
  '/api/views/{id}/freshness': 'T059',
};

// The registry lists one entry per method, so a path appears several times.
// Implementation state is per path — the App Router file serves all methods.
const registryPaths = new Set(apiRegistry.endpoints.map((endpoint) => endpoint.path));
const seen = new Set();
let implemented = 0;
let pending = 0;

for (const endpointPath of registryPaths) {
  seen.add(endpointPath);
  const exists = (() => {
    try {
      read(routeFileFor(endpointPath));
      return true;
    } catch {
      return false;
    }
  })();

  if (exists) {
    implemented += 1;
    if (PENDING_ROUTES[endpointPath]) {
      failures.push(
        `路由登记过期：${endpointPath} 已实现，但仍列在 PENDING_ROUTES（${PENDING_ROUTES[endpointPath]}）`,
      );
    }
  } else if (PENDING_ROUTES[endpointPath]) {
    pending += 1;
  } else {
    failures.push(`缺少路由实现且未登记待办：${endpointPath}`);
  }
}

for (const key of Object.keys(PENDING_ROUTES)) {
  if (!seen.has(key)) {
    failures.push(`PENDING_ROUTES 中的 ${key} 不在 api_registry.json`);
  }
}

// A local extension must actually exist, and it must not creep into the registry
// unnoticed: if it is listed there, the registry is the place that owns it.
for (const [extensionPath, owner] of Object.entries(LOCAL_EXTENSION_ROUTES)) {
  const exists = (() => {
    try {
      read(routeFileFor(extensionPath));
      return true;
    } catch {
      return false;
    }
  })();
  if (!exists) {
    failures.push(`本地扩展路由登记过期：${extensionPath}（${owner}）已不存在`);
  } else if (seen.has(extensionPath)) {
    failures.push(
      `本地扩展路由 ${extensionPath} 已进入 api_registry.json；应改由该契约文件登记，并从 LOCAL_EXTENSION_ROUTES 移除`,
    );
  } else {
    notes.push(`本地扩展路由：${extensionPath}（${owner}），未在 api_registry.json 中登记`);
  }
}

/* -------------------------------------------------------------------------- */
/* 5. pages exist and use honest empty states (T012-R02)                      */
/* -------------------------------------------------------------------------- */

const PAGE_ROUTES = ['inbox', 'library', 'graph', 'mindmap', 'flow', 'settings'];
for (const route of PAGE_ROUTES) {
  try {
    read(path.join('src/app/(workspace)', route, 'page.tsx'));
  } catch {
    failures.push(`缺少页面路由：/${route}`);
  }
}

/* -------------------------------------------------------------------------- */
/* 6. no secret or env file is tracked (T012-R04)                             */
/* -------------------------------------------------------------------------- */

const gitignore = read('.gitignore');

/**
 * Does this ignore file cover `pattern` as a whole entry?
 *
 * A plain `includes` is not enough. `.includes('.data')` is satisfied by
 * `/tests/e2e/.data/`, so the e2e scratch directory would keep the check green
 * while the real `./.data` database became trackable. Entries are matched whole,
 * after trimming spaces and a trailing `/`, which is how git reads them here.
 */
function ignoresEntry(pattern) {
  return gitignore
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('#'))
    .some((line) => {
      const bare = line.replace(/^\/+/u, '').replace(/\/+$/u, '');
      return bare === pattern || bare === `**/${pattern}`;
    });
}

for (const required of ['.data', '.env*', 'node_modules']) {
  if (!ignoresEntry(required)) {
    failures.push(`.gitignore 未忽略 ${required}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Report                                                                     */
/* -------------------------------------------------------------------------- */

console.log(
  JSON.stringify(
    {
      ok: failures.length === 0,
      // `implemented + pending` are per path while `endpoints` is per method, so
      // report both totals rather than a `total` that does not add up.
      routes: {
        implemented,
        pending,
        paths: registryPaths.size,
        endpointMethods: apiRegistry.endpoints.length,
      },
      limitsChecked: Object.keys(limitsJson).length,
      errorCodesChecked: errorCodesJson.length,
      notes,
      failures,
    },
    null,
    2,
  ),
);

if (failures.length > 0) process.exitCode = 1;
