/**
 * 选股策略 Web 服务（SQLite 分片版）
 *  - 打开 data/strategies_{0..N}.db 全部分片
 *  - 查询 fan-out 到所有分片，合并结果
 *  - mtime 检测：任一分片更新时重开该分片连接
 */
const express = require('express');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR, SHARD_COUNT, shardPath, normalizeText } = require('./buildIndex');
const { splitConditions } = require('../scripts/buildConditions');

const app = express();
app.use(express.json());
const PORT = process.env.PORT || 3000;

const shards = []; // [{db, mtime}]
let condDb = null;
let condMtime = 0;

function openShards() {
  for (let i = 0; i < SHARD_COUNT; i++) {
    const p = shardPath(i);
    if (!fs.existsSync(p)) continue;
    const mtime = fs.statSync(p).mtimeMs;
    if (shards[i] && shards[i].mtime === mtime) continue;
    if (shards[i] && shards[i].db) shards[i].db.close();
    const db = new Database(p, { readonly: true });
    db.pragma('cache_size = -8000'); // 每个分片 8MB 缓存
    db.pragma('busy_timeout = 3000'); // watch 增量写入时短暂持锁，只读连接稍等即可
    shards[i] = { db, mtime };
    console.log(`已开分片 ${i}：${p} @ ${new Date().toLocaleTimeString()}`);
  }
  // 子条件库
  const cp = path.join(DATA_DIR, 'conditions.db');
  if (fs.existsSync(cp)) {
    const cm = fs.statSync(cp).mtimeMs;
    if (!condDb || condMtime !== cm) {
      if (condDb) condDb.close();
      condDb = new Database(cp, { readonly: true });
      condDb.pragma('cache_size = -20000');
      condMtime = cm;
      console.log(`已开子条件库：${cp}`);
    }
  }
}

function ensureShardsFresh() {
  let changed = false;
  for (let i = 0; i < SHARD_COUNT; i++) {
    const p = shardPath(i);
    if (!fs.existsSync(p)) continue;
    const mtime = fs.statSync(p).mtimeMs;
    if (!shards[i] || shards[i].mtime !== mtime) {
      if (shards[i] && shards[i].db) shards[i].db.close();
      const db = new Database(p, { readonly: true });
      db.pragma('cache_size = -8000');
      db.pragma('busy_timeout = 3000');
      shards[i] = { db, mtime };
      changed = true;
    }
  }
  return changed;
}

console.log('打开分片数据库 ...');
openShards();
setInterval(() => {
  if (ensureShardsFresh()) console.log('检测到分片更新，已重开');
}, 2000);

app.use(express.static(path.join(__dirname, '..', 'public')));

function loadMeta() {
  const metaPath = path.join(DATA_DIR, 'meta.json');
  if (fs.existsSync(metaPath)) return JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  return { totalStrategies: 0, totalUsage: 0, categories: [], tagRules: [] };
}

app.get('/api/meta', (req, res) => {
  ensureShardsFresh();
  const meta = loadMeta();

  // 标签/大类统计：扫所有分片
  const tagStats = {};
  const catStats = {};
  for (const s of shards) {
    if (!s) continue;
    for (const row of s.db.prepare('SELECT tags, categories FROM strategies').iterate()) {
      for (const t of row.tags.split(',').filter(Boolean)) tagStats[t] = (tagStats[t] || 0) + 1;
      for (const c of row.categories.split(',').filter(Boolean)) catStats[c] = (catStats[c] || 0) + 1;
    }
  }

  res.json({
    totalStrategies: meta.totalStrategies,
    totalUsage: meta.totalUsage,
    generatedAt: meta.generatedAt,
    categories: meta.categories,
    tagRules: meta.tagRules,
    tagStats,
    catStats,
  });
});

/**
 * 搜索词处理：整段粘贴也要能查到。
 *  1. 用与入库同一套 normalizeText 归一化（全角→半角、压缩空白）
 *  2. 按逗号/分号/顿号/换行/"且" 切成若干"条件片段"
 *  3. 去掉被更长片段包含的冗余片段，控制 LIKE 数量
 * 返回片段数组，每条 SQL 用 s.text LIKE '%片段%'
 */
const MAX_FRAGMENTS = 30;

function splitQuery(raw) {
  const norm = normalizeText(raw || '');
  if (!norm) return [];
  let parts = norm
    .split(/[,;|、\n]+|(?:\s+且\s+)/)
    .map(s => s.trim())
    .filter(s => s.length >= 2);
  parts = [...new Set(parts)].sort((a, b) => b.length - a.length);
  // 长片段已包含短片段时，短片段不再单独作为 LIKE 条件（条件数从 30 降到 5~10，快很多）
  const kept = [];
  for (const frag of parts) {
    if (kept.some(k => k.includes(frag))) continue;
    kept.push(frag);
    if (kept.length >= MAX_FRAGMENTS) break;
  }
  return kept;
}

app.get('/api/strategies', (req, res) => {
  ensureShardsFresh();
  const {
    tags,
    category,
    q,
    minUsage = 0,
    sort = 'composite_score',
    order = 'desc',
    page = 1,
    pageSize = 50,
  } = req.query;

  const wantTags = tags ? tags.split(',').map(s => s.trim()).filter(Boolean) : [];
  const kw = (q || '').trim();
  const fragments = splitQuery(kw);
  const minU = Math.max(0, Number(minUsage) || 0);
  // 前端传的是驼峰（compositeScore / diversityScore），DB 列是下划线，统一映射
  const SORT_MAP = {
    composite_score: 'composite_score',
    compositeScore: 'composite_score',
    usage: 'usage',
    segments: 'segments',
    diversity_score: 'diversity_score',
    diversityScore: 'diversity_score',
  };
  const sortKey = SORT_MAP[sort] || 'composite_score';
  const asc = order === 'asc';
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(200, Math.max(1, Number(pageSize) || 50));

  const baseWhere = [];
  const baseParams = {};
  wantTags.forEach((t, i) => {
    baseWhere.push(`s.tags LIKE $tag${i}`);
    baseParams[`tag${i}`] = `%,${t},%`;
  });
  if (category) {
    baseWhere.push(`s.categories LIKE $cat`);
    baseParams.cat = `%,${category},%`;
  }
  if (minU > 0) {
    baseWhere.push(`s.usage >= $minU`);
    baseParams.minU = minU;
  }

  // 关键词：片段之间 AND（整段策略粘贴时必须全部命中）；全不命中再降级 OR 做宽松匹配
  const kwWhere = [];
  const kwParams = {};
  fragments.forEach((f, i) => {
    kwWhere.push(`s.text LIKE $q${i}`);
    kwParams[`q${i}`] = `%${f}%`;
  });

  const orderSql = `ORDER BY s.${sortKey} ${asc ? 'ASC' : 'DESC'} NULLS LAST`;

  function runQuery(whereSql, params, extraSelect = '', extraOrder = '') {
    let total = 0;
    const candidates = [];
    for (const s of shards) {
      if (!s) continue;
      const cnt = s.db.prepare(`SELECT COUNT(*) c FROM strategies s ${whereSql}`).get(params).c;
      total += cnt;
      if (cnt > 0) {
        const rows = s.db
          .prepare(`SELECT * ${extraSelect} FROM strategies s ${whereSql} ${extraOrder || orderSql} LIMIT ?`)
          .all(params, ps);
        candidates.push(...rows);
      }
    }
    return { total, candidates };
  }

  const andWhere = [...baseWhere, ...kwWhere];
  const andParams = { ...baseParams, ...kwParams };
  const whereSql = andWhere.length ? 'WHERE ' + andWhere.join(' AND ') : '';
  let mode = fragments.length ? 'and' : 'none';
  let { total, candidates } = runQuery(whereSql, andParams);

  // 降级：只有"像整段粘贴"（片段足够多）时才宽松召回，
  // 取最长的 12 个片段做命中计数，并要求至少命中 60%，否则视为无关。
  if (total === 0 && fragments.length > 4) {
    const loose = fragments.slice(0, 12); // fragments 已按长度降序
    const minHits = Math.max(2, Math.ceil(loose.length * 0.6));
    const orWhere = [];
    const orParams = {};
    loose.forEach((f, i) => {
      orWhere.push(`s.text LIKE $q${i}`);
      orParams[`q${i}`] = `%${f}%`;
    });
    const hitExpr = loose.map((_, i) => `(CASE WHEN s.text LIKE $q${i} THEN 1 ELSE 0 END)`).join(' + ');
    const allWhere = [...baseWhere, `(${orWhere.join(' OR ')})`, `(${hitExpr}) >= $minHits`];
    const allParams = { ...baseParams, ...orParams, minHits };
    const res2 = runQuery(
      'WHERE ' + allWhere.join(' AND '),
      allParams,
      `, (${hitExpr}) AS hits`,
      `ORDER BY hits DESC, s.${sortKey} ${asc ? 'ASC' : 'DESC'} NULLS LAST`
    );
    total = res2.total;
    candidates = res2.candidates;
    mode = 'or';
  }

  // 跨分片合并排序（OR 模式先按命中片段数）
  candidates.sort((a, b) => {
    if (mode === 'or') {
      const dh = (b.hits || 0) - (a.hits || 0);
      if (dh) return dh;
    }
    const d = (a[sortKey] || 0) - (b[sortKey] || 0);
    return asc ? d : -d;
  });
  const start = (p - 1) * ps;
  const list = candidates.slice(start, start + ps).map(rowify);

  res.json({ total, page: p, pageSize: ps, list, queryMode: mode, fragments: fragments.length });
});

function rowify(r) {
  return {
    id: r.id,
    title: r.title,
    text: r.text,
    usage: r.usage,
    tags: r.tags.split(',').filter(Boolean),
    categories: r.categories.split(',').filter(Boolean),
    style: r.style,
    buyTiming: r.buy_timing,
    sellTiming: r.sell_timing,
    holdingPeriod: r.holding_period,
    riskLevel: r.risk_level,
    stopLoss: r.stop_loss,
    takeProfit: r.take_profit,
    segments: r.segments,
    compositeScore: r.composite_score,
    usageScore: r.usage_score,
    complexityScore: r.complexity_score,
    diversityScore: r.diversity_score,
    hasFundamental: !!r.has_fundamental,
  };
}

app.get('/api/strategy/:id', (req, res) => {
  ensureShardsFresh();
  // id 在分片间不唯一，只返回第一命中（前端一般只用列表数据，不查详情）
  for (const s of shards) {
    if (!s) continue;
    const r = s.db.prepare('SELECT * FROM strategies WHERE id = ?').get(req.params.id);
    if (r) return res.json(rowify(r));
  }
  res.status(404).json({ error: 'not found' });
});

// 拆分策略为子条件并返回每个子条件的分析
app.post('/api/split', (req, res) => {
  ensureShardsFresh();
  const text = String(req.body?.text || '');
  const parts = splitConditions(text);
  if (!parts.length) return res.json({ conditions: [] });

  // 批量查 conditions.db
  const stmt = condDb
    ? condDb.prepare('SELECT text, freq, scope, value, func, features, limitations, range FROM conditions WHERE text = ?')
    : null;
  const conditions = parts.map(p => {
    const hit = stmt ? stmt.get(p) : null;
    return hit || {
      text: p, freq: 0, scope: '其他条件', value: '', func: '',
      features: '', limitations: '', range: '',
    };
  });
  res.json({ conditions });
});

app.listen(PORT, () => {
  console.log(`\n选股策略 Web 已启动：http://localhost:${PORT}`);
});
