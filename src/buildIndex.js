/**
 * 索引构建核心：读取原始数据 → 规范化 → 去重 → 打标签 → 算评分 → 分片写入 SQLite
 * 分片：按 hash(text) % SHARD_COUNT 分到 strategies_0.db ... strategies_7.db
 *
 * 对外能力分两层：
 *   1) 全量：buildIndex()            —— 一次性导入（scripts/import.js）
 *   2) 增量：applyEntries()          —— 只写"本次变化"的条目（scripts/watch.js / src/indexer.js）
 *      applyEntriesAsync()          —— 同上，但按块让出事件循环（真异步，不阻塞 watch 事件）
 *
 * 增量写入原则：只打开「有变化」的分片，只 commit「有变化」的行；
 * 已存在的行若 usage 变大，同步修正 usage_score / composite_score。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { TAG_RULES } = require('./tagRules');
const { inferAdvice } = require('./aiAdvice');

const XGTJ_PATH = process.env.XGTJ_PATH || path.join(os.homedir(), 'MyWork/goSqlite_gorm/config/xgTj.json');
const STRATEGY_DIR = process.env.STRATEGY_DIR || path.join(os.homedir(), 'MyWork/goSqlite_gorm/策略');
const DATA_DIR = path.join(__dirname, '..', 'data');
const SHARD_COUNT = Number(process.env.SHARD_COUNT || 8);
const META_PATH = path.join(DATA_DIR, 'meta.json');
const CHUNK_SIZE = Number(process.env.INDEX_CHUNK || 500);

const COMPILED = TAG_RULES.map(r => ({
  ...r,
  keywordsLower: r.keywords.map(k => k.toLowerCase()),
}));
const TOTAL_CATS = new Set(COMPILED.map(r => r.category)).size;

/* ------------------------------- 文本处理 ------------------------------- */

function normalizeText(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/[\uFF01-\uFF5E]/g, ch =>
    String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)
  );
  s = s.replace(/\u3000/g, ' ');
  s = s
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[「」]/g, '"')
    .replace(/[〈〉]/g, '<>')
    .replace(/[【】]/g, '[]');
  s = s.replace(/\s+/g, ' ');
  return s.trim();
}

function textHash(text) {
  return crypto.createHash('md5').update(text).digest('hex').slice(0, 12);
}

function tagOf(text) {
  const lower = text.toLowerCase();
  const hits = new Set();
  const cats = new Set();
  for (const rule of COMPILED) {
    for (const kw of rule.keywordsLower) {
      if (lower.includes(kw)) {
        hits.add(rule.tag);
        cats.add(rule.category);
        break;
      }
    }
  }
  return { tags: [...hits], categories: [...cats] };
}

function segmentCount(text) {
  const parts = text.split(/[;；,，\n]|\bAND\b|\band\b/);
  return parts.map(s => s.trim()).filter(s => s.length >= 2).length;
}

function shortTitle(text) {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 48 ? clean.slice(0, 48) + '…' : clean;
}

function shardOf(text) {
  const h = crypto.createHash('md5').update(text).digest();
  return h.readUInt8(0) % SHARD_COUNT;
}

function shardPath(i) {
  return path.join(DATA_DIR, `strategies_${i}.db`);
}

/* --------------------------------- 表结构 -------------------------------- */

function buildSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      categories TEXT NOT NULL DEFAULT '',
      style TEXT DEFAULT '',
      buy_timing TEXT DEFAULT '',
      sell_timing TEXT DEFAULT '',
      holding_period TEXT DEFAULT '',
      risk_level TEXT DEFAULT '',
      stop_loss TEXT DEFAULT '',
      take_profit TEXT DEFAULT '',
      usage INTEGER DEFAULT 0,
      segments INTEGER DEFAULT 0,
      usage_score REAL,
      complexity_score REAL,
      diversity_score REAL,
      has_fundamental INTEGER DEFAULT 0,
      composite_score REAL
    );
    CREATE INDEX IF NOT EXISTS idx_strategies_usage ON strategies(usage DESC);
    CREATE INDEX IF NOT EXISTS idx_strategies_composite ON strategies(composite_score DESC);
    CREATE INDEX IF NOT EXISTS idx_strategies_segments ON strategies(segments DESC);
    CREATE INDEX IF NOT EXISTS idx_strategies_style ON strategies(style);
    CREATE INDEX IF NOT EXISTS idx_strategies_risk ON strategies(risk_level);
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  `);
}

/** 写连接：只给"本次有变化"的分片用 */
function openShard(i, { create = false } = {}) {
  const p = shardPath(i);
  if (!create && !fs.existsSync(p)) return null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(p);
  db.pragma('journal_mode = DELETE'); // 服务端只读连接 + mtime 热重载，DELETE 模式最省事
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('cache_size = -8000');
  buildSchema(db);
  return db;
}

function readMeta() {
  try {
    return JSON.parse(fs.readFileSync(META_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function maxUsageFromMeta() {
  const m = readMeta();
  return Number(m.maxUsage || 0) || 1;
}

/* ------------------------------- 行数据生成 ------------------------------- */

/**
 * 生成一行完整的 DB 数据（标签、评分、AI 建议都已算好）
 * @param {string} text 规范化后的策略原文
 * @param {number} usage 使用次数
 * @param {number} maxUsage 全局最大使用次数（用于归一化 usage_score）
 */
function prepareEntry(text, usage, maxUsage) {
  const u = Number(usage) || 0;
  const logMaxUsage = Math.log10(1 + Math.max(1, maxUsage));
  const { tags, categories } = tagOf(text);
  const segs = segmentCount(text);
  const usageScore = Math.log10(1 + u) / logMaxUsage;
  const complexityScore = Math.min(1, segs / 15);
  const diversityScore = categories.length / TOTAL_CATS;
  const hasFundamental = categories.includes('财务基本面') || categories.includes('成长');
  const compositeScore =
    0.35 * usageScore +
    0.20 * complexityScore +
    0.25 * diversityScore +
    0.20 * (hasFundamental ? 1 : 0);
  const advice = inferAdvice(tags, categories, text);

  return {
    text,
    title: shortTitle(text),
    tags: ',' + tags.join(',') + ',',
    categories: ',' + categories.join(',') + ',',
    style: advice.style,
    buyTiming: advice.buyTiming,
    sellTiming: advice.sellTiming,
    holdingPeriod: advice.holdingPeriod,
    riskLevel: advice.riskLevel,
    stopLoss: advice.stopLoss,
    takeProfit: advice.takeProfit,
    usage: u,
    segments: segs,
    usageScore,
    complexityScore,
    diversityScore,
    hasFundamental: hasFundamental ? 1 : 0,
    compositeScore,
  };
}

/** 只修正 usage 变化后的两个评分字段（不重复打标签，增量更轻） */
function rescoreUsage(row, usage, maxUsage) {
  const usageScore = Math.log10(1 + usage) / Math.log10(1 + Math.max(1, maxUsage));
  const compositeScore =
    0.35 * usageScore +
    0.20 * (row.complexity_score || 0) +
    0.25 * (row.diversity_score || 0) +
    0.20 * (row.has_fundamental ? 1 : 0);
  return { usage, usageScore, compositeScore };
}

/* -------------------------------- 分片写入 ------------------------------- */

function prepareStatements(db) {
  return {
    exist: db.prepare(
      'SELECT usage, complexity_score, diversity_score, has_fundamental FROM strategies WHERE text = ?'
    ),
    touch: db.prepare(
      'UPDATE strategies SET usage = @usage, usage_score = @usageScore, composite_score = @compositeScore WHERE text = @text'
    ),
    insert: db.prepare(`
      INSERT OR IGNORE INTO strategies
        (text, title, tags, categories, style, buy_timing, sell_timing, holding_period,
         risk_level, stop_loss, take_profit, usage, segments, usage_score, complexity_score,
         diversity_score, has_fundamental, composite_score)
      VALUES (@text, @title, @tags, @categories, @style, @buyTiming, @sellTiming, @holdingPeriod,
         @riskLevel, @stopLoss, @takeProfit, @usage, @segments, @usageScore, @complexityScore,
         @diversityScore, @hasFundamental, @compositeScore)
    `),
  };
}

/** 一个 chunk 内的写入逻辑（由调用方包在事务里执行） */
function writeChunk(stmts, chunk, maxUsage, stats) {
  for (const e of chunk) {
    const row = stmts.exist.get(e.text);
    if (row) {
      const newUsage = Math.max(row.usage || 0, e.usage || 0);
      if (newUsage > (row.usage || 0)) {
        stmts.touch.run({ ...rescoreUsage(row, newUsage, maxUsage), text: e.text });
        stats.updated++;
      } else {
        stats.skipped++;
      }
      continue;
    }
    stmts.insert.run(e.row);
    stats.added++;
  }
}

/** 把 entries 按分片分桶，同时定稿本批 maxUsage */
function planEntries(entries, baseMaxUsage) {
  const buckets = Array.from({ length: SHARD_COUNT }, () => []);
  let maxUsage = Math.max(1, Number(baseMaxUsage) || 1);
  const seen = new Set();

  for (const e of entries) {
    if (!e || !e.text) continue;
    if (seen.has(e.text)) continue; // 同批内去重
    seen.add(e.text);
    const usage = Number(e.usage) || 0;
    if (usage > maxUsage) maxUsage = usage;
    buckets[shardOf(e.text)].push({ text: e.text, usage, row: null });
  }
  // maxUsage 定稿后再生成行数据，保证同批内 usage_score 归一化一致
  for (const bucket of buckets) {
    for (const item of bucket) item.row = prepareEntry(item.text, item.usage, maxUsage);
  }
  return { buckets, maxUsage };
}

function emptyStats() {
  return { added: 0, updated: 0, skipped: 0, touched: [], maxUsage: 1 };
}

function touchShardMeta(db, i) {
  const stmt = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)');
  stmt.run('shardIndex', String(i));
  stmt.run('totalShards', String(SHARD_COUNT));
  stmt.run('lastWriteAt', new Date().toISOString());
}

/**
 * 同步增量写入（import.js 用）
 * @returns {{added:number,updated:number,skipped:number,touched:number[],maxUsage:number}}
 */
function applyEntries(entries, opts = {}) {
  const stats = emptyStats();
  const baseMax = opts.maxUsage || maxUsageFromMeta();
  const { buckets, maxUsage } = planEntries(entries, baseMax);

  for (let i = 0; i < SHARD_COUNT; i++) {
    const bucket = buckets[i];
    if (!bucket.length) continue; // ★ 没变化的分片：不开库、不写盘
    const db = openShard(i, { create: true });
    if (!db) continue;
    const stmts = prepareStatements(db);
    const tx = db.transaction(chunk => writeChunk(stmts, chunk, maxUsage, stats));
    for (let off = 0; off < bucket.length; off += CHUNK_SIZE) {
      tx(bucket.slice(off, off + CHUNK_SIZE));
    }
    touchShardMeta(db, i);
    stats.touched.push(i);
    db.close();
  }
  stats.maxUsage = maxUsage;
  return stats;
}

/**
 * 异步分块增量写入：每个 chunk 一个事务，块之间 setImmediate 让出事件循环，
 * 长事务不会卡住 watch 事件、HTTP 与日志。
 */
async function applyEntriesAsync(entries, opts = {}) {
  const stats = emptyStats();
  const baseMax = opts.maxUsage || maxUsageFromMeta();
  const { buckets, maxUsage } = planEntries(entries, baseMax);
  const yieldNow = () => new Promise(resolve => setImmediate(resolve));

  for (let i = 0; i < SHARD_COUNT; i++) {
    const bucket = buckets[i];
    if (!bucket.length) continue;
    const db = openShard(i, { create: true });
    if (!db) continue;
    const stmts = prepareStatements(db);
    const tx = db.transaction(chunk => writeChunk(stmts, chunk, maxUsage, stats));
    for (let off = 0; off < bucket.length; off += CHUNK_SIZE) {
      tx(bucket.slice(off, off + CHUNK_SIZE));
      await yieldNow();
    }
    touchShardMeta(db, i);
    stats.touched.push(i);
    db.close();
  }
  stats.maxUsage = maxUsage;
  return stats;
}

/* --------------------------------- meta --------------------------------- */

/** 统计所有分片真实总量并写 data/meta.json（增量模式下 entries 只是"本次来源"） */
function writeMeta(extra = {}) {
  const shardSizes = [];
  let dbTotal = 0;
  let dbTotalUsage = 0;
  for (let i = 0; i < SHARD_COUNT; i++) {
    const p = shardPath(i);
    if (!fs.existsSync(p)) {
      shardSizes.push(0);
      continue;
    }
    const db = new Database(p, { readonly: true });
    const c = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(usage),0) u FROM strategies').get();
    db.close();
    dbTotal += c.c;
    dbTotalUsage += c.u;
    shardSizes.push(c.c);
  }

  const prev = readMeta();
  const meta = {
    generatedAt: new Date().toISOString(),
    totalStrategies: dbTotal,
    totalUsage: dbTotalUsage,
    maxUsage: Math.max(Number(extra.maxUsage || prev.maxUsage || 0), 1),
    shardCount: SHARD_COUNT,
    categories: TAG_RULES.map(r => r.category).filter((v, i, a) => a.indexOf(v) === i),
    tagRules: TAG_RULES.map(r => ({ tag: r.tag, category: r.category })),
    shardSizes,
    ...extra,
  };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = META_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(meta, null, 2)); // 原子替换，服务端不会读到半个 JSON
  fs.renameSync(tmp, META_PATH);
  return meta;
}

/** 确保 8 个分片文件都存在（首次构建时服务端即可见） */
function ensureAllShards() {
  for (let i = 0; i < SHARD_COUNT; i++) {
    if (fs.existsSync(shardPath(i))) continue;
    const db = openShard(i, { create: true });
    if (db) db.close();
  }
}

/* -------------------------------- 全量导入 ------------------------------- */

/** 从 xgTj.json + 策略目录收集全部条目（规范化 + 去重 + usage 取最大） */
function collectSources() {
  const entries = [];
  const seen = new Set();
  let rawFromXgtj = 0;

  const xg = JSON.parse(fs.readFileSync(XGTJ_PATH, 'utf8'));
  const normUsageMap = new Map();
  for (const [text, usage] of Object.entries(xg)) {
    rawFromXgtj++;
    const t = normalizeText(text);
    if (!t) continue;
    const u = Number(usage) || 0;
    normUsageMap.set(t, Math.max(normUsageMap.get(t) || 0, u));
  }
  for (const [t, u] of normUsageMap) {
    seen.add(t);
    entries.push({ text: t, usage: u });
  }
  const mergedFromXgtj = rawFromXgtj - normUsageMap.size;

  const txtFiles = fs.existsSync(STRATEGY_DIR)
    ? fs.readdirSync(STRATEGY_DIR).filter(f => f.endsWith('.txt'))
    : [];
  let addedTxt = 0;
  for (const f of txtFiles) {
    try {
      const text = normalizeText(fs.readFileSync(path.join(STRATEGY_DIR, f), 'utf8'));
      if (!text || seen.has(text)) continue;
      seen.add(text);
      entries.push({ text, usage: 0 });
      addedTxt++;
    } catch { /* 跳过读失败的文件 */ }
  }

  return { entries, mergedFromXgtj, addedTxt };
}

function buildIndex() {
  const { entries, mergedFromXgtj, addedTxt } = collectSources();
  ensureAllShards();
  const stats = applyEntries(entries, { maxUsage: 1 });
  const meta = writeMeta({ maxUsage: stats.maxUsage });
  return {
    total: meta.totalStrategies,
    added: stats.added,
    updated: stats.updated,
    skipped: stats.skipped,
    addedTxt,
    mergedFromXgtj,
    shardCount: SHARD_COUNT,
  };
}

module.exports = {
  buildIndex,
  applyEntries,
  applyEntriesAsync,
  prepareEntry,
  writeMeta,
  readMeta,
  maxUsageFromMeta,
  collectSources,
  ensureAllShards,
  normalizeText,
  textHash,
  shardOf,
  shardPath,
  DATA_DIR,
  SHARD_COUNT,
  XGTJ_PATH,
  STRATEGY_DIR,
  META_PATH,
};
