// Synthetic benchmark seeding (T079-R03).
//
// Writes a throwaway data directory with a chosen number of notes plus the
// largest projection each view claims to draw, so the performance cases measure
// a *stated* scale instead of whatever a screenshot happened to show.
//
// Three decisions worth stating, because each is a correctness rule:
//
//  1. **It refuses the user's real `.data`.** The directory is checked against
//     the same definition the app uses (`<project root>/.data`), not against a
//     string pattern: this script exists to write thousands of fake rows, and the
//     one directory it must never write is the owner's library. `--force` does not
//     exist on purpose.
//
//  2. **It goes through the real migration, not a copied schema.** The tables are
//     created by executing `src/server/db/migrations/001_initial.sql` and setting
//     `user_version`, exactly as the runner does. Hand-copying the DDL here would
//     let a seed that satisfies *this file* insert rows the app then rejects.
//
//  3. **It is non-destructive by default.** An existing `brain.db` is refused
//     unless `--reset` is passed, so re-running cannot silently mix two scales —
//     a "median" over 500 and 5000 rows is not a measurement of either.
//
// `node:sqlite` and `node:fs` only: like `inspect-data.mjs`, this has to run on a
// machine with no build and no `node_modules`.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Mirrors `src/server/runtime/dataDir.ts` — the guard must not drift from it. */
function isUserDataDir(dataDir) {
  return path.resolve(dataDir) === path.resolve(path.join(projectRoot, '.data'));
}

export function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    if (key === 'reset') {
      values.reset = true;
      continue;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new Error(`参数 --${key} 缺少值`);
    }
    values[key] = next;
    index += 1;
  }
  return values;
}

function positiveInt(raw, label, { allowZero = false } = {}) {
  const value = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(value) || (allowZero ? value < 0 : value < 1)) {
    throw new Error(`${label} 必须是${allowZero ? '非负' : '正'}整数，收到 ${raw}`);
  }
  return value;
}

/**
 * Translate mixed Chinese/English material.
 *
 * The search cases need needles that exist at every scale, and a needle must be
 * rare enough that "found it" is about the query and not about a term that
 * happens to be in every row.
 */
const TOPICS = [
  '数据库索引',
  '输入法组合',
  '投影新鲜度',
  '本地优先',
  '事务边界',
  '提示词注入',
  '时间线排序',
  '关系证据',
  '导出白名单',
  '失败层级',
];
const SHAPES = ['观察', '疑问', '决定', '引用', '待办'];

function rawTextFor(index) {
  const topic = TOPICS[index % TOPICS.length];
  const shape = SHAPES[index % SHAPES.length];
  // Padding makes the row realistically wide without approaching the 10000-code-point
  // CHECK; a 20-character row would make the search cases measure less than reality.
  return `${shape} ${index}：关于「${topic}」的记录，用于规模基准。${'补充说明。'.repeat(index % 7)}`;
}

function isoAt(index) {
  // Spread capture times so `created_at DESC` ordering is meaningful and so the
  // "newest first" page is not an artefact of identical timestamps.
  return new Date(Date.UTC(2026, 0, 1) + index * 60_000).toISOString();
}

function migrationSql() {
  const file = path.join(projectRoot, 'src', 'server', 'db', 'migrations', '001_initial.sql');
  return readFileSync(file, 'utf8');
}

function openDatabase(databasePath) {
  const db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 10000');
  const version = db.prepare('PRAGMA user_version').get()?.user_version ?? 0;
  if (version === 0) {
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(migrationSql());
      db.exec('PRAGMA user_version = 1');
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // The original failure is the one worth reporting.
      }
      throw error;
    }
  }
  return db;
}

export function seed(options) {
  const { dataDir, items, graphNodes, graphEdges, mindmapNodes, flowNodes, flowEdges } = options;
  const resolved = path.resolve(dataDir);
  if (isUserDataDir(resolved)) {
    throw new Error(`拒绝写入用户真实数据目录：${resolved}（基准种子只能进临时目录）`);
  }

  const databasePath = path.join(resolved, 'brain.db');
  if (existsSync(databasePath) && options.reset !== true) {
    throw new Error(
      `目标已有 brain.db：${databasePath}。不同规模的样本不能混在一起，` +
        `请换一个目录，或显式加 --reset 重建。`,
    );
  }
  if (options.reset === true && existsSync(resolved)) {
    rmSync(resolved, { recursive: true, force: true });
    // Do not remove a stray file the user may have put there deliberately.
  }
  mkdirSync(resolved, { recursive: true });

  const db = openDatabase(databasePath);
  const now = new Date().toISOString();
  const itemIds = [];

  db.exec('BEGIN IMMEDIATE');
  try {
    const insertItem = db.prepare(
      `INSERT INTO knowledge_items (
         id, capture_request_id, capture_request_hash, captured_text, raw_text,
         raw_version, revision, structured_base_raw_version, title, summary, type,
         keywords_json, importance, manual_fields_json, status, last_run_id,
         error_code, error_message, source_type, source_ref, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 1, 1, NULL, '', '', ?, '[]', 3, '[]', 'raw', NULL,
                 NULL, NULL, 'other', NULL, ?, ?)`,
    );
    for (let index = 0; index < items; index += 1) {
      const id = crypto.randomUUID();
      itemIds.push(id);
      const text = rawTextFor(index);
      const at = isoAt(index);
      insertItem.run(
        id,
        crypto.randomUUID(),
        `bench-${index}`,
        text,
        text,
        TOPICS[index % TOPICS.length] === '待办' ? 'todo' : 'idea',
        at,
        at,
      );
    }

    const insertTag = db.prepare(
      'INSERT INTO tags (id, label, normalized, created_at) VALUES (?, ?, ?, ?)',
    );
    const insertItemTag = db.prepare(
      'INSERT INTO item_tags (item_id, tag_id, position) VALUES (?, ?, ?)',
    );
    /*
     * `item_tags` is UNIQUE per (item_id, position), so an item cannot wear two
     * tags at position 0. Positions are tracked per item here and filled 0,1,2…:
     * the seed labels the same record for several scopes (its topic, plus the
     * graph/mindmap/flow scope), and a fixed position would abort the whole run
     * with a UNIQUE violation instead of producing a realistic multi-tag row.
     */
    const positions = new Map();
    const attachTag = (itemId, tagId) => {
      const next = positions.get(itemId) ?? 0;
      if (next > 7) return;
      insertItemTag.run(itemId, tagId, next);
      positions.set(itemId, next + 1);
    };
    const tagIds = [];
    for (const topic of TOPICS) {
      const tagId = crypto.randomUUID();
      tagIds.push(tagId);
      insertTag.run(tagId, topic, topic.toLowerCase(), now);
    }

    // Graph scope: exactly `graphNodes` records behind one tag, so the read is a
    // filter query at the documented maximum rather than an id list.
    const graphIds = itemIds.slice(0, graphNodes);
    if (graphIds.length < graphNodes) {
      throw new Error(`样本条目不足以支撑 ${graphNodes} 个图节点（只有 ${itemIds.length} 条）`);
    }
    const graphTagId = crypto.randomUUID();
    insertTag.run(graphTagId, '基准图范围', '基准图范围', now);
    for (const itemId of graphIds) attachTag(itemId, graphTagId);

    // Distribute every item over the topic tags so tag-filtered queries have data.
    for (let index = 0; index < itemIds.length; index += 1) {
      attachTag(itemIds[index], tagIds[index % tagIds.length]);
    }

    // Edges: `graphEdges` AI relations with a chain plus chords. The unique index
    // on (source,target,type) and the symmetric-type ordering rule are respected
    // by construction; a duplicate would abort the whole seed.
    const insertRelation = db.prepare(
      `INSERT INTO relations (
         id, source_id, target_id, relation_type, origin, review_status, score, reason,
         evidence_json, source_raw_version, target_raw_version, run_id, revision,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'related_to', 'ai', 'accepted', 0.8, ?, '[]', 1, 1, NULL, 1, ?, ?)`,
    );
    let edgesWritten = 0;
    const seen = new Set();
    const relationIds = [];
    outer: for (let step = 1; step < graphNodes && edgesWritten < graphEdges; step += 1) {
      for (let index = 0; index + step < graphNodes && edgesWritten < graphEdges; index += 1) {
        const left = graphIds[index];
        const right = graphIds[index + step];
        // `related_to` is symmetric, so the schema requires source < target.
        const [source, target] = left < right ? [left, right] : [right, left];
        const key = `${source}|${target}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const relationId = crypto.randomUUID();
        relationIds.push(relationId);
        insertRelation.run(
          relationId,
          source,
          target,
          '基准用合成关系',
          isoAt(index),
          isoAt(index),
        );
        edgesWritten += 1;
        if (edgesWritten >= graphEdges) break outer;
      }
    }

    // A graph view scoped by the tag, so the graph page adopts it on mount and no
    // case has to hand a 200-id selection through the UI.
    //
    // The snapshot is the graph's own sources: the items behind the tag whose
    // relations are drawn, plus those relations. An *empty* snapshot would be a
    // state no real generation path can produce (the route builds one from the
    // captured sources), and it made freshness reads report "nothing went in"
    // instead of the truth -- so a benchmark view must carry a real one.
    db.prepare(
      `INSERT INTO views (
         id, name, kind, selection_json, source_snapshot_json, content_json, content_hash,
         renderer_version, prompt_version, run_id, revision, generated_at, created_at, updated_at
       ) VALUES (?, ?, 'graph', ?, ?, '{}', NULL, 'graph-reactflow-dagre-v1', NULL, NULL, 1, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      `基准图 ${graphNodes} 节点`,
      JSON.stringify({ mode: 'filter', filter: { tagId: graphTagId } }),
      JSON.stringify({
        items: graphIds.map((id) => ({ id, rawVersion: 1, revision: 1 })),
        relations: relationIds.map((id) => ({ id, revision: 1 })),
      }),
      now,
      now,
      now,
    );

    /*
     * Mindmap: one root plus a fan-out of `mindmapNodes` total nodes.
     *
     * Every node must cite at least one real item, and a group's `itemIds` is the
     * union of its subtree — so the shape is root → topic groups → leaves, all
     * drawn from the items that exist.
     */
    const mindmapTagId = crypto.randomUUID();
    insertTag.run(mindmapTagId, '基准脑图范围', '基准脑图范围', now);
    const mindmapIds = itemIds.slice(0, Math.min(mindmapNodes, itemIds.length));
    for (const itemId of mindmapIds) attachTag(itemId, mindmapTagId);
    const groups = Math.max(1, Math.min(TOPICS.length, mindmapNodes - 1));
    const nodes = [];
    const groupChildren = Array.from({ length: groups }, () => []);
    for (let index = 1; index < mindmapNodes; index += 1) {
      const groupIndex = (index - 1) % groups;
      const id = `n${index}`;
      groupChildren[groupIndex].push(id);
      nodes.push({
        id,
        parentId: `g${groupIndex + 1}`,
        label: `${TOPICS[groupIndex]} 要点 ${index}`,
        itemIds: [mindmapIds[index % mindmapIds.length]],
        kind: 'note',
      });
    }
    const groupNodes = Array.from({ length: groups }, (_, groupIndex) => {
      const cite = groupChildren[groupIndex].map((id) => nodes.find((node) => node.id === id).itemIds[0]);
      return {
        id: `g${groupIndex + 1}`,
        parentId: 'root',
        label: TOPICS[groupIndex],
        itemIds: cite.length > 0 ? cite : [mindmapIds[groupIndex % mindmapIds.length]],
        kind: 'group',
      };
    });
    const mindmapContent = {
      title: `基准脑图 ${mindmapNodes} 节点`,
      nodes: [
        {
          id: 'root',
          parentId: null,
          label: '基准主题',
          itemIds: [...new Set(groupNodes.flatMap((group) => group.itemIds))],
          kind: 'group',
        },
        ...groupNodes,
        ...nodes,
      ],
    };
    db.prepare(
      `INSERT INTO views (
         id, name, kind, selection_json, source_snapshot_json, content_json, content_hash,
         renderer_version, prompt_version, run_id, revision, generated_at, created_at, updated_at
       ) VALUES (?, ?, 'mindmap', ?, ?, ?, NULL, 'mindmap-markmap-v1', 'mindmap-v1', NULL, 1, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      `基准脑图 ${mindmapNodes} 节点`,
      JSON.stringify({ mode: 'filter', filter: { tagId: mindmapTagId } }),
      JSON.stringify({
        items: mindmapIds.map((id) => ({ id, rawVersion: 1, revision: 1 })),
        relations: [],
      }),
      JSON.stringify(mindmapContent),
      now,
      now,
      now,
    );

    // Flow: `flowNodes` nodes with `flowEdges` arrows, all citing real items.
    const flowTagId = crypto.randomUUID();
    insertTag.run(flowTagId, '基准流程范围', '基准流程范围', now);
    const flowIds = itemIds.slice(0, Math.min(flowNodes, itemIds.length));
    for (const itemId of flowIds) attachTag(itemId, flowTagId);
    const flowNodeIds = Array.from({ length: flowNodes }, (_, index) => `f${index}`);
    const flowContent = {
      title: `基准流程 ${flowNodes} 节点`,
      direction: 'LR',
      nodes: flowNodeIds.map((id, index) => ({
        id,
        label: `步骤 ${index}`,
        itemIds: [flowIds[index % flowIds.length]],
      })),
      edges: Array.from({ length: flowEdges }, (_, index) => ({
        source: flowNodeIds[index % flowNodes],
        target: flowNodeIds[(index + 1) % flowNodes],
        kind: 'sequence',
        label: `先后 ${index}`,
        itemIds: [flowIds[index % flowIds.length]],
        relationIds: [],
      })),
    };
    db.prepare(
      `INSERT INTO views (
         id, name, kind, selection_json, source_snapshot_json, content_json, content_hash,
         renderer_version, prompt_version, run_id, revision, generated_at, created_at, updated_at
       ) VALUES (?, ?, 'flow', ?, ?, ?, NULL, 'flow-mermaid-v1', 'flow-v1', NULL, 1, ?, ?, ?)`,
    ).run(
      crypto.randomUUID(),
      `基准流程 ${flowNodes} 节点`,
      JSON.stringify({ mode: 'filter', filter: { tagId: flowTagId } }),
      JSON.stringify({
        items: flowIds.map((id) => ({ id, rawVersion: 1, revision: 1 })),
        relations: [],
      }),
      JSON.stringify(flowContent),
      now,
      now,
      now,
    );

    db.prepare("UPDATE app_meta SET value = CAST(? AS TEXT) WHERE key = 'dataset_revision'").run(
      String(1 + items + edgesWritten),
    );
    db.exec('COMMIT');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // Keep the original error.
    }
    db.close();
    throw error;
  }

  const sizeBytes = statSync(databasePath).size;
  db.close();

  return {
    dataDir: resolved,
    databasePath,
    counts: {
      items: itemIds.length,
      relations: graphEdges,
      graphTag: graphNodes,
      mindmapNodes,
      flowNodes,
    },
    sizeBytes,
  };
}

function main() {
  let values;
  try {
    values = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`SEED_FAILED: ${error.message}`);
    process.exitCode = 2;
    return;
  }

  const dataDir = values['data-dir'] ?? path.join(projectRoot, '.tmp-benchmark-data');
  try {
    const result = seed({
      dataDir,
      items: positiveInt(values.items ?? '1000', '--items'),
      graphNodes: positiveInt(values.graph ?? '200', '--graph'),
      graphEdges: positiveInt(values['graph-edges'] ?? '600', '--graph-edges', { allowZero: true }),
      mindmapNodes: positiveInt(values.mindmap ?? '120', '--mindmap'),
      flowNodes: positiveInt(values.flow ?? '40', '--flow'),
      flowEdges: positiveInt(values['flow-edges'] ?? '80', '--flow-edges', { allowZero: true }),
      reset: values.reset === true,
    });
    console.log(
      `已写入 ${result.dataDir}\n` +
        `  条目 ${result.counts.items}、关系 ${result.counts.relations}、` +
        `脑图 ${result.counts.mindmapNodes} 节点、流程 ${result.counts.flowNodes} 节点\n` +
        `  数据库 ${(result.sizeBytes / 1024).toFixed(1)} KiB`,
    );
  } catch (error) {
    console.error(`SEED_FAILED: ${error.message}`);
    process.exitCode = 1;
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]).endsWith(path.join('scripts', 'seed-benchmark.mjs'));

if (isMain) main();
