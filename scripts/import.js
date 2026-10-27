#!/usr/bin/env node
/**
 * 一次性全量导入：node scripts/import.js
 */
const { buildIndex } = require('../src/buildIndex');
console.log('开始增量导入 ...');
const t0 = Date.now();
const r = buildIndex();
console.log(`完成：DB 共 ${r.total} 条策略 | 本次新增 ${r.added || 0} | 更新使用次数 ${r.updated || 0} | 跳过(已存在) ${r.skipped || 0} | 耗时 ${Date.now() - t0}ms`);
