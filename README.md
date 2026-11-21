# dsh-watch — 让 DSH 看一段视频，说出发生了什么

手里有一段录屏、课程录像或短视频，想知道它讲了什么、画面上有什么字、哪几秒是关键。`watch` 会把视频抽成若干帧交给视觉模型，返回**梗概、时间线、高光、屏幕文字**，还可以顺带听一遍声音。

它**只读**：不生成、不剪辑、不导出任何视频。想要「做一个视频」请用 [dsh-studio](https://github.com/lingbaojun233/dsh-studio)。

> 这个仓库只是**客户端**。真正分析的是 video 服务（默认 `127.0.0.1:8769`），它在 [DSH-MultiTool](https://github.com/lingbaojun233/DSH-MultiTool) 的 `video/` 里，需要模型 key、ffmpeg，走链接时还需要 yt-dlp。

## 快速开始

### 1. 安装

```powershell
# 进入你的 DSH profile 目录（默认在 C:\Users\你\.dsh\profiles\desktop）
cd "$env:USERPROFILE\.dsh\profiles\desktop"   # 把 desktop 换成你的 profile 名

npm install https://github.com/lingbaojun233/dsh-watch/archive/refs/heads/main.tar.gz
```

约 2 秒装完，没有构建步骤、没有 npm 依赖。

### 2. 启用

`dependencies` 由 npm 自动写好，你只要把包名加进 `dsh.profile.bundles` 末尾：

```json
{
  "dependencies": {
    "dsh-watch": "https://github.com/lingbaojun233/dsh-watch/archive/refs/heads/main.tar.gz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "dsh-watch"
      ]
    }
  }
}
```

> 保留原有的其它 bundle 条目，只在最后追加。改完重启 DSH；headless 每次运行自动重新装配。

### 3. 验证

先确认服务就绪（`hasKey` / `ffmpeg` 必须是 `true`）：

```powershell
curl.exe -s http://127.0.0.1:8769/v1/health
# {"ok":true,"model":"qwen3.8-flash","hasKey":true,"ffmpeg":true,"ytdlp":true}
```

把一段 mp4 放到**运行 video 服务的那台机器**上（或用一个公开视频链接）。新开一个会话，对 DSH 说：

> 帮我看看 `D:\clips\demo.mp4` 里发生了什么。

成功时返回类似：

```text
梗概：一段终端录屏，最后 npm 报错。

时间线：
- 0:01 打开终端并输入 npm test
- 0:05 出现 E404

画面上的字：npm ERR! code E404

值得注意：
- npm ERR! code E404

声音：全长约 11 秒，基本安静；听得到键盘声
```

## 它提供哪些工具

| 工具 | 干什么 | 例子 |
|---|---|---|
| `watch` | 看一段**已有视频**：梗概、时间线、高光、屏幕文字、可选的声音描述 | 对 DSH 说「看看这个视频在讲什么：https://…」 |

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `filePath` | 二选一 | 视频路径，**在 video 服务所在的那台机器上**；和 `url` 都给时优先它 |
| `url` | 二选一 | 公开 http(s) 链接；服务端先用 yt-dlp 下载 |
| `frames` | 否 | 抽几帧，默认 6，范围 2~20。**越多越慢越贵**（所有帧放进同一次视觉请求，图越多 token 越多） |
| `withAudio` | 否 | 默认 `true`；`false` 时返回结果里不展示声音描述（见「已知限制」） |

`filePath` 和 `url` 都不给 → 直接返回 `MISSING_VIDEO_SOURCE`，不会发空请求；只给 `url` 且它不是 http(s) → `BAD_URL`。

## 依赖

| 依赖 | 说明 |
|---|---|
| video 服务 | 默认 `http://127.0.0.1:8769`，`GET /v1/health` 返回 `ok:true` |
| 模型 API key | 服务端 `video/secrets.json` 的 `apiKey`（当前配置用 `qwen3.8-flash`，失败回退 `qwen4-max`）；`hasKey:false` 时分析一定失败 |
| ffmpeg | 抽帧；路径在 `video/config.json` 的 `ffmpeg` |
| yt-dlp | 只有走 `url` 才需要；路径在 `ytdlp` |
| listen 服务 | 默认去 `http://127.0.0.1:8771/v1/hear` 听音轨；没起时画面分析照常，只是没有声音描述 |
| Node.js | ≥ 18（DSH 自带） |

服务从 DSH-MultiTool 里起：

```powershell
cd C:\Apps\DSH-MultiTool\video
node server.js
# 或双击 start-server.cmd
```

> 服务端 `config.json` 里的 ffmpeg / yt-dlp 路径默认按 `C:\Apps\DSH-MultiTool\` 布局写死；装在别处就改成你自己的路径。模型 key 在 `video/secrets.json`。

端口和环境变量：

| 项 | 默认 | 说明 |
|---|---|---|
| 端口 | `8769` | 只监听 `127.0.0.1` |
| `DSH_VIDEO_URL` | — | 服务地址兜底 |

## 配置

插件没有 `config.json`，配置是**插件行的 `config` 字段**：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8769` | video 服务根地址；结尾斜杠会被自动去掉 |

解析优先级：`config.baseUrl` → `DSH_VIDEO_URL` → 内置默认值。

服务不在本机时：

```powershell
$env:DSH_VIDEO_URL = "http://192.168.1.20:8769"
```

或写进 profile 的 `cordis.patch.yml`（`config` 整体替换，字段要写全）：

```yaml
- id: dsh-watch
  config:
    baseUrl: 'http://192.168.1.20:8769'
```

## 常见问题

### 1. 返回 `UNREACHABLE`

服务没起或地址不对：

```powershell
curl.exe -s http://127.0.0.1:8769/v1/health
```

有 JSON 就说明服务活着，问题在 `baseUrl`；连不上就先起 `video/server.js`。

### 2. 返回 `NO_API_KEY`

服务端没配模型 key（`video/secrets.json` 的 `apiKey`）。这不是插件能修的，配好再重试。`/v1/health` 的 `hasKey` 会直接告诉你有没有。

### 3. 返回 `FILE_NOT_FOUND` / `YTDLP_MISSING` / `YTDLP_FAILED`

- `FILE_NOT_FOUND`：`filePath` 在**运行 video 服务的那台机器**上不存在。
- `YTDLP_MISSING`：服务端没装 yt-dlp 或路径不对，走 `url` 必失败。
- `YTDLP_FAILED`：链接需要登录/会员、地区限制，或平台改版。能下载就下到本地，改用 `filePath`。

### 4. 返回 `TIMEOUT`

单次调用最长 600 秒。先**降低 `frames`**（例如 6 → 3），或换短一点的片段。

注意：`withAudio:false` **不会**让它更快。当前上游总是会听一遍音轨，这个参数只影响返回结果里展不展示声音描述。要彻底不听，得去服务端关掉 `hearAudio`。

### 5. 能看一张图片吗？

**不能。** `watch` 是视频分析：服务要先用 ffmpeg 读出视频时长才能均匀抽帧，单张图片没有时长，会返回 `DURATION_UNKNOWN`。图片理解走 video 服务的 `POST /v1/look`（直接收图片 data URL），但那不是这个工具的入口。

### 6. 我传了 20 帧，实际只用了 16 帧

服务端 `maxFrames` 默认 16，超出的会被静默截掉。**20 是插件的上限，不是服务的上限**；想真用 20 帧，得同时把服务端 `maxFrames` 调到 ≥20。帧数越多越慢越贵，16 以上收益已经很小。

### 7. 关键画面没被抽到

抽帧是**均匀取样**，不是场景检测。跳剪很快的视频，关键瞬间可能正好落在两帧之间。加 `frames`，或自己截出关键帧再走服务端的 `/v1/analyze`。

## 实现说明

- 单文件 `index.js`（约 350 行），零依赖，只用 `fetch`。
- 有 `filePath` → `POST {baseUrl}/v1/analyze-file`；有 `url` → `POST {baseUrl}/v1/analyze-url`。两个路由返回同一种结构，插件统一成 `{ ok, synopsis, timeline[], highlights[], onScreen, audioSummary? }`。
- 上游的 `audio` 是个对象（`summary`/`transcript`/`events`），插件把它拼成一句话放到 `audioSummary`；`withAudio:false` 时这个键不出现。
- 失败不抛异常，返回 `{ ok:false, code, message, hint }`。上游的短码（`FILE_NOT_FOUND`、`YTDLP_FAILED`…）会配上「下一步该干什么」的 `hint`。
- 服务端：下载 → 抽帧（一次 ffmpeg `fps` 滤镜出全部帧）→ 逐帧过视觉模型 → 并行听音轨。模型、ffmpeg、yt-dlp 都在服务端，插件只发 HTTP。
- 只读：不写任何插件状态，也不产生视频文件；缓存和临时目录都在服务端。

## License

MIT © 2026 lingbaojun233
