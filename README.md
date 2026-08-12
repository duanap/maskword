# Maskword · 谁是卧底

移动端优先的“谁是卧底”，同时提供多人手机线上联机和一台设备轮流操作的线下同屏玩法。系统负责私密发牌、发言顺序、匿名投票、淘汰、胜负结算和再来一局；玩家的描述与讨论在线下面对面完成。

## V2 功能

- 保留“线上联机 / 线下同屏”两个入口，支持经典明牌、经典暗牌、明牌自爆、暗牌自爆四种模式
- 身份包含平民、普通卧底、白板和双面间谍；创建前校验人数门槛、特殊身份占比和阵营平衡
- 自爆猜词只能与普通选票原子提交，平票时密封到重投最终结算；猜中优先获胜，猜错与票选可同轮淘汰多人
- 双面间谍在普通卧底全部淘汰后同时激活一次猜词机会，彼此身份仍不公开
- 词库 V2 共享唯一来源，包含 15 个分类、3 档难度与适用人群元数据；不参赛主持人可私密自定义两个词
- 16 个房间内不重复的固定头像穿贯等待、发言、投票、结果和复盘
- 可选 30/45/60 秒发言提示，超时不自动推进；结果可选自动 5 秒或主持人手动继续
- 日间/夜间主题按设备当地时间 08:00/20:00 自动切换，手动选择当天有效，并同步 PWA 主题色

- 创建 6 位数字房间号，设置平民、卧底、白板人数以及房主是否参赛
- 昵称统一设置并在本机记忆，创建房间与加入房间使用两条独立入口
- 服务端随机分配身份和本地词库词语，客户端在结束前只能获得自己的私密信息
- 身份卡点击查看、再次点击隐藏、5 秒自动隐藏，并在失焦或切后台时收起
- 每轮重新随机存活玩家发言顺序，非白板优先成为第一位发言者
- 普通匿名投票、60 秒超时弃权、按存活人数控制主动弃权、无时限平票重投；平票候选人可看到自己与上一轮匿名票数
- 淘汰观战、退出处理、自动胜负判断、身份公开和原房间再来一局
- 刷新、短暂断线和切到后台后自动恢复；传输重连后会重新绑定玩家并以服务端新快照为准；房主离线 15 秒后自动转移
- 等待房间、结束房间和全员离线游戏的内存清理
- PC 端使用独立 WebP 聚会背景，手机端保持无干扰的单页布局
- 线下同屏支持 3–12 名参赛者、主持人不参赛、逐人私密发牌和无倒计时匿名投票
- 线下对局按已确认步骤保存在本机；刷新、失焦或切后台后从中性交接页恢复，不重新展示敏感信息
- 可安装为 PWA；首次联网完成缓存后，可断网打开线下同屏并继续本地对局

V2 不包含账号、语音、录音、文字聊天、广告、数据库、Redis、ORM 和 Docker。

## 架构

```text
apps/web       Vue 3 + Vite 移动端 H5
apps/server    Fastify + Socket.IO 游戏服务
packages/shared 共享协议、词库和纯游戏规则
```

线上联机以服务端为唯一可信状态源，房间状态只保存在 Node.js 进程内存中；服务重启后现有房间会失效。线下同屏不会创建房间或连接 Socket.IO，状态保存在浏览器的 `maskword-offline-v2` 本地存储中；V1 进行中存档会被安全清除并提示重新开局。共享词库位于 `packages/shared/src/words.ts`。

## 线下同屏

- 首位现场成员默认是主持人；主持人可参赛或仅主持，也可在游戏中转移权限
- 默认白板和双面间谍均关闭，高级设置需满足开局约束
- 发牌、身份复查和投票都先显示中性交接页；身份只展示 5 秒，点击可立即隐藏
- 发言由主持人逐位推进；每轮重新随机顺序，存在非白板玩家时白板不会首先发言
- 普通投票和平票重投均不限时；4 人及以上可弃权，剩 3 人时不可弃权
- 普通投票有人退出时整轮作废重投；平票候选人退出时取消本轮重投并进入下一轮
- 轮次结果由主持人手动继续；结算公开词语、身份、生存状态和各轮汇总票数

本地存档和前端词库无法抵御设备所有者通过开发者工具查看，线下模式的隐私边界是现场轮流持有设备。首次打开仍需联网安装资源；浏览器清理站点数据会删除尚未结束的线下对局。

## 本地运行

需要 Node.js 22 或更高版本与 pnpm 10；生产目标版本为 Node.js 24。

```bash
pnpm install
pnpm dev
```

- 前端开发地址：`http://127.0.0.1:5173`
- 游戏服务默认地址：`http://127.0.0.1:2000`
- 健康检查：`http://127.0.0.1:2000/api/health`

生产构建与单进程运行：

```bash
pnpm build
pnpm --filter @maskword/server start
```

可通过 `HOST`、`PORT` 和 `WEB_DIST_PATH` 环境变量调整监听地址、端口和前端构建目录。生产环境应保持 `HOST=127.0.0.1`，由 Nginx 提供公开访问。

## 验证

```bash
pnpm typecheck
pnpm test
pnpm test:integration
pnpm test:e2e
pnpm build
```

测试覆盖共享身份规则、白板首位保护、线上隐私快照、弃权和平票重投、房主淘汰后主持、恢复令牌、不刷新页面的断网重连、主动退出，以及线下三人完整对局、不参赛主持、本地恢复、整轮重投和再来一局。

生产构建会生成 `sw.js` 和 `manifest.webmanifest`。发布时应让 `sw.js`、manifest 和 `index.html` 使用不缓存或短缓存策略，带哈希的 `/assets/` 保持长期缓存；`/api/` 与 `/socket.io/` 不得进入 Service Worker 缓存。

## 房间规则默认值

- 参赛人数：3–12
- 昵称：1–12 个字符，同房间规范化后不可重名
- 模式：经典明牌；白板 0；双面间谍 0
- 词源：全民精选；难度：标准
- 自爆提示：第 2 轮普通投票；发言计时：关闭
- 普通投票：60 秒；未提交视为弃权
- 平票重投：不限时，房主可手动结束并将未提交者计为弃权
- 轮次结果：线上默认自动 5 秒，线下默认主持人手动
- 房主断线：15 秒后自动转移给最早加入的在线成员
- 等待房间：2 小时无活动后清理
- 已结束房间：1 小时无活动后清理
- 游戏进行中全员离线：30 分钟后清理

## 生产部署门槛

规划域名为 `maskword.duanap.cn`，规划目录为 `/www/wwwroot/duanap/apps/maskword`。部署前应以实时服务器检查结果为准，不得假定端口或站点配置可用。

部署前必须重新执行只读检查：

```bash
ss -lntup
nginx -T
systemctl --type=service --state=running
pm2 ls
node --version
```

确认 2000 未被占用、目标目录和站点归属正确、真实代理链与证书无冲突后，才能继续：

```bash
cd /www/wwwroot/duanap/apps/maskword
pnpm install --frozen-lockfile
pnpm build
pm2 startOrReload ecosystem.config.cjs --only maskword
curl -fsS http://127.0.0.1:2000/api/health
```

生产 PM2 配置默认使用宝塔安装的 Node.js 24：`/www/server/nodejs/v24.12.0/bin/node`。如服务器升级或迁移，必须先确认新解释器路径，再通过 `MASKWORD_NODE_INTERPRETER` 显式覆盖。

若服务器已存在该域名的 `server` 块，只允许增量合并 [deploy/nginx.locations.conf](deploy/nginx.locations.conf) 中的 location；不得覆盖原配置。若实时检查确认该域名尚无站点配置，可使用 [deploy/nginx.maskword.conf](deploy/nginx.maskword.conf) 创建独立 HTTP 源站，由现有边缘服务提供公网 HTTPS。修改后必须先执行 `nginx -t`，确认成功再 reload。

## 当前生产快照

2026-08-11 已完成首次部署：

- 公网地址：`https://maskword.duanap.cn`
- 应用目录：`/www/wwwroot/duanap/apps/maskword`
- 发布归档：`/www/wwwroot/duanap/artifacts/maskword/maskword-v1-20260811-131633.tar.gz`
- 归档 SHA-256：`c91a6a7129436016d3fc98814cd9ac318e412080e092d5b5f7e130a642317bba`
- PM2 进程：`maskword`，单实例 fork，Node.js `24.12.0`
- 应用监听：`127.0.0.1:2000`
- Nginx 配置：`/www/server/panel/vhost/nginx/maskword.duanap.cn.conf`
- 宝塔站点：ID `37`，显示名“谁是卧底”，域名记录端口 `80`
- 宝塔登记前数据库快照：`/www/wwwroot/duanap/archive/panel/site.db.before-maskword-20260811-132958`
- 源站 SSL：宝塔证书夹 ID `13` 的 `*.duanap.cn` 证书，有效期至 `2026-11-07`
- SSL 配置前备份：`/www/wwwroot/duanap/archive/maskword/ssl-20260811-133439`
- 公网 HTTPS 由现有边缘服务提供；源站同时保留 HTTP 和 HTTPS，避免 EdgeOne 回源重定向循环

上线验收已覆盖源站健康、带缓存穿透参数的公网 HTTPS、WebSocket、3 人完整对局、再来一局、PM2 重启恢复和 412px 手机页面。

2026-08-11 已完成 EdgeOne 旧首页缓存刷新；不带查询参数的 `https://maskword.duanap.cn/` 已重新回源并通过最终公网验收。

2026-08-11 增量发布了入口分流、PC WebP 背景和平票候选人票数修复；发布归档为 `/www/wwwroot/duanap/artifacts/maskword/maskword-v1-20260811-141436.tar.gz`，SHA-256 为 `96fe088af127a0c5ee3708693fc9db2a98d06d420989d416bee10b0326f04e64`。上一版本完整保留在 `/www/wwwroot/duanap/archive/maskword/release-before-20260811-141436`。

## 启停与回滚

```bash
pm2 status maskword
pm2 restart maskword
pm2 stop maskword
pm2 logs maskword --lines 100
```

发布前应保留上一版本目录或 Git 提交。回滚时切回已验证提交，重新执行 `pnpm install --frozen-lockfile && pnpm build`，然后 `pm2 startOrReload ecosystem.config.cjs --only maskword`。Node 进程重启会使当时的内存房间失效，这是 V1 的已知限制。

首次部署尚无上一应用版本；如需整体下线，应先停止 `maskword` 进程，再将 Nginx 配置移动到发布归档目录，执行 `nginx -t` 成功后 reload。不要覆盖或修改其他站点配置。
