/**
 * eastmoney_data JSON 增量采集器
 *
 * 背景：上游 k_dlUCl.go 把「选股策略」写成
 *   <策略目录>/eastmoney_data/<id>_page1.json
 * 形如 {"code":"100","data":[{"xcId":"xc...","contentNew":"总市值>=50亿;涨跌...","createTime":"..."}]}
 * 其中 data[].contentNew 就是策略原文，与 策略/xc*.txt 的内容同构。
 *
 * 但 watch 侧无法处理它：
 *   1) chokidar 的 ignored 直接排除了 eastmoney_data（52k 文件的递归监听会拖垮 CPU）
 *   2) onTxtEvent 只认 .txt
 * 于是这条产线的新策略全被丢弃。
 *
 * 本模块只做一件事：**按 mtime 水线做增量**，把新出现的 json 里的 contentNew
 * 交给 IncrementalIndexer 入库；已有数据一律不回灌、不重复。
 *
 * 关键约束：
 *   · 首次启动只「建立水线」（waterline = 目录内最大 mtime），历史文件全部跳过；
 *   · 需要有限回灌时显式指定 EM_BACKFILL_SINCE=YYYY-MM-DD（仍受 waterline 约束，只回灌该日期之后）；
 *   · 只处理 mtime 早于 now - EM_SAFE_MS 的文件（避免读到写了一半的 json）；
 *   · 解析失败的文件进 failures 队列，最多重试 EM_MAX_RETRY 次，不阻塞水线推进；
 *   · 同水线（同一毫秒）的文件用 tieFiles 记录，防止重复读取；
 *   · 去重交给 applyEntries 的 UNIQUE(text) + INSERT OR IGNORE，本模块也会先按 text 合并。
 */
const fs = require('fs');
const path = require('path');
const {
  normalizeText,
  STRATEGY_DIR,
  DATA_DIR,
} = require('./buildIndex');

const EM_DIR = process.env.EM_JSON_DIR || path.join(STRATEGY_DIR, 'eastmoney_data');
const STATE_PATH = path.join(DATA_DIR, '.em-json-state.json');

const DEFAULTS = {
  scanMs: Number(process.env.EM_SCAN_INTERVAL_MS || 5 * 60 * 1000),
  safetyMs: Number(process.env.EM_SAFE_MS || 3000),
  maxFilesPerScan: Number(process.env.EM_MAX_FILES || 2000),
  maxRetry: Number(process.env.EM_MAX_RETRY || 3),
  maxTies: Number(process.env.EM_MAX_TIES || 8192),
};

function stamp() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}

function iso(ms) {
  if (!ms) return '-';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

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

/** EM_BACKFILL_SINCE=YYYY-MM-DD / YYYY-MM-DD HH:mm:ss / 毫秒数字 → 毫秒 */
function parseSince(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{10,}$/.test(s)) return Number(s);
  const r = s.replace(/\//g, '-');
  const d = new Date(r.length <= 10 ? `${r}T00:00:00` : r);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

class EmJsonCollector {
  constructor(opts = {}) {
    this.dir = opts.dir || EM_DIR;
    this.statePath = opts.statePath || STATE_PATH;
    this.log = opts.log || console.log;
    this.onEntries = opts.onEntries || (() => {});
    this.scanMs = opts.scanMs ?? DEFAULTS.scanMs;
    this.safetyMs = opts.safetyMs ?? DEFAULTS.safetyMs;
    this.maxFilesPerScan = opts.maxFilesPerScan ?? DEFAULTS.maxFilesPerScan;
    this.maxRetry = opts.maxRetry ?? DEFAULTS.maxRetry;
    this.maxTies = opts.maxTies ?? DEFAULTS.maxTies;

    this.state = null;
    this.timer = null;
    this.running = false;
    this.stats = {
      scans: 0,
      files: 0,       // 累计处理过的 json 文件数
      items: 0,       // 累计采集到的策略条数（去重后）
      pending: 0,     // 上一轮因「正在写入」而推迟的文件数
      failed: 0,
      lastScanAt: null,
      lastScanFiles: 0,
      lastScanItems: 0,
      lastScanMs: 0,
      lastEmptyFiles: 0,
    };
  }

  /* ------------------------------- 状态 ------------------------------- */

  load() {
    const st = readJson(this.statePath, null);
    if (st && typeof st.waterlineMs === 'number') return st;
    return null;
  }

  save() {
    const s = this.state;
    s.updatedAt = new Date().toISOString();
    s.stats = this.stats;
    try {
      writeJsonAtomic(this.statePath, s);
    } catch (err) {
      this.log(`  ✗ EM 状态写入失败: ${err.message}`);
    }
  }

  /**
   * 初始化：有状态就继续；没有就建立水线（不回灌历史）
   * @param {{sinceMs?:number, persist?:boolean}} opts
   */
  init(opts = {}) {
    const persist = opts.persist !== false;
    if (!fs.existsSync(this.dir)) {
      this.log(`[EM] 目录不存在，采集器待命：${this.dir}`);
      this.state = { version: 1, waterlineMs: Date.now(), tieFiles: [], failures: {} };
      return { baseline: false, files: 0 };
    }

    const existing = this.load();
    if (existing) {
      this.state = {
        version: 1,
        waterlineMs: existing.waterlineMs,
        tieFiles: existing.tieFiles || [],
        failures: existing.failures || {},
      };
      // 累计计数跟着状态走，进程重启后不能被清零
      const st = existing.stats || {};
      for (const k of ['scans', 'files', 'items', 'failed']) {
        if (typeof st[k] === 'number') this.stats[k] = st[k];
      }
      this.stats.pending = 0;
      this.stats.lastScanFiles = 0;
      this.stats.lastScanItems = 0;
      this.stats.lastScanMs = 0;
      this.stats.lastScanAt = st.lastScanAt || null;
      this.log(
        `[EM] 继承水线 ${iso(this.state.waterlineMs)}（已处理 ${st.files || 0} 个 json / ${st.items || 0} 条策略）`
      );
      return { baseline: false, files: 0 };
    }

    const since = opts.sinceMs != null ? opts.sinceMs : parseSince(process.env.EM_BACKFILL_SINCE);
    const files = this.listJson();
    const now = Date.now();
    // 只以「已写稳」的文件建水线；正在写入的文件 mt 可能刚好等于水线，
    // 若把它记进 tieFiles 就永远轮不到它了 —— 所以稳定文件和 in-flight 文件必须分开。
    const stable = files.filter(f => f.mt <= now - this.safetyMs);
    const inflight = files.length - stable.length;
    const maxMt = stable.reduce((m, f) => Math.max(m, f.mt), 0) || now;

    if (since != null) {
      // 有限回灌：只从指定时刻开始，仍然不会回到「全量」
      const eligible = files.filter(f => f.mt >= since).length;
      this.state = {
        version: 1,
        waterlineMs: since,
        tieFiles: stable.filter(f => f.mt === since).map(f => f.name).slice(0, this.maxTies),
        failures: {},
      };
      this.log(
        `[EM] 首次启动（回灌模式）：水线设为 ${iso(since)}，目录内 ${files.length} 个 json 中 ${eligible} 个待采集`
      );
    } else {
      // 默认：水线 = 已写稳文件的最大 mtime；历史全部视为已处理，不回灌
      this.state = {
        version: 1,
        waterlineMs: maxMt,
        tieFiles: stable.filter(f => f.mt === maxMt).map(f => f.name).slice(0, this.maxTies),
        failures: {},
      };
      this.log(
        `[EM] 首次启动：建立增量水线 ${iso(maxMt)}，已有 ${files.length} 个 json 全部跳过（不回灌）` +
        (inflight ? `，其中 ${inflight} 个正在写入，下一轮再收` : '')
      );
    }
    if (persist) this.save();
    else this.log('[EM] （dry-run：本次不落盘状态）');
    return { baseline: true, files: files.length };
  }

  /** 目录内所有 .json 的 {name, mt, size}（不递归；该目录是扁平的） */
  listJson() {
    if (!fs.existsSync(this.dir)) return [];
    const out = [];
    let ents;
    try {
      ents = fs.readdirSync(this.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    for (const ent of ents) {
      if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
      try {
        const st = fs.statSync(path.join(this.dir, ent.name));
        out.push({ name: ent.name, mt: Math.floor(st.mtimeMs), size: st.size });
      } catch { /* 忽略瞬时消失的文件 */ }
    }
    return out;
  }

  /* ------------------------------- 扫描 ------------------------------- */

  /**
   * 采集一轮
   * @param {{dry?:boolean}} opts dry=true 只统计不产出
   * @returns {{files:number, items:number, pending:number, failed:number, rid:number, waterline:number}}
   */
  scan(opts = {}) {
    const t0 = Date.now();
    const now = Date.now();
    const dry = !!opts.dry;
    if (!this.state) this.init();

    const files = this.listJson();
    const wl = this.state.waterlineMs;
    const tieSet = new Set(this.state.tieFiles || []);
    const failures = this.state.failures || {};
    const cands = [];
    let pending = 0;

    for (const f of files) {
      if (f.mt > now - this.safetyMs) { pending++; continue; } // 可能正在写入
      if (f.mt > wl) cands.push(f);
      else if (f.mt === wl && !tieSet.has(f.name)) cands.push(f);
    }

    // 失败重试优先（mt 可能已在水线之下）
    for (const name of Object.keys(failures)) {
      if (cands.some(c => c.name === name)) continue;
      const f = files.find(x => x.name === name);
      if (f) cands.unshift(f);
      else delete failures[name];
    }

    cands.sort((a, b) => a.mt - b.mt);
    const slice = cands.slice(0, this.maxFilesPerScan);

    const texts = new Map();
    const processed = [];
    let emptyFiles = 0;

    for (const c of slice) {
      let doc;
      try {
        doc = JSON.parse(fs.readFileSync(path.join(this.dir, c.name), 'utf8'));
      } catch (err) {
        const tries = ((failures[c.name] && failures[c.name].tries) || 0) + 1;
        if (tries >= this.maxRetry) {
          delete failures[c.name];
          this.stats.failed++;
          this.log(`[EM] ✗ 解析失败已放弃(${tries}次)：${c.name} — ${err.message}`);
        } else {
          failures[c.name] = { mt: c.mt, tries };
          this.log(`[EM] · 解析失败待重试(${tries}/${this.maxRetry})：${c.name}`);
        }
        continue;
      }

      delete failures[c.name];
      const arr = doc && Array.isArray(doc.data) ? doc.data : [];
      let hit = 0;
      for (const it of arr) {
        if (!it || typeof it !== 'object') continue;
        const raw =
          typeof it.contentNew === 'string' && it.contentNew.trim()
            ? it.contentNew
            : typeof it.content === 'string'
              ? it.content
              : '';
        const t = normalizeText(raw);
        if (!t) continue;
        hit++;
        if (!texts.has(t)) texts.set(t, { text: t, usage: 0 });
      }
      if (!arr.length) emptyFiles++;
      processed.push({ name: c.name, mt: c.mt });
    }

    // 推进水线 + 记录同一毫秒的 tie
    let newWl = wl;
    for (const p of processed) if (p.mt > newWl) newWl = p.mt;
    let ties;
    if (newWl > wl) {
      ties = processed.filter(p => p.mt === newWl).map(p => p.name);
    } else {
      ties = [...tieSet, ...processed.filter(p => p.mt === newWl).map(p => p.name)];
    }
    if (ties.length > this.maxTies) ties = ties.slice(-this.maxTies);

    this.state.waterlineMs = newWl;
    this.state.tieFiles = ties;
    this.state.failures = failures;

    const items = [...texts.values()];
    this.stats.scans++;
    this.stats.files += processed.length;
    this.stats.items += items.length;
    this.stats.pending = pending;
    this.stats.lastScanAt = new Date().toISOString();
    this.stats.lastScanFiles = processed.length;
    this.stats.lastScanItems = items.length;
    this.stats.lastScanMs = Date.now() - t0;
    this.stats.lastEmptyFiles = emptyFiles;

    if (!dry) {
      if (items.length) this.onEntries(items);
      this.save();
    }

    this.log(
      `[EM] 扫描 ${files.length} 个 json → 新增文件 ${processed.length}（空 ${emptyFiles}）` +
      ` → 策略 ${items.length} 条 | 水线 ${iso(newWl)} | 延迟 ${pending} | ${this.stats.lastScanMs}ms` +
      (dry ? ' [dry-run 不写库]' : '')
    );

    return {
      files: processed.length,
      items: items.length,
      pending,
      failed: Object.keys(failures).length,
      rid: this.stats.scans,
      waterline: newWl,
      dry,
      names: processed.map(p => p.name),
    };
  }

  /** 常驻：启动即扫一轮，之后按 EM_SCAN_INTERVAL_MS 轮询 */
  async start() {
    await this.scan();
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = true;
      try {
        this.scan();
      } catch (err) {
        this.log(`[EM] 扫描异常（继续）: ${err.message}`);
      } finally {
        this.running = false;
      }
    }, this.scanMs);
    this.timer.unref?.();
    this.log(`[EM] 已启动轮询，周期 ${Math.round(this.scanMs / 1000)}s，目录 ${this.dir}`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  summary() {
    const s = this.stats;
    return `EM扫描=${s.scans} json=${s.files} 策略=${s.items} 空文件=${s.lastEmptyFiles} 延迟=${s.pending} 水线=${iso(this.state && this.state.waterlineMs)}`;
  }
}

module.exports = { EmJsonCollector, EM_DIR, STATE_PATH, parseSince };
