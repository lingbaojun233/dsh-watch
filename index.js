/**
 * dsh-watch
 *
 * 把 video 模块（默认 127.0.0.1:8769）注册成一个 DSH 原生工具：watch。
 * 模型可以「看」一段已有视频并说出：梗概、逐帧时间线、高光、画面上的字、以及（可选）声音。
 *
 * 边界写在代码里，也写在工具描述里：**它不是视频生成工具**，只读不写，
 * 不会渲染、剪辑、导出任何文件。
 *
 * 为什么全仓库只有一个 index.js、不 import 任何兄弟项目：
 * 这个仓库要能被陌生人单独 clone 下来当 bundle 装，不能依赖 ../DSH-MultiTool。
 *
 * 为什么手写工具对象、不 import @deepseek-ai/dsh-tools：
 * 普通 profile 里解析不到那个包；ctx.tools.register 收的本来就是 defineTool 编译后的
 * 普通对象（name/description/parameters/output/execute），同形状手写即可。
 *
 * 为什么只用 node 内置 + 全局 fetch：多一个依赖就多一次装不上的机会。
 */

export const name = 'dsh-watch';
export const inject = ['tools'];

const DEFAULT_BASE_URL = 'http://127.0.0.1:8769';

// 视频分析是「下载 → 抽帧 → 每帧过一遍视觉模型（+ 可选听音轨）」，
// 几十秒到几分钟都正常，所以给到 600s。这是上限，不是常态。
const ANALYZE_TIMEOUT_MS = 600000;

const DEFAULT_FRAMES = 6;
const MIN_FRAMES = 2;
const MAX_FRAMES = 20;

const HINT_BY_CODE = {
  MISSING_VIDEO_SOURCE:
    'pass filePath (a file on the machine running the video service) or a public http(s) url',
  BAD_URL: 'url must start with http:// or https://',
  FILE_NOT_FOUND: 'the path does not exist on the machine running the video service',
  FILE_REQUIRED: 'the service refused a request without filePath',
  DOWNLOAD_EMPTY: 'the download finished but produced no video file',
  NO_API_KEY: 'the video service has no model API key configured; vision analysis cannot run without it',
  'NO FRAMES': 'ffmpeg produced no frames; the file may not be a decodable video container',
  YTDLP_MISSING: 'the service has no yt-dlp, so it cannot download links; set its ytdlp path or pass a local file',
  YTDLP_FAILED: 'yt-dlp could not fetch this link (login wall, geo block, or the platform changed); pass a local file',
  FFMPEG_MISSING: 'ffmpeg is not installed where the video service expects it',
  FFMPEG_FAILED: 'ffmpeg could not decode this file; try a common container such as mp4',
  TIMEOUT: 'the analysis exceeded 600s; retry with fewer frames or a shorter clip',
  UNREACHABLE: 'is the video service running? check the port, then set config.baseUrl or DSH_VIDEO_URL',
  BAD_RESPONSE: 'the service returned something that is not JSON (a proxy error page?)',
  SERVICE_ERROR: 'the video service returned a failure without a code; see message',
};

/**
 * 配置优先、环境变量兜底：同一台机器上跑多份 profile、或服务在另一台机器时，
 * 只改 env 就能切后端。末尾斜杠会让 `${base}/v1/...` 变成双斜杠，先削掉。
 */
function baseUrlOf(config) {
  const fromConfig = config && typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
  const fromEnv = (process.env.DSH_VIDEO_URL || '').trim();
  return (fromConfig || fromEnv || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

const textBlock = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
];

/**
 * 帧数是这个工具唯一有效的成本旋钮，而 schema 在校验之外还可能被直接调用绕过，
 * 所以这里再夹一次：小于 2 抽不出时间线，大于 20 既慢又可能超过上游 maxFrames。
 */
function clampFrames(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_FRAMES;
  return Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.round(n)));
}

/**
 * 发一个 JSON POST。**永远不抛异常**：网络错误、超时、非 JSON 响应都变成
 * { ok:false, code, message, hint }，模型看到结构化失败才能自己恢复。
 */
async function postJson(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 反向代理的 HTML 错误页也走这里；别让 JSON.parse 把真实状态码吃掉
      data = { ok: false, error: 'BAD_RESPONSE', message: text.slice(0, 500) };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    // Node 的 fetch 网络错误只有一句 "fetch failed"，真正的原因（ECONNREFUSED 等）在 cause 里
    const cause = err && err.cause ? err.cause.code || err.cause.message : '';
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'UNREACHABLE',
      message: aborted
        ? `no response within ${timeoutMs}ms`
        : `${String((err && err.message) || err)}${cause ? ` (${cause})` : ''}`,
      hint: HINT_BY_CODE[aborted ? 'TIMEOUT' : 'UNREACHABLE'],
    };
  } finally {
    clearTimeout(timer);
  }
}

function failureCode(data) {
  const raw = String((data && (data.error || data.message)) || '');
  return raw.split(':')[0].trim().toUpperCase();
}

/**
 * 上游的 error 是给人看的短码（FILE_NOT_FOUND / YTDLP_FAILED…），
 * 直接丢给模型没意义，配一句「下一步该干什么」它才能自己恢复。
 * HTTP_4xx/5xx 这类没有固定码的，统一给一句「看服务日志」。
 */
function hintFor(code) {
  if (HINT_BY_CODE[code]) return HINT_BY_CODE[code];
  if (/^HTTP_\d{3}$/.test(code)) {
    return 'the video service answered with an error status; check its log for the upstream reason';
  }
  return HINT_BY_CODE.SERVICE_ERROR;
}

function upstreamFailure(data) {
  const code = failureCode(data) || 'SERVICE_ERROR';
  return {
    ok: false,
    code,
    message: String((data && (data.error || data.message)) || code),
    hint: hintFor(code),
  };
}

/**
 * 上游现在返回的是 audio 对象（{summary, transcript, events[], ...}），
 * 契约里叫 audioSummary。字符串直接用，对象就拼成一句话 —— 上层的 schema
 * 只需要一个字段，别让每个调用方自己去猜结构。
 */
function audioText(data) {
  const raw = data.audioSummary ?? data.audio ?? null;
  if (!raw) return '';
  if (typeof raw === 'string') return raw.trim();
  if (typeof raw !== 'object') return '';

  const bits = [];
  if (typeof raw.summary === 'string' && raw.summary.trim()) bits.push(raw.summary.trim());
  if (typeof raw.transcript === 'string' && raw.transcript.trim()) {
    bits.push(`人声：${raw.transcript.trim()}`);
  }
  if (Array.isArray(raw.events)) {
    const descs = raw.events
      .map((e) => (e && typeof e === 'object' ? e.desc || e.kind : String(e || '')))
      .filter(Boolean);
    if (descs.length) bits.push(`声音事件：${descs.join('；')}`);
  }
  return bits.join('；');
}

/**
 * 对齐对外契约：{ ok, synopsis, timeline[], highlights[], onScreen, audioSummary? }。
 * audioSummary 只在 withAudio 为真且上游真给了内容时出现 —— 空字段不如没有。
 */
function normalizeWatch(data, withAudio) {
  const timeline = (Array.isArray(data.timeline) ? data.timeline : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      t: String(item.t ?? item.time ?? ''),
      what: String(item.what ?? item.text ?? ''),
    }))
    .filter((item) => item.t || item.what);

  const highlights = (Array.isArray(data.highlights) ? data.highlights : [])
    .map((h) => String(h ?? '').trim())
    .filter(Boolean);

  const result = {
    ok: true,
    synopsis: typeof data.synopsis === 'string' ? data.synopsis.trim() : '',
    timeline,
    highlights,
    onScreen: typeof data.onScreen === 'string' ? data.onScreen.trim() : '',
  };
  if (withAudio) {
    const sound = audioText(data);
    if (sound) result.audioSummary = sound;
  }
  return result;
}

function renderFailure(tool, value) {
  if (!value) return `${tool} 调用失败：没有拿到任何返回`;
  const lines = [`${tool} 调用失败：${value.code || 'UNKNOWN'}`];
  if (value.message) lines.push(String(value.message));
  if (value.hint) lines.push(`建议：${value.hint}`);
  return lines.join('\n');
}

/** 把结构化结果摊成模型能直接读的几段话，而不是甩一个 JSON 让它自己解析。 */
function renderWatch(value) {
  const lines = [`梗概：${value.synopsis || '（上游没给 synopsis）'}`];

  if (value.timeline.length) {
    lines.push('', '时间线：');
    for (const item of value.timeline) {
      lines.push(`- ${item.t ? `${item.t} ` : ''}${item.what}`);
    }
  }

  if (value.onScreen) lines.push('', `画面上的字：${value.onScreen}`);

  if (value.highlights.length) {
    lines.push('', '值得注意：');
    for (const h of value.highlights) lines.push(`- ${h}`);
  }

  if (value.audioSummary) lines.push('', `声音：${value.audioSummary}`);

  return lines.join('\n');
}

const WATCH_PARAMS = {
  type: 'object',
  additionalProperties: false,
  properties: {
    filePath: {
      type: 'string',
      description:
        'Absolute path to a video file on the machine running the video service. Takes precedence over url. Omit when passing url.',
    },
    url: {
      type: 'string',
      description:
        'Public http(s) video link; the service downloads it first (needs yt-dlp). Omit when passing filePath.',
    },
    frames: {
      type: 'integer',
      minimum: MIN_FRAMES,
      maximum: MAX_FRAMES,
      description:
        `Stills sampled across the video. Default ${DEFAULT_FRAMES}, range ${MIN_FRAMES}-${MAX_FRAMES}. More frames means more detail but slower and costlier.`,
    },
    withAudio: {
      type: 'boolean',
      description:
        'Default true. Set false to drop the audio description and skip listening — faster and cheaper.',
    },
  },
};

export function apply(ctx, config) {
  const baseUrl = baseUrlOf(config);

  // 拿注册返回值当 disposer，HMR 重载插件时才能摘掉旧工具，避免重名注册。
  const disposers = [];
  const register = (tool) => {
    const dispose = ctx.tools.register(tool);
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  register({
    name: 'watch',
    description:
      'Look at an existing video and report what happens in it: synopsis, per-frame timeline, highlights, on-screen text, and optionally what the audio sounds like. This tool only WATCHES a video — it never generates, edits, renders, or writes one. Give filePath (on the machine running the video service) or a public http(s) url. frames sets how many stills are sampled (default 6, 2-20): more frames is more detail but slower and more expensive, and listening to the audio adds more time on top. A single call can take a minute or two and may run up to 600s.',
    parameters: WATCH_PARAMS,
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        textBlock(value && value.ok === false ? renderFailure('watch', value) : renderWatch(value)),
    },
    async execute(args) {
      const input = args || {};
      const filePath = typeof input.filePath === 'string' ? input.filePath.trim() : '';
      const url = typeof input.url === 'string' ? input.url.trim() : '';
      // withAudio 默认开：这个模块的价值一半在画面、一半在「听得到什么」
      const withAudio = input.withAudio !== false;

      if (!filePath && !url) {
        return {
          ok: false,
          code: 'MISSING_VIDEO_SOURCE',
          message: 'watch needs one of filePath or url; neither was given, so nothing was sent.',
          hint: HINT_BY_CODE.MISSING_VIDEO_SOURCE,
        };
      }
      // 本地文件比下载快也便宜，两者都给时优先 filePath（描述里已写明）。
      if (url && !filePath && !/^https?:\/\//i.test(url)) {
        return {
          ok: false,
          code: 'BAD_URL',
          message: `not an http(s) link: ${url}`,
          hint: HINT_BY_CODE.BAD_URL,
        };
      }

      const body = { frames: clampFrames(input.frames), audio: withAudio };
      let route;
      if (filePath) {
        route = '/v1/analyze-file';
        body.filePath = filePath;
      } else {
        route = '/v1/analyze-url';
        body.url = url;
      }

      try {
        const res = await postJson(`${baseUrl}${route}`, body, ANALYZE_TIMEOUT_MS);
        if (!res.ok) return res;
        if (res.data && res.data.ok === false) return upstreamFailure(res.data);
        return normalizeWatch(res.data || {}, withAudio);
      } catch (err) {
        // 兜底：任何没想到的异常都不该变成调用崩溃
        return {
          ok: false,
          code: 'PLUGIN_ERROR',
          message: String((err && err.message) || err),
          hint: 'this is a bug in dsh-watch; retry once, then report it with the message above',
        };
      }
    },
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 卸载阶段单个 disposer 抛错不该拦住其余清理
      }
    }
  };
}
