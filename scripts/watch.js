#!/usr/bin/env node
/**
 * 增量监听守护进程（常驻后台）
 *
 *   npm run watch              # 常驻：watch 策略目录 + xgTj.json，只把「变化的内容」写进数据库
 *   node scripts/watch.js --once   # 补齐一次就退出
 *   node scripts/watch.js --full   # 强制对 xgTj.json 做一次全量校正
 *
 * 特性：
 *   · 单实例锁（run/watch.lock），重复启动直接退出，不会两个进程抢写 SQLite
 *   · 只 watch 策略目录第一层（不递归进 eastmoney_data 那 2 万多个子目录）
 *   · 防抖 + 合并 + 分块事务 + setImmediate 让出事件循环 → 异步、增量、不阻塞
 *   · 启动自动补齐、退出前 drain、异常不退出（外部 KeepAlive 会拉起）
 *   · 日志时间戳化；配合 scripts/daemon.sh / launchd 可实现「始终后台运行」
 */
const fs = require('fs');
const path = require('path');
const chokidar = require('chokidar');
const { IncrementalIndexer } = require('../src/indexer');
const { STRATEGY_DIR, XGTJ_PATH, readMeta } = require('../src/buildIndex');

const ROOT = path.join(__dirname, '..');
const RUN_DIR = path.join(ROOT, 'run');
const LOCK_PATH = path.join(RUN_DIR, 'watch.lock');
const PID_PATH = path.join(RUN_DIR, 'watch.pid');

const args = process.argv.slice(2);
const ONCE = args.includes('--once');
const FORCE_FULL = args.includes('--full');
const HEARTBEAT_MS = Number(process.env.WATCH_HEARTBEAT_MS || 30 * 60 * 1000);

function stamp() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function log(msg) {
  const line = `[${stamp()}] ${msg}`;
  console.log(line);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/* ------------------------------ 单实例锁 ------------------------------ */

function acquireLock() {
  fs.mkdirSync(RUN_DIR, { recursive: true });
  if (fs.existsSync(LOCK_PATH)) {
    const old = Number(String(fs.readFileSync(LOCK_PATH, 'utf8')).trim());
    if (old && old !== process.pid && isAlive(old)) {
      log(`已有 watch 进程在运行 (pid=${old})，本进程退出。`);
      process.exit(0);
    }
    fs.unlinkSync(LOCK_PATH); // 陈旧锁，接管
  }
  fs.writeFileSync(LOCK_PATH, String(process.pid));
  fs.writeFileSync(PID_PATH, String(process.pid));
}

function releaseLock() {
  for (const p of [LOCK_PATH, PID_PATH]) {
    try {
      if (fs.existsSync(p) && Number(String(fs.readFileSync(p, 'utf8')).trim()) === process.pid) {
        fs.unlinkSync(p);
      }
    } catch { /* ignore */ }
  }
}

/* ------------------------------ 主流程 ------------------------------ */

const indexer = new IncrementalIndexer({
  log,
  onFlush: r => {
    if (r.added > 0) log(`  ↳ 数据库已更新，总量 ${readMeta().totalStrategies ?? '?'} 条`);
  },
});

let watcher = null;
let heartbeat = null;
let shuttingDown = false;

async function startup() {
  acquireLock();
  log('='.repeat(64));
  log(`策略目录：${STRATEGY_DIR}`);
  log(`打包数据：${XGTJ_PATH}`);
  log(`模式：${ONCE ? '一次性补齐' : FORCE_FULL ? '常驻 + 强制全量校正' : '常驻增量'}`);
  log('='.repeat(64));

  if (FORCE_FULL) {
    const r = await indexer.syncXgTj({ force: true });
    if (r.diffs.length) await indexer.queueEntries(r.diffs);
    await indexer.flush();
  }

  await indexer.catchUp();

  if (ONCE) {
    await indexer.drain();
    log('一次性补齐完成，退出。');
    releaseLock();
    process.exit(0);
  }

  watcher = chokidar.watch(
    [STRATEGY_DIR, XGTJ_PATH].filter(p => fs.existsSync(p)),
    {
      ignored: p => path.basename(p).startsWith('.'),
      persistent: true,
      depth: 0, // 只看策略目录第一层，不递归进 eastmoney_data
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 400, pollInterval: 100 },
    }
  );

  watcher
    .on('add', p => onTxtEvent(p, 'add'))
    .on('change', p => onTxtEvent(p, 'change'))
    .on('unlink', p => onTxtEvent(p, 'unlink'))
    .on('error', err => log(`watch 错误: ${err.message}`))
    .on('ready', () => log('监听已就绪，等待变化 ...'));

  heartbeat = setInterval(() => {
    const s = indexer.stats;
    log(
      `心跳 pid=${process.pid} 批次=${s.batches} 新增=${s.added} 更新=${s.updated} ` +
      `跳过=${s.skipped} 队列=${indexer.txtQueue.size} 运行中=${indexer.running}`
    );
  }, HEARTBEAT_MS);
  heartbeat.unref?.();
}

function onTxtEvent(p, event) {
  if (!p.endsWith('.txt')) return;
  if (path.resolve(path.dirname(p)) !== path.resolve(STRATEGY_DIR)) return;
  if (event === 'unlink') {
    log(`文件被移除（保留库内记录）：${path.basename(p)}`);
    return;
  }
  log(`检测到 ${event}: ${path.basename(p)}`);
  indexer.queueTxt(p, event);
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`收到 ${signal}，正在收尾（写回队列中的变化）...`);
  if (heartbeat) clearInterval(heartbeat);
  if (watcher) await watcher.close().catch(() => {});
  try {
    await indexer.drain();
    log('已安全退出。');
  } catch (err) {
    log(`收尾失败: ${err.message}`);
  }
  releaseLock();
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGHUP', () => shutdown('SIGHUP'));
process.on('uncaughtException', err => {
  log(`未捕获异常（进程继续）: ${err && err.stack ? err.stack : err}`);
});
process.on('unhandledRejection', err => {
  log(`未处理的 Promise 拒绝（进程继续）: ${err && err.message ? err.message : err}`);
});

startup().catch(err => {
  log(`启动失败: ${err && err.stack ? err.stack : err}`);
  releaseLock();
  process.exit(1);
});
