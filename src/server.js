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
const { DATA_DIR, SHARD_COUNT, shardPath } = require('./buildIndex');

const app = express();
const PORT = process.env.PORT || 3000;

const shards = []; // [{db, mtime}]

function openShards() {
  for (let i = 0; i < SHARD_COUNT; i++) {
    const p = shardPath(i);
    if (!fs.existsSync(p)) continue;
    const mtime = fs.statSync(p).mtimeMs;
    if (shards[i] && shards[i].mtime === mtime) continue;
    if (shards[i] && shards[i].db) shards[i].db.close();
    const db = new Database(p, { readonly: true });
    db.pragma('cache_size = -8000'); // 每个分片 8MB 缓存
    shards[i] = { db, mtime };
    console.log(`已开分片 ${i}：${p} @ ${new Date().toLocaleTimeString()}`);
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
  const minU = Math.max(0, Number(minUsage) || 0);
  const sortKey = ['composite_score', 'usage', 'segments', 'diversity_score'].includes(sort) ? sort : 'composite_score';
  const asc = order === 'asc';
  const p = Math.max(1, Number(page) || 1);
  const ps = Math.min(200, Math.max(1, Number(pageSize) || 50));

  const where = [];
  const params = {};
  wantTags.forEach((t, i) => {
    where.push(`s.tags LIKE $tag${i}`);
    params[`tag${i}`] = `%,${t},%`;
  });
  if (category) {
    where.push(`s.categories LIKE $cat`);
    params.cat = `%,${category},%`;
  }
  if (minU > 0) {
    where.push(`s.usage >= $minU`);
    params.minU = minU;
  }
  if (kw) {
    where.push(`s.text LIKE $kwLike`);
    params.kwLike = `%${kw}%`;
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const orderSql = `ORDER BY s.${sortKey} ${asc ? 'ASC' : 'DESC'} NULLS LAST`;

  // fan-out：每个分片跑 COUNT + 取前 ps 条（因为要跨分片排序）
  let total = 0;
  const candidates = [];
  for (const s of shards) {
    if (!s) continue;
    const cnt = s.db.prepare(`SELECT COUNT(*) c FROM strategies s ${whereSql}`).get(params).c;
    total += cnt;
    if (cnt > 0) {
      const rows = s.db.prepare(`SELECT * FROM strategies s ${whereSql} ${orderSql} LIMIT ?`).all(params, ps);
      candidates.push(...rows);
    }
  }

  // 跨分片合并排序
  candidates.sort((a, b) => {
    const d = (a[sortKey] || 0) - (b[sortKey] || 0);
    return asc ? d : -d;
  });
  const start = (p - 1) * ps;
  const list = candidates.slice(start, start + ps).map(rowify);

  res.json({ total, page: p, pageSize: ps, list });
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

app.listen(PORT, () => {
  console.log(`\n选股策略 Web 已启动：http://localhost:${PORT}`);
});
