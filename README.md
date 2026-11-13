# 选股策略库 Web（strategy-web）

把散落的 9 万+ 条选股策略（自然语言条件）**自动打标签、算评分、Web 检索**。
<img width="421" alt="image" src="https://github.com/user-attachments/assets/668bb08b-aa6d-443c-8389-76cf6eedbab5" />

## 项目结构

```
strategy-web/
├── package.json
├── src/
│   ├── tagRules.js        # 标签规则库（关键词 → 标签 + 大类）
│   ├── buildIndex.js      # 核心构建（规范化→去重→打标签→评分→分片写库）+ 增量写入 API
│   ├── indexer.js         # 增量索引引擎（队列 / 防抖合并 / 分块事务 / xgTj 差分）
│   └── server.js          # Express API（fan-out 查所有分片，mtime 自动重开）
├── scripts/
│   ├── import.js          # 一次性全量导入
│   ├── watch.js           # 常驻增量监听（单实例锁、启动补齐、优雅退出）
│   ├── daemon.sh          # start/stop/restart/status/logs 后台守护
│   └── install-launchd.sh # 交给 launchd：开机自启 + 崩溃自动拉起
├── public/
│   └── index.html         # 单页前端
├── run/                   # watch.lock / watch.pid（运行时，已 gitignore）
├── logs/                  # watch.log / watch.err.log（已 gitignore）
└── data/
    ├── meta.json          # 总元信息（总量、分片数、标签规则、maxUsage）
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

# Web 服务（分片文件变化时自动重开，无需重启）
npm start                 # http://localhost:3000

# watch 常驻后台（见下方「常驻后台」）
npm run watch:bg
```

**全量重建**（标签规则调整后手动跑一次）：
```bash
npm run import
```

## 常驻后台（watch 始终在跑）

watch 现在只做**增量**：文件变了就只处理这个文件，`xgTj.json` 变了就只比对差分，
不再"一变就重建全库"。

```bash
npm run watch:bg        # = bash scripts/daemon.sh start，nohup 常驻 + 单实例锁
npm run watch:status    # 运行状态 / 累计新增更新数 / 最近日志
npm run watch:logs      # 实时跟踪 logs/watch.log
npm run watch:stop      # 优雅停止（先把队列里的变化写完再退出）
```

要**开机自启 + 崩溃自动拉起**（真正的"始终后台运行"），交给 launchd：

```bash
bash scripts/install-launchd.sh            # 安装并立即启动（KeepAlive，正常退出不会反复重启）
bash scripts/install-launchd.sh status     # 查看 launchd 状态
bash scripts/install-launchd.sh uninstall  # 卸载
```

> launchd 用系统 node（`/usr/local/bin/node`），不依赖任何沙箱/临时运行时；
> 日志固定写 `logs/watch.log`（超 20MB 由 daemon.sh 滚动）。
> 两个入口互斥：`daemon.sh start` 发现 launchd 实例在跑会直接提示已在运行（单实例锁 `run/watch.lock`）。

其它命令：

```bash
npm run watch:once      # 补齐一次就退出（适合 docker entrypoint / CI）
npm run watch:full      # 常驻，并强制对 xgTj.json 做一次全量校正
```

### 自定义原始数据路径

代码自动按当前用户 home 推导默认路径：
- `~/MyWork/goSqlite_gorm/config/xgTj.json`
- `~/MyWork/goSqlite_gorm/策略/`

如需改到别处，启动前设置环境变量：
```bash
XGTJ_PATH=/path/to/xgTj.json STRATEGY_DIR=/path/to/策略 npm start
```

## 自动刷新机制（增量 + 异步）

### 触发

- chokidar 监控 `~/MyWork/goSqlite_gorm/策略/` **第一层**的 `.txt`（`depth: 0`，不递归进 `eastmoney_data` 那两万多个子目录，CPU 近 0）以及 `config/xgTj.json`
- `awaitWriteFinish` 等文件写稳（400ms）才触发，避免读到大文件写到一半的内容

### 增量（只写"变化的内容"）

| 变化 | 处理范围 |
|---|---|
| 新增/修改某个 `.txt` | 只读这一个文件 → 规范化 → 打标签评分 → 只写它命中的那 **1 个分片**，只 commit 它那 **1 行** |
| `xgTj.json` 变化 | 用 `.xgtj-snapshot.json`（hash→usage 快照）**差分**，只把「新增」和「usage 变大」的条目写库；文件没变时直接跳过解析 |
| 已存在但 usage 变大 | 只 `UPDATE` 该行的 usage / usage_score / composite_score |
| 已存在且无变化 | `INSERT OR IGNORE` + 跳过，不产生写盘 |

实测：插入 1 条新策略 **29ms**；启动补齐 434 个 txt + 90k 条校验 **2.3s**；`xgTj.json` 未变时启动**不解析** 13MB。

### 异步 / 不阻塞

- 事件只入队，不原地处理；防抖 600ms、最长攒 4s 后合并成一个批次（连续写文件只会处理最后状态）
- 一个批次按 hash 分片 → 每 500 行一个事务 → **事务之间 `setImmediate` 让出事件循环**
- 上一批没跑完时新变化只打脏标记，跑完自动接下一批，不并发抢写、不堆积
- 写连接 `busy_timeout=5000`；服务端只读连接也设了 `busy_timeout=3000`，短暂持锁时自动等待而不是报 `SQLITE_BUSY`
- `meta.json` 原子写（`.tmp` + `rename`）并节流 3s，服务端不会读到半个 JSON

### 一致性

- 单实例锁 `run/watch.lock`：重复启动（含 launchd 与手动同时起）直接退出，绝不会两个进程抢写同一分片
- 启动自动补齐：目录里所有 txt 过一遍（已存在即跳过），`xgTj.json` 走差分；数据库为空（如第一次部署）自动全量
- 退出（SIGINT/SIGTERM/SIGHUP）先 `drain` 把队列写完再退出；异常只记日志不退出，由 launchd 拉起
- 文件被删除只记日志、不删库内记录（避免误删数据），需要清理请手动处理
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
  - `q`：文本检索，**支持整段粘贴**。先用 normalizeText 归一化（全角→半角），再按 `, ; 、 换行 且` 切成条件片段：
    - 片段之间 **AND**：整段策略只要库里都有就能命中；
    - AND 全不命中且片段 > 4（判定为"粘贴了整段"）时自动降级**宽松匹配**：取最长 12 个片段，要求至少命中 60%，按命中片段数排序 —— 所以措辞略有差异（"一个月内无解禁" vs "近一个月无解禁"）也能把目标那条顶到第一位；
    - 响应带 `queryMode`（`and` / `or` / `none`）与 `fragments`（片段数），前端据此提示。
  - `minUsage`：使用次数下限（新增策略多为 0 次，设成 ≥1 会把它们全过滤掉）
  - `sort`：`compositeScore | usage | segments | diversityScore`（驼峰、下划线两种写法都接受）
- `GET /api/strategy/:id` — 单条详情

## Web 界面

- 左侧：按大类分组的标签云（带计数），点击标签即筛选（AND）
- 顶部：关键词、排序、最低使用次数
- 列表：综合分徽章、使用次数、条件数、"含财务"标记、所有命中标签
- 点击策略文本展开全文

---

## Docker 部署

### 前置条件

- Docker Desktop（macOS 需已启动，`docker version` 能看到 Server 版本）
- 本地 `data/` 下已存在分片库（`strategies_0..7.db`、`conditions.db`、`meta.json`），否则先跑 `npm run import`

### 文件职责

| 文件 | 作用 |
|---|---|
| `Dockerfile` | 两阶段构建：`deps` 阶段装 `python3/make/g++` 编译 `better-sqlite3`，运行阶段只保留 `node_modules` + 代码，不带构建工具 |
| `docker-compose.yml` | 单服务 `strategy-web`，仅绑定 `127.0.0.1:3000`，`./data` 只读挂载，`restart: unless-stopped` |
| `.dockerignore` | 排除 `node_modules`、`data`、`.git`，避免镜像被打进 300MB 数据库 |

> 数据**不打包进镜像**，通过 volume 复用本地目录：重新 `npm run import` 后，容器内 server 每 2 秒检测 mtime 自动重开分片，无需重启容器。

### 启动 / 更新 / 停止

```bash
cd ~/MyWork/strategy-web

# 首次或改代码/依赖后：构建并后台启动
docker compose up -d --build

# 仅重启容器（未改镜像，例如调整 restart/端口映射前先 down）
docker compose up -d

# 查看状态与日志
docker compose ps
docker compose logs -f --tail=100

# 停止 / 删除容器（数据目录不受影响）
docker compose down
```

### 验证

```bash
# 健康检查（容器内 HEALTHCHECK 同款探针）
curl -s http://127.0.0.1:3000/api/meta | head -c 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/
curl -s 'http://127.0.0.1:3000/api/strategies?pageSize=2'

# 容器健康状态（healthy 才算真正起来）
docker ps --filter name=strategy-web --format '{{.Names}} {{.Status}}'
```

`/api/meta` 返回 `totalStrategies`（本次环境为 90694）、`totalUsage` 等字段，可据此确认分片挂载成功。

### 注意事项

1. **端口只绑回环**：`127.0.0.1:3000:3000`，不对局域网/公网暴露，外部访问统一走 cloudflared。
2. **端口冲突**：启动前 `lsof -nP -iTCP:3000 -sTCP:LISTEN` 确认空闲；被占用时改 compose 左侧端口（如 `127.0.0.1:3100:3000`），并同步改云隧道的回源地址。
3. **`better-sqlite3` 必须编译**：Node 22 下无匹配预编译包，缺 `python3/make/g++` 会报 `gyp ERR! not ok`。不要图省事把构建工具装进运行镜像，用多阶段构建即可。
4. **`package-lock.json` 必须在构建上下文里**：`npm ci` 依赖它；即使被 `.gitignore` 忽略，本地也需保留。
5. **数据目录只读（`:ro`）**：容器不会写入分片；导入/重建都应在宿主机执行（`npm run import`）。
6. **内存**：compose 限制 `mem_limit: 512m`，8 个分片各 8MB 缓存，实测稳定占用约 95MB；出现 OOM 再调大。
7. **日志**：`json-file` + `max-size` 轮转，避免长期运行撑爆磁盘。
8. **开机自启**：依赖 Docker Desktop 自身启动 + `restart: unless-stopped`，宿主机重启后无需手动拉起。

---

## Cloudflare Tunnel 发布

目标是把公网 `https://stock.51pwn.com` 指向本机 `127.0.0.1:3000`。

### 架构

```
浏览器 → Cloudflare 边缘(HTTPS) → cloudflared 容器（隧道长连接）
       → host.docker.internal:3000 → strategy-web 容器（仅宿主机回环可达）
```

- 隧道复用已有的共享 tunnel（本次为 `goSqlite_gorm`），**一个 tunnel 可承载多个 hostname**，已有的 `www / web / chat` 不受影响。
- `cloudflared` 跑在 Docker 里，回源宿主机端口必须写 `host.docker.internal`（compose 里已配 `extra_hosts: host-gateway`），不能写 `127.0.0.1`（那指向容器自身）。

### 配置结构（示例，不含任何凭据）

```yaml
tunnel: <TUNNEL_ID>
credentials-file: /etc/cloudflared/creds.json   # 凭据文件，内容绝不入库

ingress:
  - hostname: www.51pwn.com
    service: http://51pwn-nginx:80              # 同 compose 网络内用服务名
  - hostname: chat.51pwn.com
    service: https://host.docker.internal:2083
    originRequest:
      noTLSVerify: true
  - hostname: stock.51pwn.com                   # 新增站点
    service: http://host.docker.internal:3000
    originRequest:
      connectTimeout: 30s
  - service: http_status:404                    # 兜底，必须放最后
```

要点：
- `ingress` 自上而下**先匹配先命中**，`http_status:404` 必须留在最后，否则前面的规则全部失效。
- 每条 hostname 必须与 DNS 记录一一对应，且只能是**一个 tunnel**。
- 回源若是 HTTPS 自签证书，需要 `originRequest.noTLSVerify: true`；HTTP 服务不需要。

### 启动 / 新增域名流程

```bash
# 1. 登录授权（仅首次，生成证书文件，切勿外传）
cloudflared tunnel login

# 2. 查看已有隧道与连接数
cloudflared tunnel list
cloudflared tunnel info <TUNNEL_ID_OR_NAME>

# 3. 编辑 ingress 增加 hostname（见上）后重建并重启 cloudflared 容器
cd <cloudflared 所在 compose 目录>
docker compose build cloudflared
docker compose up -d cloudflared

# 4. 建 DNS（CNAME 指向 <TUNNEL_ID>.cfargotunnel.com）
cloudflared tunnel route dns --overwrite-dns <TUNNEL_ID_OR_NAME> stock.51pwn.com

# 5. 验证：先查容器日志确认 4 条连接 Registered，再打公网
docker logs --tail 20 51pwn-cloudflared
curl -s -o /dev/null -w '%{http_code}\n' https://stock.51pwn.com/
curl -s https://stock.51pwn.com/api/meta | head -c 120
```

### 注意事项

1. **凭据管理**：`cert.pem`、`<TUNNEL_ID>.json`（TunnelSecret）、`creds.json` 均属敏感文件，权限保持 `600`，**不要提交 git、不要截图/打印全文、不要通过消息发送**。换机器用 `cloudflared tunnel login` 重新授权，而不是拷贝凭据。
2. **配置是"烘焙"进镜像的**：本项目环境里 Docker Desktop 无法 bind mount `~/Documents` 路径（报 `mkdir /host_mnt/...: operation not permitted`），所以 `config.yml` 通过 Dockerfile `COPY` 进镜像。**改 ingress 必须 `build` + `up -d`，只 `restart` 不生效**。
3. 若希望改成挂载（改配置不用重建），把配置文件放到 Docker Desktop 已共享的目录（如 `$HOME`、`/Users/Shared`），再在 compose 加：
   ```yaml
   volumes:
     - ./cloudflared/config.yml:/etc/cloudflared/config.yml:ro
   ```
   `creds.json` 同理挂载即可，注意设为只读。
4. **不要同时挂多个 connector 到同一 tunnel 且规则不一致**：Cloudflare 会把请求分发给任意一个已注册连接，规则不同会导致"有时 200 有时 502"。若必须多连接器，保持 `config.yml` 完全一致。
5. **DNS 记录冲突**：`route dns` 遇到同名记录会报错，确认要覆盖再用 `--overwrite-dns`；域名必须已接入该 Cloudflare 账号，否则命令会失败。
6. **源站必须可达且只监听回环**：cloudflared 若跑在容器里，`127.0.0.1:3000` 是它自己；跑在宿主机上才用 `127.0.0.1`。两者不能混写。
7. **排障顺序**：`curl http://127.0.0.1:3000/api/meta`（源站）→ `docker logs 51pwn-cloudflared` 看是否有 `Registered tunnel connection` → `cloudflared tunnel info <ID>` 看连接数 → 再测公网域名。公网 502/1033 基本都是隧道没连上或源站未监听。
8. **Cloudflare 侧**：SSL/TLS 模式建议 Full（严格）；国内访问稳定性取决于边缘节点，与本地配置无关。

### 常用命令速查

```bash
# 本机服务
docker compose -f ~/MyWork/strategy-web/docker-compose.yml ps
docker compose -f ~/MyWork/strategy-web/docker-compose.yml logs -f strategy-web

# 隧道
cloudflared tunnel list
cloudflared tunnel info <TUNNEL_ID_OR_NAME>
docker logs --tail 50 51pwn-cloudflared
# 注意：cloudflared 是 distroless 镜像，无法 docker exec 进容器执行 cat 等命令

# 公网自检
for h in www web chat stock; do printf '%s: ' "$h"; curl -s -o /dev/null -w '%{http_code}\n' --max-time 12 "https://$h.51pwn.com/"; done
```
