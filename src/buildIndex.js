/**
 * 构建索引：读取原始数据 → 规范化 → 去重 → 打标签 → 算评分 → 分片写入 SQLite
 * 分片：按 hash(text) % SHARD_COUNT 分到 strategies_0.db ... strategies_7.db
 * 每个分片 ~9MB，满足 GitHub 单文件 < 20MB 约束。
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

const COMPILED = TAG_RULES.map(r => ({
  ...r,
  keywordsLower: r.keywords.map(k => k.toLowerCase()),
}));

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

function buildIndex() {
  // 1. 读取并规范化
  const xg = JSON.parse(fs.readFileSync(XGTJ_PATH, 'utf8'));
  const normUsageMap = new Map();
  let rawFromXgtj = 0;
  for (const [text, usage] of Object.entries(xg)) {
    rawFromXgtj++;
    const t = normalizeText(text);
    if (!t) continue;
    if (!normUsageMap.has(t)) {
      normUsageMap.set(t, Number(usage) || 0);
    } else {
      normUsageMap.set(t, Math.max(normUsageMap.get(t), Number(usage) || 0));
    }
  }

  const entries = [];
  const seen = new Set();
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
    const p = path.join(STRATEGY_DIR, f);
    try {
      const text = normalizeText(fs.readFileSync(p, 'utf8'));
      if (!text || seen.has(text)) continue;
      seen.add(text);
      entries.push({ text, usage: 0 });
      addedTxt++;
    } catch (e) { /* skip */ }
  }

  // 2. 打标签 + 评分
  const maxUsage = Math.max(1, ...entries.map(e => e.usage));
  const logMaxUsage = Math.log10(1 + maxUsage);
  const totalCats = new Set(COMPILED.map(r => r.category)).size;

  for (const e of entries) {
    const { tags, categories } = tagOf(e.text);
    const segs = segmentCount(e.text);
    const usageScore = Math.log10(1 + e.usage) / logMaxUsage;
    const complexityScore = Math.min(1, segs / 15);
    const diversityScore = categories.length / totalCats;
    const hasFundamental = categories.includes('财务基本面') || categories.includes('成长');
    e.tags = tags;
    e.categories = categories;
    e.segments = segs;
    e.usageScore = usageScore;
    e.complexityScore = complexityScore;
    e.diversityScore = diversityScore;
    e.hasFundamental = hasFundamental ? 1 : 0;
    e.compositeScore = 0.35 * usageScore + 0.20 * complexityScore + 0.25 * diversityScore + 0.20 * (hasFundamental ? 1 : 0);
    e.title = shortTitle(e.text);
    e.shard = shardOf(e.text);
    // AI 建议
    const advice = inferAdvice(e.tags, e.categories, e.text);
    e.style = advice.style;
    e.buyTiming = advice.buyTiming;
    e.sellTiming = advice.sellTiming;
    e.holdingPeriod = advice.holdingPeriod;
    e.riskLevel = advice.riskLevel;
    e.stopLoss = advice.stopLoss;
    e.takeProfit = advice.takeProfit;
  }

  // 3. 分片写入（增量模式）
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 判断是否首次运行（所有分片都不存在）
  const anyExists = fs.existsSync(shardPath(0));
  const isFirstRun = !anyExists;

  let added = 0;
  let updated = 0;
  let skipped = 0;

  // 按分片分组
  const shardBuckets = Array.from({ length: SHARD_COUNT }, () => []);
  for (const e of entries) shardBuckets[e.shard].push(e);

  for (let i = 0; i < SHARD_COUNT; i++) {
    const bucket = shardBuckets[i];
    if (!bucket.length && !isFirstRun) continue;
    const p = shardPath(i);
    const db = new Database(p);
    db.pragma('journal_mode = DELETE');
    db.pragma('synchronous = OFF');
    buildSchema(db);

    const existStmt = db.prepare('SELECT usage FROM strategies WHERE text = ?');
    const updateStmt = db.prepare('UPDATE strategies SET usage = ? WHERE text = ?');
    const insertStmt = db.prepare(`
      INSERT OR IGNORE INTO strategies (text, title, tags, categories, style, buy_timing, sell_timing, holding_period, risk_level, stop_loss, take_profit, usage, segments, usage_score, complexity_score, diversity_score, has_fundamental, composite_score)
      VALUES (@text, @title, @tags, @categories, @style, @buyTiming, @sellTiming, @holdingPeriod, @riskLevel, @stopLoss, @takeProfit, @usage, @segments, @usageScore, @complexityScore, @diversityScore, @hasFundamental, @compositeScore)
    `);

    const tx = db.transaction((items) => {
      for (const e of items) {
        const row = existStmt.get(e.text);
        if (row) {
          // 已存在：更新使用次数（取最大值），跳过重新打标签
          const newUsage = Math.max(row.usage, e.usage);
          if (newUsage > row.usage) {
            updateStmt.run(newUsage, e.text);
            updated++;
          } else {
            skipped++;
          }
          continue;
        }
        // 新策略：完整处理后插入
        insertStmt.run({
          ...e,
          tags: ',' + e.tags.join(',') + ',',
          categories: ',' + e.categories.join(',') + ',',
        });
        added++;
      }
    });
    tx(bucket);

    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('shardIndex', String(i));
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('totalShards', String(SHARD_COUNT));

    db.close();
  }

  // 统计 DB 实际总量（增量模式下 entries 只是本次来源，DB 可能已有历史数据）
  let dbTotal = 0;
  let dbTotalUsage = 0;
  const shardSizes = [];
  for (let i = 0; i < SHARD_COUNT; i++) {
    const p = shardPath(i);
    if (!fs.existsSync(p)) { shardSizes.push(0); continue; }
    const db = new Database(p, { readonly: true });
    const c = db.prepare('SELECT COUNT(*) c, COALESCE(SUM(usage),0) u FROM strategies').get();
    db.close();
    dbTotal += c.c;
    dbTotalUsage += c.u;
    shardSizes.push(c.c);
  }

  // 写一份总 meta
  const metaPath = path.join(DATA_DIR, 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalStrategies: dbTotal,
    totalUsage: dbTotalUsage,
    shardCount: SHARD_COUNT,
    categories: TAG_RULES.map(r => r.category).filter((v, i, a) => a.indexOf(v) === i),
    tagRules: TAG_RULES.map(r => ({ tag: r.tag, category: r.category })),
    shardSizes,
  }, null, 2));

  return { total: dbTotal, added, updated, skipped, addedTxt, mergedFromXgtj, shardCount: SHARD_COUNT };
}

module.exports = { buildIndex, normalizeText, DATA_DIR, SHARD_COUNT, shardPath };
