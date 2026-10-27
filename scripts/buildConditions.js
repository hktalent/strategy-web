/**
 * 从所有策略中抽取唯一子条件，全局去重后存入 data/conditions.db
 * 每条策略的子条件通过逗号分隔的 condition_ids 关联（由 buildIndex 写入）
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { analyzeCondition } = require('../src/conditionAnalyzer');
const { DATA_DIR, shardPath, SHARD_COUNT } = require('../src/buildIndex');

const COND_DB = path.join(DATA_DIR, 'conditions.db');

function splitConditions(text) {
  return text.split(/[;；,，]|\bAND\b|\band\b|并且|同时/g)
    .map(s => s.trim())
    .filter(s => s.length >= 2 && s.length <= 80);
}

function build() {
  fs.mkdirSync(DATA_DIR, { recursive: true });

  // 1. 遍历所有分片，收集唯一子条件
  const unique = new Map(); // text -> count
  for (let i = 0; i < SHARD_COUNT; i++) {
    const p = shardPath(i);
    if (!fs.existsSync(p)) continue;
    const db = new Database(p, { readonly: true });
    const rows = db.prepare('SELECT text FROM strategies').all();
    db.close();
    for (const r of rows) {
      for (const c of splitConditions(r.text)) {
        unique.set(c, (unique.get(c) || 0) + 1);
      }
    }
  }
  console.log(`唯一子条件数：${unique.size}`);

  // 2. 打开或创建 conditions.db（增量模式）
  const dbExists = fs.existsSync(COND_DB);
  const db = new Database(COND_DB);
  db.pragma('journal_mode = DELETE');
  db.pragma('synchronous = OFF');
  db.exec(`
    CREATE TABLE IF NOT EXISTS conditions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL UNIQUE,
      freq INTEGER DEFAULT 0,
      scope TEXT,
      value TEXT,
      func TEXT,
      features TEXT,
      limitations TEXT,
      range TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_conditions_text ON conditions(text);
    CREATE INDEX IF NOT EXISTS idx_conditions_freq ON conditions(freq DESC);
    CREATE INDEX IF NOT EXISTS idx_conditions_scope ON conditions(scope);
  `);

  const existStmt = db.prepare('SELECT id, freq FROM conditions WHERE text = ?');
  const insertStmt = db.prepare(`
    INSERT INTO conditions (text, freq, scope, value, func, features, limitations, range)
    VALUES (@text, @freq, @scope, @value, @func, @features, @limitations, @range)
  `);
  const updateFreqStmt = db.prepare('UPDATE conditions SET freq = ? WHERE id = ?');

  let added = 0, updated = 0;
  const tx = db.transaction(() => {
    for (const [text, freq] of unique) {
      const row = existStmt.get(text);
      if (row) {
        // 已存在：更新频次（取最大值），描述不变
        if (freq > row.freq) {
          updateFreqStmt.run(freq, row.id);
          updated++;
        }
        continue;
      }
      const a = analyzeCondition(text);
      insertStmt.run({
        text, freq,
        scope: a.scope, value: a.value, func: a.func,
        features: a.features, limitations: a.limitations, range: a.range,
      });
      added++;
    }
  });
  tx();
  db.close();
  console.log(`新增 ${added} 条，更新频次 ${updated} 条，库：${COND_DB}`);
}

if (require.main === module) build();
module.exports = { build, splitConditions, COND_DB };
