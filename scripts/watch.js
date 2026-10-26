#!/usr/bin/env node
/**
 * 监控 策略 目录变化，防抖 2 秒后自动重建索引。
 * 同时监控 xgTj.json（若变化也触发重建）。
 * 运行：node scripts/watch.js
 * 路径可用环境变量 XGTJ_PATH / STRATEGY_DIR 覆盖。
 */
const chokidar = require('chokidar');
const path = require('path');
const os = require('os');
const { buildIndex } = require('../src/buildIndex');

const STRATEGY_DIR = process.env.STRATEGY_DIR || path.join(os.homedir(), 'MyWork/goSqlite_gorm/策略');
const XGTJ_PATH = process.env.XGTJ_PATH || path.join(os.homedir(), 'MyWork/goSqlite_gorm/config/xgTj.json');

let timer = null;
let building = false;

function scheduleRebuild(reason) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(async () => {
    if (building) {
      // 上一次还没跑完，再等一轮
      scheduleRebuild(reason);
      return;
    }
    building = true;
    const t0 = Date.now();
    try {
      console.log(`[${new Date().toLocaleTimeString()}] 检测到变化（${reason}），开始重建 ...`);
      const r = buildIndex();
      console.log(`  ✓ 完成：${r.total} 条策略，新增 txt ${r.addedTxt} 条，耗时 ${Date.now() - t0}ms`);
    } catch (e) {
      console.error('  ✗ 重建失败:', e.message);
    } finally {
      building = false;
    }
  }, 2000);
}

console.log(`监控目录：${STRATEGY_DIR}`);
console.log(`监控文件：${XGTJ_PATH}`);
console.log('等待变化 ...\n');

chokidar.watch(STRATEGY_DIR, {
  ignored: /(^|[\/\\])\../,
  persistent: true,
  awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 },
}).on('all', (event, p) => {
  if (!p.endsWith('.txt')) return;
  scheduleRebuild(`${event} ${path.basename(p)}`);
});

chokidar.watch(XGTJ_PATH, { persistent: true }).on('all', (event) => {
  scheduleRebuild(`xgTj.json ${event}`);
});
