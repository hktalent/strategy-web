/**
 * AI 建议推断：基于策略标签，给出买入时机、卖出时机、持有周期、风险等级、风格。
 * 注意：这是基于量化交易常识的启发式推断，不是真回测。
 * 未来接入A股历史K线数据后，可替换为真回测结果。
 */

/**
 * @param {string[]} tags 策略标签
 * @param {string[]} categories 策略大类
 * @param {string} text 策略原文
 */
function inferAdvice(tags, categories, text) {
  const has = (t) => tags.includes(t);
  const cat = (c) => categories.includes(c);

  // ===== 1. 策略风格 =====
  let style = '混合';
  if (cat('涨停事件') && (has('早盘择时') || has('情绪人气'))) style = '短线打板';
  else if (cat('涨停事件')) style = '追涨涨停';
  else if (cat('财务基本面') && cat('成长')) style = '价值成长';
  else if (cat('财务基本面')) style = '价值投资';
  else if (cat('趋势技术') && cat('量能资金')) style = '趋势波段';
  else if (cat('趋势技术')) style = '技术趋势';
  else if (cat('情绪人气')) style = '情绪博弈';
  else if (cat('择时')) style = '盘中择时';

  // ===== 2. 买入时机建议 =====
  let buyTiming = '收盘买入';
  let buyReason = '';

  if (has('早盘择时') && (has('涨停') || has('量比'))) {
    buyTiming = '集合竞价买入（9:25前挂单）';
    buyReason = '策略含早盘择时+涨停/量比条件，属竞价抢筹/打板类，需在集合竞价阶段决策';
  } else if (has('涨停') || has('连板') || has('首板')) {
    buyTiming = '开盘买入（9:30-9:35）';
    buyReason = '涨停/打板类策略，开盘确认强度后买入，避免追高';
  } else if (has('龙虎榜') || has('人气排名')) {
    buyTiming = '开盘买入（9:30-9:45）';
    buyReason = '情绪/人气类策略，开盘观察资金流向后介入';
  } else if (cat('财务基本面') || cat('成长')) {
    buyTiming = '收盘买入（14:30-15:00）';
    buyReason = '价值/成长类策略，不依赖盘中波动，收盘前买入避免日内噪音';
  } else if (has('金叉') || has('MACD') || has('KDJ') || has('趋势排列')) {
    buyTiming = '次日开盘买入';
    buyReason = '技术信号类策略，信号当日收盘确认后，次日开盘介入更稳妥';
  } else if (has('量比') || has('换手率')) {
    buyTiming = '盘中买入（10:00-14:00）';
    buyReason = '量能类策略，需观察盘中量能是否达标后再买';
  } else if (has('筹码') || has('BOLL')) {
    buyTiming = '盘中回踩买入';
    buyReason = '筹码/BOLL类策略，等回踩支撑位再买，不追高';
  } else if (text.includes('次日') || text.includes('隔日')) {
    buyTiming = '次日开盘买入';
    buyReason = '策略文本明确提到次日/隔日条件';
  }

  // ===== 3. 卖出时机建议 =====
  let sellTiming = '持有5个交易日，或跌破10日均线卖出';
  let sellReason = '';

  if (style === '短线打板' || style === '追涨涨停') {
    sellTiming = '次日开盘卖出（T+1）';
    sellReason = '打板/追涨策略次日不连板即走，避免回撤';
  } else if (style === '情绪博弈') {
    sellTiming = '3日内不涨停即卖，或冲高5%止盈';
    sellReason = '情绪票不持续就走，短线思维';
  } else if (style === '价值投资' || style === '价值成长') {
    sellTiming = '持有20-60个交易日，目标止盈15-30%，或逻辑破坏卖出';
    sellReason = '基本面策略给估值兑现时间，不追求短线';
  } else if (style === '趋势波段' || style === '技术趋势') {
    sellTiming = '持有5-20个交易日，跌破20日均线或MACD死叉卖出';
    sellReason = '趋势跟随，趋势在就持有，破位就走';
  } else if (has('高换手') || (has('换手率') && text.includes('10%'))) {
    sellTiming = '3日内不涨即卖';
    sellReason = '高换手票波动大，不涨就说明资金退潮';
  } else if (has('振幅') && text.includes('振幅')) {
    sellTiming = '反弹3-5%即卖';
    sellReason = '振幅类策略做波段，到压力位就兑现';
  }

  // ===== 4. 持有周期 =====
  let holdingPeriod = '5-20个交易日';
  if (style === '短线打板' || style === '追涨涨停') holdingPeriod = '1-3个交易日';
  else if (style === '情绪博弈') holdingPeriod = '1-5个交易日';
  else if (style === '价值投资' || style === '价值成长') holdingPeriod = '20-60个交易日';
  else if (style === '趋势波段' || style === '技术趋势') holdingPeriod = '5-20个交易日';

  // ===== 5. 风险等级 =====
  let riskLevel = '中';
  if (style === '短线打板' || style === '追涨涨停' || style === '情绪博弈') riskLevel = '高';
  else if (style === '价值投资' || style === '价值成长') riskLevel = '低';
  if (has('ST/退市') && !text.includes('ST')) riskLevel = '高'; // 含ST排除条件说明标的可能小盘
  if (has('市值规模')) {
    // 小盘股风险高
    const m = text.match(/市值[^\d]*(\d+)/);
    if (m && Number(m[1]) < 50) riskLevel = riskLevel === '低' ? '中' : '高';
  }

  // ===== 6. 止损/止盈建议 =====
  let stopLoss = '跌破买入价 -7% 止损';
  let takeProfit = '+10% 分批止盈';
  if (style === '价值投资' || style === '价值成长') {
    stopLoss = '逻辑破坏（业绩变脸/破位）才止损';
    takeProfit = '+20-30% 或估值到历史高位';
  } else if (style === '短线打板' || style === '追涨涨停') {
    stopLoss = '次日低开 -3% 无条件走';
    takeProfit = '+5-10% 或不连板即走';
  }

  return {
    style,
    buyTiming,
    buyReason,
    sellTiming,
    sellReason,
    holdingPeriod,
    riskLevel,
    stopLoss,
    takeProfit,
  };
}

module.exports = { inferAdvice };
