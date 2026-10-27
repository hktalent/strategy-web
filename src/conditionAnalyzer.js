/**
 * 子条件分析器：对单个子条件（如"ROE>15%"/"MACD金叉"）给出
 *  { scope, value, func, features, limitations, range }
 *  基于关键词规则，零成本、毫秒级。
 */

const RULES = [
  // ===== 财务/基本面 =====
  {
    test: /roe|净资产收益率/,
    scope: '基本面·盈利能力',
    value: '衡量股东回报水平',
    func: '筛选高ROE优质公司，剔除低效资产',
    features: '比率指标，纵向横向可比',
    limitations: '受非经常性损益影响，银行业天然高，周期股高位失真',
    range: '全行业通用，金融/周期股需单独评估',
  },
  {
    test: /毛利率|销售毛利/,
    scope: '基本面·盈利能力',
    value: '反映产品定价权和成本控制',
    func: '筛选有护城河的公司',
    features: '稳定性比绝对值更重要',
    limitations: '不同行业差异极大，不可跨行业直接比较',
    range: '消费/医药/科技制造',
  },
  {
    test: /净利率|销售净利|净利率/,
    scope: '基本面·盈利能力',
    value: '扣除所有费用后的实际赚钱能力',
    func: '判断公司真实盈利质量',
    features: '受费用率和税影响',
    limitations: '一次性损益会扭曲',
    range: '全行业通用',
  },
  {
    test: /市盈率|pe\b|pe[<>=]/,
    scope: '估值·相对估值',
    value: '市场愿为每元利润付多少钱',
    func: '判断贵不贵',
    features: '动态/静态/滚动三种口径',
    limitations: '亏损股无意义；周期股在PE最低时反而是顶',
    range: '盈利稳定的消费/制造业',
  },
  {
    test: /市净率|pb\b|pb[<>=]/,
    scope: '估值·相对估值',
    value: '股价相对净资产的倍数',
    func: '筛选破净或高估股',
    features: '重资产行业适用',
    limitations: '轻资产公司（互联网/软件）PB参考意义弱',
    range: '银行/地产/钢铁/周期',
  },
  {
    test: /净利润|扣非|归母/,
    scope: '基本面·盈利规模',
    value: '公司最终赚多少钱',
    func: '排除亏损公司',
    features: '绝对值受行业影响',
    limitations: '一次性收益会粉饰',
    range: '全行业通用',
  },
  {
    test: /营业收入|营收|主营收入/,
    scope: '基本面·收入规模',
    value: '公司业务体量',
    func: '排除营收过小或下滑公司',
    features: '营收是利润的先行指标',
    limitations: '增收不增利常见',
    range: '全行业通用',
  },
  {
    test: /资产负债率|负债率|有息负债/,
    scope: '基本面·偿债能力',
    value: '负债占资产比重',
    func: '排除高杠杆风险',
    features: '银行业天然高杠杆',
    limitations: '不同行业标准不一',
    range: '非金融行业',
  },
  {
    test: /现金流|经营现金流|自由现金流/,
    scope: '基本面·盈利质量',
    value: '真金白银的流入',
    func: '识别纸面利润造假',
    features: '比利润更难操纵',
    limitations: '高速扩张期可能为负',
    range: '全行业通用',
  },

  // ===== 成长 =====
  {
    test: /增长率|同比|环比|增长|增速/,
    scope: '成长·增速',
    value: '公司业务扩张速度',
    func: '筛选高成长股',
    features: '高增长通常给高估值',
    limitations: '高增长不可持续；低基数效应；需连续多年验证',
    range: 'TMT/新能源/医药等成长行业',
  },

  // ===== 技术趋势 =====
  {
    test: /均线|ma[0-9]|5日|10日|20日|60日|120日|250日/,
    scope: '技术面·趋势',
    value: 'N日平均持仓成本',
    func: '判断趋势方向和支撑位',
    features: '滞后指标，趋势市好用',
    limitations: '震荡市频繁假信号；参数越长越钝',
    range: '趋势明确的个股/指数',
  },
  {
    test: /macd/,
    scope: '技术面·动量',
    value: '快慢均线差值反映动量变化',
    func: '金叉买、死叉卖；底背离抄底',
    features: '趋势型指标',
    limitations: '震荡市频繁假信号；滞后',
    range: '中长线趋势行情',
  },
  {
    test: /kdj|rsi/,
    scope: '技术面·震荡',
    value: '超买超卖程度',
    func: '短期拐点判断',
    features: '灵敏',
    limitations: '单边趋势中会持续超买/超卖失效',
    range: '震荡市、短线交易',
  },
  {
    test: /boll|布林/,
    scope: '技术面·波动',
    value: '价格通道',
    func: '触上轨减仓、触下轨反弹',
    features: '自适应波动率',
    limitations: '突破上轨后可能延续上涨（不要机械做空）',
    range: '震荡市',
  },
  {
    test: /金叉/,
    scope: '技术面·买入信号',
    value: '短期均线上穿长期均线',
    func: '趋势转多确认',
    features: '经典买入信号',
    limitations: '下跌中继的反弹会假金叉',
    range: '中长线',
  },
  {
    test: /死叉/,
    scope: '技术面·卖出信号',
    value: '短期均线下穿长期均线',
    func: '趋势转空警示',
    features: '经典卖出信号',
    limitations: '震荡市频繁触发',
    range: '中长线',
  },
  {
    test: /新高|历史新高|阶段新高/,
    scope: '技术面·强势',
    value: '股价突破近期/历史高点',
    func: '强者恒强，追势策略核心',
    features: '无套牢盘压力',
    limitations: '追高风险大；可能假突破',
    range: '牛市/强势股',
  },
  {
    test: /新低/,
    scope: '技术面·弱势',
    value: '股价跌破近期低点',
    func: '规避或抄底（需其他信号配合）',
    features: '趋势仍向下',
    limitations: '接飞刀风险',
    range: '熊市/弱势股',
  },
  {
    test: /背离/,
    scope: '技术面·拐点',
    value: '价格与指标反向走',
    func: '预示趋势可能反转',
    features: '预警信号',
    limitations: '可能多次背离后才反转',
    range: '中短线拐点',
  },

  // ===== 量能 =====
  {
    test: /成交量|成交额|放量|缩量/,
    scope: '量能·资金参与',
    value: '交易活跃度',
    func: '价涨量增确认趋势；缩量回调健康',
    features: '量在价先',
    limitations: '对倒放量可造假',
    range: '全市场通用',
  },
  {
    test: /量比/,
    scope: '量能·当日强度',
    value: '今日量能相对过去5日平均',
    func: '开盘筛选异动股',
    features: '早盘指标',
    limitations: '10点后参考意义下降',
    range: '早盘打板/异动筛选',
  },
  {
    test: /换手率/,
    scope: '量能·筹码交换',
    value: '筹码周转频率',
    func: '判断活跃程度和资金分歧',
    features: '结合股价位置看',
    limitations: '小盘股天然高换手',
    range: '全市场通用',
  },

  // ===== 价格形态 =====
  {
    test: /大阳线|阳线|涨停板/,
    scope: '形态·多头',
    value: '单日强势上涨',
    func: '短期强势确认',
    features: '视觉冲击强',
    limitations: '位置高低决定后续',
    range: '短线',
  },
  {
    test: /阴线|跌停/,
    scope: '形态·空头',
    value: '单日下跌',
    func: '规避信号',
    features: '—',
    limitations: '—',
    range: '短线',
  },
  {
    test: /十字星|星线/,
    scope: '形态·犹豫',
    value: '多空平衡',
    func: '变盘预警',
    features: '需次日方向确认',
    limitations: '单独使用胜率低',
    range: '短线拐点',
  },
  {
    test: /突破/,
    scope: '形态·方向选择',
    value: '价格越过关键位',
    func: '趋势启动信号',
    features: '需量能配合',
    limitations: '假突破常见',
    range: '中短线',
  },
  {
    test: /回踩|回调|回撤/,
    scope: '形态·介入点',
    value: '上涨后回落',
    func: '低吸机会',
    features: '比追高安全',
    limitations: '可能直接反转',
    range: '趋势市',
  },

  // ===== 涨停/事件 =====
  {
    test: /涨停|连板|首板/,
    scope: '事件·情绪',
    value: '当日涨幅触板',
    func: '打板/情绪溢价策略核心',
    features: 'A股T+1制度下的特殊现象',
    limitations: '次日低开风险大；只适合短线',
    range: '短线打板客',
  },
  {
    test: /龙虎榜/,
    scope: '事件·席位资金',
    value: '交易所公布的大单席位',
    func: '跟踪游资/机构动向',
    features: '公开数据',
    limitations: 'T+1才公布；席位可造假',
    range: '短线情绪股',
  },

  // ===== 股票池过滤 =====
  {
    test: /非st|st股|退市/,
    scope: '股票池·风险过滤',
    value: '剔除风险警示股',
    func: '规避退市风险',
    features: '风控基础项',
    limitations: '可能错过ST摘帽行情',
    range: '全市场',
  },
  {
    test: /新股|次新|上市/,
    scope: '股票池·上市时间',
    value: '剔除/保留次新股',
    func: '次新波动大，常单独处理',
    features: '次新无历史套牢盘',
    limitations: '次新估值波动极大',
    range: '打新/次新策略',
  },
  {
    test: /北交所|科创板|创业板/,
    scope: '股票池·板块过滤',
    value: '按上市板筛选',
    func: '不同板块涨跌幅/门槛不同',
    features: '制度差异',
    limitations: '—',
    range: '全市场',
  },
  {
    test: /行业|板块|概念|半导体|医药|新能源|白酒|光伏/,
    scope: '股票池·行业',
    value: '按行业/概念圈定范围',
    func: '聚焦赛道',
    features: '需要行业景气度判断',
    limitations: '行业轮动快',
    range: '行业轮动策略',
  },

  // ===== 市值/规模 =====
  {
    test: /总市值|流通市值|市值/,
    scope: '规模·市值',
    value: '公司体量',
    func: '大盘/中盘/小盘风格筛选',
    features: '风格因子',
    limitations: '小盘股流动性差、波动大',
    range: '全市场',
  },
  {
    test: /总股本|流通股/,
    scope: '规模·股本',
    value: '股本大小',
    func: '判断炒作空间',
    features: '小盘股易拉升',
    limitations: '—',
    range: '短线',
  },

  // ===== 择时 =====
  {
    test: /早盘|集合竞价|9点|10点|11点|开盘/,
    scope: '择时·日内',
    value: '特定时段筛选',
    func: 'A股早盘异动最明显',
    features: '盘口数据',
    limitations: '10点后信号衰减',
    range: '日内交易',
  },
  {
    test: /收盘|尾盘|14点|15点/,
    scope: '择时·日内',
    value: '尾盘时段',
    func: '收盘前确认信号',
    features: '避免日内噪音',
    limitations: '—',
    range: '日线级别',
  },
  {
    test: /日期|时间|202\d|年.*月/,
    scope: '择时·日期',
    value: '限定时间窗口',
    func: '历史回测/事件驱动',
    features: '硬编码时间',
    limitations: '过拟合历史',
    range: '事件驱动',
  },

  // ===== 情绪 =====
  {
    test: /热门|人气|关注|热搜|排行/,
    scope: '情绪·人气',
    value: '市场关注度',
    func: '追热点',
    features: '情绪因子',
    limitations: '高位接盘风险',
    range: '短线',
  },

  // ===== 筹码 =====
  {
    test: /筹码|集中度|获利盘/,
    scope: '筹码·分布',
    value: '持仓成本分布',
    func: '判断压力位和支撑位',
    features: '估算指标',
    limitations: '数据是估算的',
    range: '中线',
  },
];

const GENERIC = {
  scope: '其他条件',
  value: '策略过滤条件',
  func: '参与多条件组合',
  features: '自定义/特殊条件',
  limitations: '语义较模糊，建议人工核实',
  range: '需结合上下文判断',
};

function analyzeCondition(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const lower = text.toLowerCase();
  for (const r of RULES) {
    if (r.test.test(lower)) {
      return { ...r, text };
    }
  }
  return { ...GENERIC, text };
}

module.exports = { analyzeCondition, RULES };
