/**
 * 豆包大模型增强建议：对高频策略调用豆包 API，生成更智能的买入/卖出建议。
 *  - 只处理 usage >= MIN_USAGE 的策略（默认 5，约 1900 条）
 *  - 结果缓存在 ai_cache.json，已调过的不重复调
 *  - 环境变量 DOUBAO_API_KEY 未设置时直接退出
 *
 * 用法：
 *   DOUBAO_API_KEY=xxx npm run ai
 *   DOUBAO_API_KEY=xxx MIN_USAGE=10 MODEL=doubao-pro-32k npm run ai
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_DIR, shardPath, SHARD_COUNT } = require('../src/buildIndex');

const API_KEY = process.env.DOUBAO_API_KEY;
const MODEL = process.env.MODEL || 'doubao-pro-32k';
const MIN_USAGE = Number(process.env.MIN_USAGE || 5);
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const CACHE_PATH = path.join(DATA_DIR, 'ai_cache.json');
const API_URL = 'https://ark.cn-beijing.volces.com/api/v3/chat/completions';

if (!API_KEY) {
  console.error('未设置 DOUBAO_API_KEY 环境变量，跳过 AI 增强。');
  console.error('申请：https://console.volcengine.com/ark/ → API Key 管理');
  process.exit(0);
}

// 读缓存
let cache = {};
if (fs.existsSync(CACHE_PATH)) {
  cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
}

function saveCache() {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

// 收集所有分片里需要 AI 增强的策略
function collectTargets() {
  const targets = [];
  for (let i = 0; i < SHARD_COUNT; i++) {
    const p = shardPath(i);
    if (!fs.existsSync(p)) continue;
    const db = new Database(p, { readonly: true });
    const rows = db.prepare(
      `SELECT rowid AS rid, text, tags, categories, usage FROM strategies
       WHERE usage >= ? AND text NOT IN (SELECT text FROM ai_done)`,
    ).all(MIN_USAGE);
    // ai_done 表可能不存在，先不用它，用 cache 判断
    db.close();
    for (const r of rows) {
      if (cache[r.text]) continue; // 已调过
      targets.push({ shard: i, rid: r.rid, text: r.text, tags: r.tags, categories: r.categories, usage: r.usage });
    }
  }
  return targets;
}

const SYSTEM_PROMPT = `你是一名A股量化交易专家。用户会给你一条选股策略（自然语言描述），以及它的标签、使用次数。
请你基于该策略的风格（涨停打板/趋势波段/价值投资等），给出以下建议（严格 JSON 输出，不要其他内容）：
{
  "style": "策略风格，如 短线打板/趋势波段/价值成长/情绪博弈",
  "buyTiming": "最佳买入时机，如 集合竞价/开盘/盘中回踩/收盘/次日开盘",
  "buyReason": "一句话说明为什么这个时机买",
  "sellTiming": "卖出时机，如 次日开盘/T+3/跌破20日线/持有20日止盈",
  "sellReason": "一句话说明",
  "holdingPeriod": "建议持有周期，如 1-3日/5-20日/20-60日",
  "riskLevel": "高/中/低",
  "stopLoss": "具体止损规则",
  "takeProfit": "具体止盈规则",
  "expectedEdge": "预期收益逻辑，一句话"
}`;

async function callDoubao(strategy) {
  const userMsg = `策略原文：${strategy.text}\n标签：${strategy.tags}\n使用次数：${strategy.usage}`;
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userMsg },
      ],
      temperature: 0.3,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${t.slice(0, 200)}`);
  }
  const data = await resp.json();
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('空响应');
  return JSON.parse(content);
}

async function run() {
  const targets = collectTargets();
  console.log(`待 AI 增强策略数：${targets.length}（usage >= ${MIN_USAGE}）`);
  if (!targets.length) return;

  // 并发控制
  let idx = 0;
  let done = 0;
  let failed = 0;

  async function worker() {
    while (idx < targets.length) {
      const my = idx++;
      const s = targets[my];
      try {
        const advice = await callDoubao(s);
        cache[s.text] = { ...advice, usage: s.usage, at: Date.now() };

        // 回写到对应分片
        const db = new Database(shardPath(s.shard));
        db.prepare(`
          UPDATE strategies SET
            style = ?, buy_timing = ?, sell_timing = ?, holding_period = ?,
            risk_level = ?, stop_loss = ?, take_profit = ?
          WHERE rowid = ?
        `).run(
          advice.style, advice.buyTiming, advice.sellTiming, advice.holdingPeriod,
          advice.riskLevel, advice.stopLoss, advice.takeProfit, s.rid,
        );
        db.close();
        done++;
        if (done % 10 === 0) {
          console.log(`  进度 ${done}/${targets.length}，失败 ${failed}`);
          saveCache();
        }
      } catch (e) {
        failed++;
        console.error(`  ✗ [${my}] ${s.text.slice(0, 30)}...: ${e.message}`);
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveCache();
  console.log(`\n完成：成功 ${done}，失败 ${failed}，缓存已存 ${CACHE_PATH}`);
}

run().catch(e => { console.error(e); process.exit(1); });
