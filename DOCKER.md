# Fabula · NAS Docker 部署指南

本项目（`server.js` + `web/` + `lib/`）是**零 npm 依赖的纯 Node 服务**，无原生编译、无 GUI、无 Tauri 运行库，可完美跑在 NAS 的 Docker 里。

## 一、本机直接改好后，推到 NAS

在开发机（Windows）的项目根目录执行：

```bash
# 1. 打包（不含本机书稿/数据/日志）
tar --exclude=data/books --exclude=data/trash --exclude=data/versions \
    --exclude=data/exports --exclude=data/writerx.db* --exclude=server.log \
    -czf fabula.tar.gz .

# 2. scp 到 NAS（以飞牛 fnOS 为例，换成你自己的 IP）
scp fabula.tar.gz admin@192.168.31.180:/vol1/docker/fabula/

# 3. 到 NAS 上解压
ssh admin@192.168.31.180 "cd /vol1/docker/fabula && tar xzf fabula.tar.gz && mkdir -p data"
```

> 首次部署时把 `data/` 目录整体拷贝过去即可带书稿。`prompts.defaults.json` / `sources.json` / `sensitive_words.txt` 是**代码资产**，必须随镜像走（.dockerignore 只排除用户数据）。

## 二、NAS 上构建与启动

```bash
cd /vol1/docker/fabula

# 方法 A：docker compose
docker compose up -d --build

# 方法 B：docker run
docker build -t fabula .
docker run -d --name fabula \
  -p 17381:17381 \
  -v /vol1/docker/fabula/data:/app/data \
  -v fabula_runtime:/app/runtime \
  --restart unless-stopped \
  fabula
```

## 三、访问

- 容器内服务监听 `0.0.0.0:17381`（`BIND=0.0.0.0` 是 Docker 必需，本机开发仍默认 `127.0.0.1`）
- 局域网访问：`http://<NAS-IP>:17381/`（如 `http://192.168.31.180:17381/`）
- fnOS 若开启防火墙/端口转发，按需放行 17381
- 不要把 17381 直接暴露到公网；这是本地写作应用，没有多用户登录/权限系统，只适合可信局域网。

## 四、注意事项

1. **Node 版本**：后端用了 `node:sqlite`（Node 22 内置），镜像使用 `node:22-alpine`。
2. **数据卷**：书稿、回收站、版本历史与书源仍保存在项目的 `data/` 目录。SQLite 运行库位于 Docker 命名卷 `fabula_runtime`，首次启动会从 `data/writerx.db` 导入，避免 Windows 挂载目录导致 SQLite I/O 错误。备份时同时备份 `data/` 和该命名卷。
3. **模型渠道**：在 UI「设置→渠道管理」填写你的接口地址、模型列表地址、模型 ID 和 API Key；也可以写进 `config.json` 后重启。
   - 示例：
     ```json
     {
       "channels": [
         {
           "id": "ch_nas",
           "label": "NAS sub2api",
           "baseUrl": "http://192.168.31.180:3003/v1",
           "modelsUrl": "http://192.168.31.180:3003/v1",
           "model": "qwen3.8-flash",
           "apiKey": "你的key"
         }
       ],
       "activeChannelId": "ch_nas"
     }
     ```
4. **Sub2api 在容器内访问**：如果模型源也在这个 NAS（如 sub2api 3003），容器内直连内网 IP 即可；若想用容器名互访，把两服务加入同一 compose 网络并改用 `http://sub2api:3003/v1`。
5. **书源抓书**：`search_books` / `fetch_chapter_texts` 走公网 shukuge，需 NAS 能出网；若 NAS 有代理，可在容器环境变量里加 `HTTPS_PROXY`/`HTTP_PROXY`（Node 的 fetch 默认尊重并从 env 读取这两个变量）。
6. **备份**：日常只备份 `data/` 目录（可停机后用 `sqlite3 .backup` 或直接 `cp`，WAL 模式建议先 `PRAGMA wal_checkpoint(TRUNCATE)` 或直接停容器再拷）。

## 五、本地开发与本机运行

- 本机：`node server.js` → `http://127.0.0.1:17381/`（默认仍是 127.0.0.1，不出网、不弹防火墙）
- 局域网共享（可选）：`BIND=0.0.0.0 node server.js`，然后 `http://<本机IP>:17381/`
