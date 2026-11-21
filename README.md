# dsh-watch

把**「看视频」的能力**注册成 DSH 原生工具 `watch`：模型拿到一段已有视频，能说出梗概、
逐帧时间线、高光、画面上的字，以及（可选）声音。零运行时依赖，`index.js` 里只用 Node
内置的 `fetch`。

> Native DSH tool for a video service — watch a video: synopsis, timeline, highlights,
> on-screen text, audio. **It never generates video.**

## 它做什么

| 工具 | 一句话 | 后端 |
| --- | --- | --- |
| `watch` | 看一段**已有**视频，返回 `{ ok, synopsis, timeline[], highlights[], onScreen, audioSummary? }`，并摊成可读文本 | 有 `filePath` → `POST {baseUrl}/v1/analyze-file`<br>有 `url` → `POST {baseUrl}/v1/analyze-url` |

**边界写清楚：这个工具不是视频生成器。** 它只读不写——不渲染、不剪辑、不加字幕、
不导出任何文件。想要"生成一段视频"的话，它帮不上忙。

`frames` 决定抽多少帧：默认 **6**，范围 **2~20**。**越多越慢也越贵**——每一帧都是一次
视觉模型调用；再打开声音（`withAudio`，默认开）还要多跑一遍听音轨。

工具执行失败**不抛异常**，而是返回 `{ ok: false, code, message, hint }` 这样的结构化
JSON——模型看到 `hint` 才能自己恢复（换参数、提示你启动服务），而不是拿到一条读不懂的
调用栈。

## 依赖

一个在跑的 **video 服务**，默认 `http://127.0.0.1:8769`。

- 开箱即用：DSH-MultiTool 的 `video` 模块（Windows 下 `video\start-server.cmd`）。
  本文的接口契约就是按它写的。
- 自己实现也行，只要路径、请求体字段、返回 JSON 对齐即可（见下方「API 契约」）。
- 这个模块自己需要 **ffmpeg**（抽帧）；走 `url` 时还需要 **yt-dlp**（下载）；视觉分析
  还需要一个**模型 API key**（`secrets.json` 里的 `apiKey`）。这些都在服务端配，插件不管。
- 插件本身**不抽帧、不调模型、不读主项目任何文件**，只发 HTTP。

### API 契约

两条都是 `POST` + `content-type: application/json`，响应 JSON。失败也返回
**HTTP 200 + `{ ok:false, error }`**（面板只看 body，不看状态码）。

```jsonc
// POST /v1/analyze-file   —— 服务器本地文件，抽帧 + 可选听音轨
{ "filePath": "D:\\clips\\demo.mp4", "frames": 6, "audio": true }

// POST /v1/analyze-url    —— 服务器先用 yt-dlp 下载再分析
{ "url": "https://example.com/clip.mp4", "frames": 6, "audio": true }

// 两者返回同一种结构：
// → { "ok": true, "synopsis": "一段终端录屏…",
//     "timeline": [{ "t": "0:01", "what": "打开终端" }],
//     "highlights": ["npm ERR! 报错"],
//     "onScreen": "npm ERR! code E404",
//     "audio": { "summary": "…", "transcript": "…", "events": [...] },
//     "duration": 11.6, "frames": 6, "ms": 16600 }
```

`filePath` 是**video 服务所在那台机器**上的绝对路径（不是 DSH 进程的当前目录）。

## 安装

插件是标准 DSH bundle：`package.json` 里声明了 `dsh.bundle.patch`，装载时会插入
`cordis.patch.yml` 里那一行。以下三种方式任选其一。

### 方式 A：Plugin Manager（推荐）

```powershell
git clone https://github.com/lingbaojun233/dsh-watch.git
```

在 DSH 的 Plugin Manager 里 **Add plugin** 选中这个目录；或让 agent 调用
`plugin_manager` 的 `install_bundle`，`target` 传该目录的**绝对路径**。

### 方式 B：手工放进 profile 的 `node_modules`

```powershell
# 1) 把仓库放进 profile 的 node_modules（路径换成你自己的 profile）
$dst = "$env:USERPROFILE\.dsh\profiles\default\node_modules\dsh-watch"
robocopy . $dst /MIR

# 2) 在 profile/package.json 的 dsh.profile.bundles 里加上包名
#    "dsh": { "profile": { "bundles": ["dsh-watch"] } }
```

npm 发布之后也可以在 profile 目录里 `npm i dsh-watch`。

### 方式 C：直接写进 `cordis.yml`

profile 的 `cordis.yml` 本质是一个插件条目列表。原文件如果是空的 `[]`，整个换成：

```yaml
- id: dsh-watch
  name: dsh-watch
  config:
    baseUrl: 'http://127.0.0.1:8769'
```

已有条目就追加同样一项（注意 `-` 对齐、缩进用空格）。

> `name` 是**包名**，必须是 DSH 能解析到的模块；用方式 B 时要和 `node_modules` 下的目录名一致。

## 配置

`cordis.patch.yml` 里的 row config：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8769` | video 服务根地址。不要带结尾斜杠（带了也会被去掉） |

| 环境变量 | 作用 |
| --- | --- |
| `DSH_VIDEO_URL` | `baseUrl` 的兜底值；配置里没写时才用它 |

解析优先级：`config.baseUrl` → `DSH_VIDEO_URL` → 内置默认值 `http://127.0.0.1:8769`。

## 工具与参数 schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "filePath": {
      "type": "string",
      "description": "Absolute path to a video file on the machine running the video service. Takes precedence over url. Omit when passing url."
    },
    "url": {
      "type": "string",
      "description": "Public http(s) video link; the service downloads it first (needs yt-dlp). Omit when passing filePath."
    },
    "frames": {
      "type": "integer",
      "minimum": 2,
      "maximum": 20,
      "description": "Stills sampled across the video. Default 6, range 2-20. More frames means more detail but slower and costlier."
    },
    "withAudio": {
      "type": "boolean",
      "description": "Default true. Set false to drop the audio description and skip listening — faster and cheaper."
    }
  }
}
```

- `filePath` 和 `url` **必须给一个**；两个都给时优先 `filePath`（本地文件比下载快也便宜）。
- `filePath`/`url` 都不给 → 直接返回 `MISSING_VIDEO_SOURCE`，不会发空请求。
- `url` 不是 `http(s)` → 直接返回 `BAD_URL`，不会白跑一次下载。
- `frames` 越界（<2 或 >20）会被夹回范围内，不会报错也不会打爆服务。
- 单次调用最长 **600 秒**（视频分析本来就慢：下载 → 抽帧 → 逐帧过视觉模型）。

### `watch` 返回

```json
{
  "ok": true,
  "synopsis": "一段终端录屏，最后报错",
  "timeline": [{ "t": "0:01", "what": "打开终端并输入 npm test" }],
  "highlights": ["npm ERR! code E404"],
  "onScreen": "npm ERR! code E404",
  "audioSummary": "全长约 11 秒，基本安静；听得到键盘声"
}
```

渲染成文本大致是：

```text
梗概：一段终端录屏，最后报错

时间线：
- 0:01 打开终端并输入 npm test

画面上的字：npm ERR! code E404

值得注意：
- npm ERR! code E404

声音：全长约 11 秒，基本安静；听得到键盘声
```

`withAudio: false` 时返回对象里**没有** `audioSummary` 键，文本里也没有"声音："那一段。

## 排错

### 1. `{ "ok": false, "code": "MISSING_VIDEO_SOURCE" }`

`filePath` 和 `url` 都没给。给一个就行。

### 2. `{ "ok": false, "code": "UNREACHABLE" }`

服务没起来、端口不对，或被防火墙拦了。

```powershell
# 用 Node 自带 fetch 探活，省掉 PowerShell 引号转义的坑
node -e "fetch('http://127.0.0.1:8769/v1/health').then(r=>r.text()).then(console.log)"
```

`hasKey:false` 说明服务没配模型 key，分析一定失败；`ffmpeg:false` 说明抽不了帧。

### 3. `{ "ok": false, "code": "FILE_NOT_FOUND" }`

`filePath` 在**运行 video 服务的那台机器**上不存在。远程部署时，路径得是那台机器上的
路径，否则只能用 `url`。

### 4. `{ "ok": false, "code": "NO_API_KEY" }`

服务端没有模型 key（`video\secrets.json` 的 `apiKey`）。这不是插件能修的，
去服务端配好再重试。

### 5. `{ "ok": false, "code": "YTDLP_MISSING" }` / `YTDLP_FAILED`

走 `url` 才需要 yt-dlp。`MISSING` 是服务端没装或路径不对；`FAILED` 常见于需要登录态
（B 站会员、私享视频）、地区限制、平台改版。能下载就下到本地再传 `filePath`。

### 6. `{ "ok": false, "code": "TIMEOUT" }`

超过插件给的 600 秒。先降 `frames`（比如 6 → 3）并关掉 `withAudio` 再试。

### 7. `code: "NO FRAMES"` / `FFMPEG_FAILED`

ffmpeg 解不了这个容器，或者文件根本不是视频（改了扩展名的图片/音频）。换个 mp4 再试。

### 8. 实际只用了 16 帧，我传了 20

上游 `maxFrames` 默认 16，多出来的会被它静默截掉。**20 是本插件的上限，不等于服务端的
上限**；想真用 20 帧，得同时把服务端 `maxFrames` 调到 ≥20。反过来，帧越多越慢越贵，
16 以上收益已经很小。

### 9. 传了 `withAudio: false`，服务端还在听

`audio` 字段是照契约发出去的，但**当前上游并不读它**——听不听由服务端自己的
`hearAudio` 配置决定（默认开）。所以 `withAudio:false` 现在的效果是「返回结果里不展示
音频描述」，并不会真的省掉那部分时间。要彻底不听，去服务端把 `hearAudio` 关掉。
上游将来支持这个字段后，插件不用改。

### 10. 抽帧漏了关键画面

抽帧是**均匀取样**，不是场景检测。跳剪很快的视频，关键瞬间可能正好落在两帧之间。
要么加 `frames`，要么自己截出关键帧再走 `video` 模块的 `/v1/analyze`。

### 11. 工具注册了但模型不用

工具表只在插件行**启用**后才注入。用 Plugin Manager 看该行的 `enabled`；改完
`cordis.yml` 通常需要重载 profile（headless 模式每次调用都会重载）。

## 开发

```powershell
node --check index.js
```

没有测试依赖、没有构建步骤；改完直接重载插件即可。

想在没有真实视频的情况下自测：起一个桩服务，在 `/v1/analyze-file`、`/v1/analyze-url`
上返回固定 JSON，然后 `apply({ tools: { register(fn) { ... } } }, { baseUrl: 'http://127.0.0.1:PORT' })`
手工调 `execute` 即可。

## License

MIT © 2026 lingbaojun233
