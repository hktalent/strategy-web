# 选股策略库 Web（strategy-web）

把散落的 9 万+ 条选股策略（自然语言条件）**自动打标签、算评分、Web 检索**。

## 项目结构

```
strategy-web/
├── package.json
├── src/
│   ├── tagRules.js        # 标签规则库（关键词 → 标签 + 大类）
│   ├── buildIndex.js      # 核心构建（规范化→去重→打标签→评分→分片写库）
│   └── server.js          # Express API（fan-out 查所有分片，mtime 自动重开）
├── scripts/
│   ├── import.js          # 一次性全量导入
│   └── watch.js           # 守护进程：监控策略目录自动重建
├── public/
│   └── index.html         # 单页前端
└── data/
    ├── meta.json          # 总元信息（总量、分片数、标签规则）
    └── strategies_{0..7}.db   # 8 个 SQLite 分片，每个 ~8.5MB（< 20MB，可入 git）
```

### 为什么分片

单文件 SQLite 约 69MB，超过 GitHub 单文件 20MB 约束。按 `md5(text) % 8` 分片为 8 个 ~8.5MB 的 `.db` 文件，可直接提交到 git。Server 打开所有分片，查询自动 fan-out 并合并结果，对前端透明。

可调分片数：`SHARD_COUNT=16 npm run import`（每个 ~4MB）。

## 启动

```bash
cd ~/MyWork/strategy-web
npm install
npm run import           # 首次必须跑一次，生成 data/*.db 分片

# 终端1：Web 服务（分片文件变化时自动重开，无需重启）
npm start                 # http://localhost:3000

# 终端2：监控策略目录 + xgTj.json，变化后自动重建全部分片
npm run watch
```

**全量重建**（标签规则调整后手动跑一次）：
```bash
npm run import
```

### 自定义原始数据路径

代码自动按当前用户 home 推导默认路径：
- `~/MyWork/goSqlite_gorm/config/xgTj.json`
- `~/MyWork/goSqlite_gorm/策略/`

如需改到别处，启动前设置环境变量：
```bash
XGTJ_PATH=/path/to/xgTj.json STRATEGY_DIR=/path/to/策略 npm start
```

## 自动刷新机制

- `scripts/watch.js` 用 chokidar 监控 `~/MyWork/goSqlite_gorm/策略/` 下所有 `.txt` 文件，以及 `config/xgTj.json`
- 检测到新增/修改/删除后 **防抖 2 秒** 再触发（避免批量写入时频繁重建）
- 重建流程与 `npm run import` 完全一致：规范化（全角→半角、压缩空白）→ 去重 → 打标签 → 算评分 → 分片写入 `data/strategies_{i}.db`
- `src/server.js` 每 2 秒检测分片 mtime，变化即重开对应分片连接，前端无需重启

## 标签体系

每条策略会被打上 **1~N 个标签**，归属到若干大类。同一策略可同时命中"财务 / 趋势 / 量能"等多个大类，因此跨类筛选是 AND 关系。

### 大类一览

| 大类 | 含义 | 包含标签示例 |
|---|---|---|
| **财务基本面** | 财报硬指标 | ROE、ROA、净利润、营收、毛利率、净利率、资产负债率、现金流、PE、PB、PS、EPS、分红、营运能力、审计治理 |
| **成长** | 增速与连续性 | 利润增长、营收增长、业绩预告、复合成长 |
| **趋势技术** | 技术形态 | 均线系统、MACD、KDJ、BOLL、RSI、趋势排列（金叉/新高/突破）、筹码、BIAS、ENE |
| **量能资金** | 成交与主力 | 量比、换手率、成交量、主力资金 |
| **价格形态** | K 线本身 | 当日涨幅、振幅、K 线形态、价格区间 |
| **涨停事件** | 打板类 | 涨停、连板、首板 |
| **情绪人气** | 市场热度 | 人气排名、龙虎榜、板块题材、股东户数、解禁 |
| **股票池属性** | 范围限定 | 市值规模、板块市场、上市时间、ST/退市、企业性质、地域 |
| **择时** | 盘中时点 | 早盘择时（9:30/竞价）、分时线 |

> 规则在 `src/tagRules.js`，可随时增删关键词。

## 评分算法

每条策略输出 4 个分项 + 1 个综合分（0~1）：

| 分项 | 计算 | 含义 |
|---|---|---|
| `usageScore` | `log10(1+usage) / log10(1+maxUsage)` | 使用频率（log 压缩，避免头部极端值碾压） |
| `complexityScore` | `min(1, 条件段数 / 15)` | 条件越细越精细 |
| `diversityScore` | `命中大类数 / 全部大类数` | 跨维度综合度 |
| `fundamentalBonus` | 命中财务或成长大类 = 1，否则 0 | 含基本面硬指标加分 |

**综合分** `compositeScore = 0.35·usage + 0.20·complexity + 0.25·diversity + 0.20·fundamental`

设计动机：
- 纯高频但单一的策略（如"涨幅>3%"）综合分低；
- 低频但多维度、含财务约束的策略也能排上来；
- 头部高频策略（如使用 37 次的早盘竞价模板）天然靠前。

## API

- `GET /api/meta` — 大类、标签统计、总量
- `GET /api/strategies?tags=ROE,净利润&category=财务基本面&q=涨停&minUsage=5&sort=compositeScore&order=desc&page=1&pageSize=30`
  - `tags`：多选 AND
  - `category`：限定单个大类
  - `q`：文本模糊搜
  - `minUsage`：使用次数下限
  - `sort`：`compositeScore | usage | segments | diversityScore`
- `GET /api/strategy/:id` — 单条详情

## Web 界面

- 左侧：按大类分组的标签云（带计数），点击标签即筛选（AND）
- 顶部：关键词、排序、最低使用次数
- 列表：综合分徽章、使用次数、条件数、"含财务"标记、所有命中标签
- 点击策略文本展开全文
