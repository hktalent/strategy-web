#!/usr/bin/env node
/**
 * 一次性全量导入：node scripts/import.js
 */
const { buildIndex } = require('../src/buildIndex');
console.log('开始全量重建 ...');
const t0 = Date.now();
const r = buildIndex();
console.log(`完成：${r.total} 条策略，新增 txt ${r.addedTxt} 条，xgTj 合并重复 ${r.mergedFromXgtj} 条，耗时 ${Date.now() - t0}ms`);
