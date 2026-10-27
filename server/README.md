# 钻井经营考核系统 · 后端服务

给现有的单文件网页版套一个真正的后端：井库、定额库、月度填报数据落地存到服务器的
`data/` 目录（不再只存在某台电脑的浏览器 localStorage 里），加了账号登录。

前端页面本身没有拆分成两份——`public/index.html` 和你桌面那份
`经营考核系统.html` 是同一个文件：它会先探测 `/api/health`，探测到后端就走登录 +
服务器读写；探测不到（比如被当静态文件直接双击打开，或发布成 claude.ai 上的
artifact）就自动退回原来的浏览器本地存储模式，两种场景一份文件都能用。

## 目录结构

```
server/
  server.js          入口：起 Express、挂路由、托管前端静态文件
  lib/
    store.js          JSON 文件存储层（每类数据一个 data/*.json，原子写入）
    auth.js            账号/登录/JWT session
    seed.js             首次启动的初始化（写入附件1 定额基线、建默认管理员）
  public/
    index.html          前端页面（与桌面那份同源，替换即可升级）
  data/                  运行时生成，存实际数据，不进版本库（线上用 .env 的 DATA_DIR 放到代码目录之外）
  backups/               「数据备份」页生成的快照，总在数据目录旁边
  .env                   本机配置，不进版本库（.env.example 是模板）
```

## 本地跑起来

需要 Node.js 18 及以上。

```bash
cd server
npm install
cp .env.example .env      # 已存在则跳过
npm start
```

终端会打印一段初始管理员账号——**只在没有任何账号时打印一次**，请立即记录：

```
[auth] 已创建初始管理员账号，请立即登录后在"账号管理"里修改密码：
        用户名: admin
        密码  : 一串随机字符
```

浏览器打开 `http://localhost:4000`，用这个账号登录即可。首次启动还会自动把
附件1（2026年8月版）定额基线写入 `data/quota.json`，井库留空，由团队自己录入。

## 账号管理

暂时没做管理页面，用接口（登录后，浏览器已带着 cookie，或者用 curl 手动带上）：

```bash
# 新建账号（管理员操作）
curl -b cookies.txt -X POST http://localhost:4000/api/users \
  -H "content-type: application/json" \
  -d '{"username":"kaohebangongshi","password":"设一个强密码","role":"editor"}'

# 改密码
curl -b cookies.txt -X POST http://localhost:4000/api/users/admin/password \
  -H "content-type: application/json" -d '{"password":"新密码"}'
```

`role` 只分 `admin`（能管账号）和 `editor`（能读写井库/定额库/填报数据），
没有更细的权限——够内部小团队用；真要按主体单位拆权限，在 `lib/auth.js` 和各路由
里加判断即可，`requireAuth` 中间件已经把 `req.user.role` 挂好了。

## 部署到公网（国内云厂商，先不用域名）

已确认走这条路：**不接域名、不走 ICP 备案**，直接用「服务器公网 IP + 端口」访问。
备案是「域名 + 大陆服务器」同时出现才会被要求的手续，纯 IP 访问完全不触发，
今天买完机器就能上线。代价是后面「HTTPS」那节说的——先天拿不到大部分免费证书
（要域名验证），登录目前会话默认走明文 HTTP。下面按顺序做。

### 1. 选服务器：国内三家二选一，都买「轻量应用服务器」这条产品线

不要买标准 ECS/CVM——配置项多、要自己开安全组规则、装系统盘，对第一次自己
运维的人不友好。「轻量应用服务器」是三家云厂商专门给"个人/小团队快速上线一个
应用"做的产品：固定套餐、自带防火墙管理界面、控制台能一键装好 Node 环境的镜像，
新手最省心。

| 厂商 | 产品名 | 备注 |
|---|---|---|
| 阿里云 | 轻量应用服务器 | 用户最多、中文文档/报错搜索最好搜到答案，出问题时最容易在网上找到解法 |
| 腾讯云 | 轻量应用服务器 | 界面思路和阿里云几乎一样，新用户首年折扣通常更猛 |
| 华为云 | 弹性云服务器 / 耀云服务器 | 企业客户偏多，稳定性口碑好，界面稍微复杂一点 |

三家随便选一家都行（选新用户优惠力度大的那家更划算，价格经常变，下单前直接
在官网比一下）。配置按这个买：

- **地域**：选离你们钻井公司实际所在城市最近的大陆节点（比如天津/华北，
  对应大港油区所在地），访问最快。
- **镜像**：Ubuntu 22.04 LTS（或 CentOS/Anolis 也行，下面命令按 Ubuntu 写，
  CentOS 系把 `apt` 换成 `yum`/`dnf` 就是了）。
- **规格**：2 核 2G 或 2 核 4G 足够——这套系统是给公司内部团队用的，日常访问量
  很低，不用买大配置。
- **带宽**：3-5 Mbps 起步够用（内部工具，没有大文件下载/视频这类高带宽场景）。

买完控制台里会有「防火墙」或「安全组」设置，**只开放这三个端口**：
- `22`（SSH，远程连接用；如果厂商支持限制来源 IP，把它锁定成你自己办公室的
  出口 IP，比开放给所有人安全得多）
- `4000`（这套系统实际跑的端口，下面会用到）
- 不需要开 80/443——没走 Nginx/HTTPS 这条线的话用不上。

### 2. 连上服务器

Windows 上直接用系统自带的 SSH 客户端就行，不用装额外软件——按 `Win+R` 输入
`cmd` 或打开 PowerShell：

```bash
ssh root@你的服务器公网IP
```

厂商购买成功页面会给你 root 密码（或者提示你去控制台设置）。首次连接会问
"是否信任这台主机"，输 `yes` 回车。

### 3. 装 Node.js

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
node -v      # 确认输出 v20.x
```

### 4. 上传代码

最简单的方式：在本机把 `server` 整个文件夹打包，用 `scp` 传上去（`data/` 和
`.env` 不用传，服务器上会重新生成/配置）。在**本机**（你现在这台 Windows 电脑）
的终端里：

```bash
cd "C:/Users/86188/Desktop/经营责任制实施办法"
scp -r server root@你的服务器公网IP:/opt/kaohe-server
```

如果嫌命令行麻烦，用图形化工具也行——WinSCP、FileZilla 都支持直接拖拽文件夹
上传，连接方式选 SFTP，账号密码跟 SSH 一样。

### 5. 服务器上装依赖、配置

回到 SSH 会话里：

```bash
cd /opt/kaohe-server
rm -rf data backups .env  # 只在首次部署做：清掉随代码带上来的本机数据
mkdir -p /var/lib/kaohe   # 线上数据放这里，和代码目录分开
npm install --omit=dev
cp .env.example .env
nano .env                 # 或用 vi，改下面四处
```

`.env` 里至少改这四行（JWT_SECRET 用 `node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"`
生成一串随机字符粘进去；COOKIE_SECURE 没有 https 就必须是 0，改成 1 反而会导致登录态存不住）。
**每行只写 `键=值`，后面不要跟 `#` 注释**——systemd 会把注释当成值的一部分：

```
PORT=4000
JWT_SECRET=上面生成的随机字符
COOKIE_SECURE=0
DATA_DIR=/var/lib/kaohe/data
```

`DATA_DIR` 是防止「重新上传代码把线上数据冲掉」的关键：数据和备份都在
`/var/lib/kaohe/` 下，`/opt/kaohe-server` 整个覆盖、删掉重传都碰不到它们。
启动日志里的「数据目录：」一行应显示 `/var/lib/kaohe/data`，显示的是
`/opt/kaohe-server/data` 就说明 `.env` 没生效，先别让大家用。

### 6. 用 systemd 常驻运行（开机自启、崩了自动重启）

```bash
nano /etc/systemd/system/kaohe.service
```

粘进去：

```ini
[Unit]
Description=钻井经营考核系统
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/kaohe-server
ExecStart=/usr/bin/node server.js
Restart=on-failure
EnvironmentFile=/opt/kaohe-server/.env

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload
systemctl enable --now kaohe
systemctl status kaohe        # 应该看到 active (running)
journalctl -u kaohe -f        # 看实时日志，Ctrl+C 退出；启动时的初始管理员账号密码就打印在这里，立即记下来
```

### 7. 验证

浏览器打开 `http://你的服务器公网IP:4000`，应该看到登录框。用日志里的初始账号
登录，能看到仪表盘就是通了。把这个网址发给同事，他们直接在自己电脑浏览器里
打开同一个地址即可，不需要装任何东西。

### 8. 关于 HTTPS——现在没有，什么时候需要补上

IP 直连拿不到大部分免费证书（Let's Encrypt 这类主流 CA 都要求验证域名归属）。
这意味着登录时用户名密码，以及后续所有数据，走的是明文 HTTP——同一段公共网络
上理论上有被窃听的可能（自己办公室内网访问基本没这个顾虑，但公网上任何人
都能访问到这个地址时风险是真实存在的）。三个应对方式，按推荐程度排：

1. **最推荐：以后申请一个域名，走前面「大陆节点 + 备案」或本节这条路线都行**，
   备案通过后把 Nginx + certbot 那段配置接上（下方有现成配置），才是长期该
   到达的状态。域名很便宜（一年几十块），备案是等待时间成本不是钱的成本。
2. **过渡方案：自签名证书**。能让传输加密，但浏览器会显示"不安全/证书不受信任"，
   访问的人第一次要手动点"继续访问"，之后大多数浏览器会记住。适合先内部用起来、
   还没顾上申请域名的阶段：
   ```bash
   apt-get install -y nginx
   mkdir -p /etc/nginx/ssl
   openssl req -x509 -nodes -days 3650 -newkey rsa:2048 \
     -keyout /etc/nginx/ssl/kaohe.key -out /etc/nginx/ssl/kaohe.crt \
     -subj "/CN=kaohe-internal"
   ```
   然后配 Nginx 监听 443、`ssl_certificate` 指到这两个文件、`proxy_pass` 转发到
   `127.0.0.1:4000`，`.env` 里把 `COOKIE_SECURE=1`。需要的话告诉我，我把完整
   Nginx 配置文件写出来。
3. **谨慎尝试：sslip.io 这类免注册通配符域名**。把 `http://你的IP:4000` 换成
   `http://IP用短横线分隔.sslip.io:4000`（比如 IP 是 1.2.3.4 就是
   `1-2-3-4.sslip.io`），这个域名指向的就是你自己的服务器，不需要注册、不涉及
   备案，理论上可以用它去申请 Let's Encrypt 证书拿到真正被浏览器信任的 https。
   这是社区里常用的手法，但它依赖一个第三方免费服务长期可用，不建议作为正式
   生产环境的长期方案，出问题（服务下线、被云厂商网络策略拦截）没人兜底。

在此之前，**至少把 SSH（第 22 端口）的访问来源锁定到你们公司出口 IP**，这是
成本最低、收益最大的一步安全加固，控制台的安全组/防火墙页面就能设置。

### 用 Docker 部署

如果你们平台习惯容器化，告诉我，我再补一份 Dockerfile 和 docker-compose.yml——
现在这版先给最简单能跑起来的裸 Node + systemd 方案。

## 更新线上代码

设好 `DATA_DIR` 之后，更新代码就是把本机 `server` 文件夹重新传一遍（scp / WinSCP 覆盖即可），
本机的 `data/`、`backups/` 跟着传上去也没关系——服务器根本不读它们。传完：

```bash
cd /opt/kaohe-server
npm install --omit=dev
systemctl restart kaohe
journalctl -u kaohe -n 20     # 确认「数据目录：/var/lib/kaohe/data」
```

**不要再跑第 5 步的 `rm -rf` 和 `cp .env.example .env`**，那是首次部署用的；`.env` 被覆盖会丢掉
`JWT_SECRET` 和 `DATA_DIR`，所有人被踢下线、数据又回到代码目录里那份。

### 已经上线、数据还在 /opt/kaohe-server/data 的服务器：迁移一次

```bash
systemctl stop kaohe
mkdir -p /var/lib/kaohe
cp -a /opt/kaohe-server/data /var/lib/kaohe/data
[ -d /opt/kaohe-server/backups ] && cp -a /opt/kaohe-server/backups /var/lib/kaohe/backups
echo 'DATA_DIR=/var/lib/kaohe/data' >> /opt/kaohe-server/.env
systemctl start kaohe
journalctl -u kaohe -n 20     # 确认数据目录已是 /var/lib/kaohe/data，登录核对数据无误
```

旧的 `/opt/kaohe-server/data` 先留着别删，确认新位置一切正常后再清理。

## 关于 git：data/ 和 logs/ 不进版本库

`server/data/` 和 `logs/` 已从 git 跟踪中移除并写进 `.gitignore`，各台电脑、线上服务器各自
保留自己的数据，`git pull` / 上传代码不再互相覆盖。

**每台电脑第一次拉取这个改动之前，先把 `server/data/` 整个复制到别处**——这次提交在 git 看来
是「删除这些文件」，拉取时会把本地的数据文件一并删掉；拉完再把复制出去的 `data/` 拷回原位即可，
之后就再也不会被 git 动到。

## 数据备份

所有数据就是数据目录（默认 `data/`，线上为 `DATA_DIR`）下的几个 JSON 文件（`wells.json` 井库、`quota.json`
定额库、`filings-<年份>.json` 月度填报、`users.json` 账号），定期整份拷走
（`cp -r data/ 备份路径/data-$(date +%F)/`）就是完整备份，恢复直接拷回去重启
服务即可，不需要数据库层面的导出导入。

## 已知边界（超出这次范围，需要再扩展时告诉我）

- 井库/定额库/填报数据目前是"整份 JSON 读、整份 JSON 写"，多人同时操作时后
  提交的会覆盖先提交的（last-write-wins），没做逐字段合并或加锁。内部小团队、
  操作不算频繁的场景下够用；真要多人并发编辑同一份数据，需要换成真正的数据库
  加行级更新。
- 没有操作日志/审计轨迹（谁在什么时候改了哪口井的哪个字段），现在只能看到
  "最后一次是谁改的"（井记录里的 `status`/`at` 字段），改动历史不保留。
