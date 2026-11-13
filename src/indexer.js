/**
 * 增量索引引擎（异步、可合并、只写变化）
 *
 *   watch 事件  →  queueTxt()/queueEntries()  →  防抖合并  →  applyEntriesAsync()
 *
 * 设计要点：
 *  1. 只有「变化的内容」进队列，绝不整库扫描；
 *  2. 同一批变化合并成一个批次，按 hash 分片，只打开涉及的分片；
 *  3. 每 500 行一个事务、事务之间 setImmediate 让出事件循环 → 真异步、不阻塞；
 *  4. xgTj.json 用「哈希快照差分」：只在变化条目上写库；
 *  5. data/meta.json 用原子替换 + 节流写入，服务端随时可读到一致的总量。
 */
const fs = require('fs');
const path = require('path');
const {
  applyEntriesAsync,
  writeMeta,
  readMeta,
  maxUsageFromMeta,
  normalizeText,
  textHash,
  shardPath,
  DATA_DIR,
  SHARD_COUNT,
  XGTJ_PATH,
  STRATEGY_DIR,
  META_PATH,
} = require('./buildIndex');

const STATE_PATH = path.join(DATA_DIR, '.watch-state.json');
const SNAPSHOT_PATH = path.join(DATA_DIR, '.xgtj-snapshot.json');
const META_THROTTLE_MS = Number(process.env.META_THROTTLE_MS || 3000);

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, obj) {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, p);
}

function dbLooksBuilt() {
  const meta = readMeta();
  return Number(meta.totalStrategies || 0) > 0 && fs.existsSync(shardPath(0));
}

class IncrementalIndexer {
  constructor(opts = {}) {
    this.debounce = Number(opts.debounce ?? process.env.WATCH_DEBOUNCE ?? 600);
    this.maxWait = Number(opts.maxWait ?? process.env.WATCH_MAX_WAIT ?? 4000);
    this.log = opts.log || console.log;
    this.onFlush = opts.onFlush || null;

    this.txtQueue = new Map(); // filePath -> { event, at }
    this.entryQueue = []; // [{ text, usage }]
    this.timer = null;
    this.firstQueuedAt = 0;
    this.running = false;
    this.dirtyWhileRunning = false;
    this.lastMetaAt = 0;
    this.maxUsage = maxUsageFromMeta();

    this.stats = {
      batches: 0,
      added: 0,
      updated: 0,
      skipped: 0,
      lastFlushAt: null,
      lastFlushMs: 0,
      startedAt: new Date().toISOString(),
    };
  }

  /* ----------------------------- 入队 ----------------------------- */

  queueTxt(filePath, event = 'change') {
    this.txtQueue.set(filePath, { event, at: Date.now() });
    this.schedule();
  }

  queueEntries(entries) {
    if (!entries || !entries.length) return;
    for (const e of entries) this.entryQueue.push(e);
    this.schedule();
  }

  schedule() {
    if (!this.firstQueuedAt) this.firstQueuedAt = Date.now();
    if (this.timer) clearTimeout(this.timer);
    const waited = Date.now() - this.firstQueuedAt;
    const delay = Math.min(this.debounce, Math.max(0, this.maxWait - waited));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(err => this.log(`  ✗ 批次失败: ${err.message}`));
    }, delay);
  }

  /* ----------------------------- 执行 ----------------------------- */

  async flush() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.running) {
      this.dirtyWhileRunning = true; // 上一个批次没结束，结束后再跑一轮
      return;
    }
    const files = [...this.txtQueue.entries()];
    const queued = this.entryQueue.splice(0);
    this.txtQueue.clear();
    this.firstQueuedAt = 0;
    if (!files.length && !queued.length) return;

    this.running = true;
    const t0 = Date.now();
    try {
      const entries = [...queued];
      for (const [file, info] of files) {
        const e = this.readTxtEntry(file);
        if (e) entries.push(e);
        else if (info.event !== 'unlink') this.log(`  · 跳过空/不可读文件: ${path.basename(file)}`);
      }

      // 同批去重：同一 text 取最大 usage
      const merged = new Map();
      for (const e of entries) {
        const prev = merged.get(e.text);
        if (prev) prev.usage = Math.max(prev.usage, e.usage || 0);
        else merged.set(e.text, { text: e.text, usage: e.usage || 0 });
      }
      const batch = [...merged.values()];
      if (!batch.length) return;

      const r = await applyEntriesAsync(batch, { maxUsage: this.maxUsage });
      if (r.maxUsage > this.maxUsage) this.maxUsage = r.maxUsage;

      this.stats.batches++;
      this.stats.added += r.added;
      this.stats.updated += r.updated;
      this.stats.skipped += r.skipped;
      this.stats.lastFlushAt = new Date().toISOString();
      this.stats.lastFlushMs = Date.now() - t0;

      await this.refreshMeta([r.maxUsage]);
      this.persistState();

      const label = files.length
        ? `${files.length} 个文件${queued.length ? ` + ${queued.length} 条记录` : ''}`
        : `${queued.length} 条记录`;
      this.log(
        `  ✓ ${label} → 新增 ${r.added} / 更新 ${r.updated} / 跳过 ${r.skipped} ` +
        `| 分片 [${r.touched.join(',') || '无'}] | ${Date.now() - t0}ms`
      );
      if (this.onFlush) this.onFlush(r);
    } finally {
      this.running = false;
      if (this.dirtyWhileRunning || this.txtQueue.size || this.entryQueue.length) {
        this.dirtyWhileRunning = false;
        this.schedule();
      }
    }
  }

  readTxtEntry(filePath) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const text = normalizeText(raw);
      if (!text) return null;
      return { text, usage: 0 };
    } catch {
      return null;
    }
  }

  async refreshMeta(maxUsageCandidates = []) {
    const now = Date.now();
    if (now - this.lastMetaAt < META_THROTTLE_MS) return;
    this.lastMetaAt = now;
    const meta = writeMeta({ maxUsage: Math.max(...maxUsageCandidates, this.maxUsage) });
    this.stats.totalStrategies = meta.totalStrategies;
  }

  /* --------------------------- 启动补齐 / 全量校正 --------------------------- */

  /** 启动时：把目录里所有 txt 过一遍（已存在的行 INSERT OR IGNORE，不会重复写），
   *  xgTj 用快照差分，只有打包数据变了才会真正写库。 */
  async catchUp() {
    const t0 = Date.now();
    let txtCount = 0;
    const entries = [];
    for (const f of this.listTxtFiles()) {
      const e = this.readTxtEntry(path.join(STRATEGY_DIR, f));
      if (e) {
        entries.push(e);
        txtCount++;
      }
    }
    this.log(`启动补齐：扫描 ${txtCount} 个 txt 文件`);

    const xgResult = await this.syncXgTj({ force: !dbLooksBuilt() });
    if (xgResult.diffs && xgResult.diffs.length) entries.push(...xgResult.diffs);
    if (xgResult.maxUsage > this.maxUsage) this.maxUsage = xgResult.maxUsage;

    if (entries.length) {
      const r = await applyEntriesAsync(entries, { maxUsage: this.maxUsage });
      if (r.maxUsage > this.maxUsage) this.maxUsage = r.maxUsage;
      this.stats.batches++;
      this.stats.added += r.added;
      this.stats.updated += r.updated;
      this.stats.skipped += r.skipped;
      this.stats.lastFlushAt = new Date().toISOString();
      this.log(
        `  ✓ 补齐完成：新增 ${r.added} / 更新 ${r.updated} / 跳过 ${r.skipped} | ${Date.now() - t0}ms`
      );
    } else {
      this.log('  · 无需补齐（数据已是最新）');
    }
    this.stats.totalStrategies = writeMeta({ maxUsage: this.maxUsage }).totalStrategies;
    this.persistState();
    return { txtCount, xg: xgResult };
  }

  listTxtFiles() {
    if (!fs.existsSync(STRATEGY_DIR)) return [];
    return fs.readdirSync(STRATEGY_DIR).filter(f => f.endsWith('.txt'));
  }

  /**
   * xgTj.json 差分同步：对比哈希快照，只产出「新增 / usage 变大」的条目。
   * 首跑或数据库为空时全量写入。
   */
  async syncXgTj({ force = false } = {}) {
    if (!fs.existsSync(XGTJ_PATH)) return { diffs: [], skipped: true, maxUsage: this.maxUsage };
    const st = fs.statSync(XGTJ_PATH);
    const sig = `${st.size}-${Math.floor(st.mtimeMs)}`;
    const snap = readJson(SNAPSHOT_PATH, null);
    if (!force && snap && snap.sig === sig && dbLooksBuilt()) {
      this.log('xgTj.json 未变化，跳过解析');
      return { diffs: [], skipped: true, maxUsage: snap.maxUsage || this.maxUsage };
    }

    const t0 = Date.now();
    const raw = JSON.parse(fs.readFileSync(XGTJ_PATH, 'utf8'));
    const current = new Map(); // hash -> usage
    const prevItems = (!force && snap && snap.items) ? snap.items : null;
    const diffs = new Map(); // hash -> { text, usage }
    let maxUsage = 1;

    for (const [k, v] of Object.entries(raw)) {
      const text = normalizeText(k);
      if (!text) continue;
      const h = textHash(text);
      const usage = Number(v) || 0;
      if (usage > maxUsage) maxUsage = usage;

      const old = current.get(h);
      if (old === undefined) current.set(h, usage);
      else if (usage > old) current.set(h, usage);

      const prevUsage = prevItems ? prevItems[h] : undefined;
      const needWrite = force || prevItems === null || prevUsage === undefined || usage > prevUsage;
      if (needWrite) {
        const d = diffs.get(h);
        if (!d) diffs.set(h, { text, usage });
        else if (usage > d.usage) d.usage = usage;
      }
    }

    writeJsonAtomic(SNAPSHOT_PATH, {
      sig,
      count: current.size,
      maxUsage,
      generatedAt: new Date().toISOString(),
      items: Object.fromEntries(current),
    });

    const out = [...diffs.values()];
    this.log(
      `xgTj.json 差分：源 ${current.size} 条，需写库 ${out.length} 条 ` +
      `(解析 ${Date.now() - t0}ms)`
    );
    return { diffs: out, skipped: false, maxUsage };
  }

  serveXgTjChange() {
    // 同一文件的连续变化合并：只留最后一次
    if (this.xgTimer) return;
    this.xgTimer = setTimeout(async () => {
      this.xgTimer = null;
      try {
        const r = await this.syncXgTj();
        if (r.diffs.length) this.queueEntries(r.diffs);
      } catch (err) {
        this.log(`  ✗ xgTj 同步失败: ${err.message}`);
      }
    }, 1500);
  }

  /* ------------------------------ 状态持久化 ------------------------------ */

  persistState() {
    const state = {
      version: 1,
      updatedAt: new Date().toISOString(),
      maxUsage: this.maxUsage,
      xgTj: { path: XGTJ_PATH, exists: fs.existsSync(XGTJ_PATH) },
      stats: this.stats,
    };
    try {
      writeJsonAtomic(STATE_PATH, state);
    } catch { /* 审计文件写失败不影响主流程 */ }
  }

  /** 退出前把队列里剩下的变化尽量写完 */
  async drain() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.xgTimer) clearTimeout(this.xgTimer);
    this.xgTimer = null;
    await this.flush();
    if (this.txtQueue.size || this.entryQueue.length) await this.flush();
  }
}

module.exports = { IncrementalIndexer, STATE_PATH, SNAPSHOT_PATH, META_PATH, SHARD_COUNT };
