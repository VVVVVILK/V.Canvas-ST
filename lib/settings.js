// settings.js — 设置项的读写、校验与持久化。
//
// 持久化位置：酒馆的 extension_settings[MODULE_KEY]，随酒馆设置文件一并保存。
// 读取统一走 settingsGet()：返回运行期快照，界面修改后立即生效。

import { saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';

import { sanitizeArtistName, sanitizeArtistPrompt, ARTIST_LIST_MAX } from './artist.js';

export const MODULE_KEY = 'v_canvas';

// ── 出厂默认值 ──
// model 默认留空字符串：硬约束要求不得硬编码任何模型名，输入框只提供 placeholder。
export function defaultSettings() {
    return {
        // 总开关（默认开启）：装上即可用，不再要求用户先去某个页面把开关打开。
        // 未接入任何出图后端时不会反复报错 —— index.js 会在发起前静默跳过并只提示一次。
        enabled: true,
        base_url: '',                       // NAI 协议服务地址。留空时使用同页面的 V.Adapter 扩展直连（无需端口）
        api_key: 'v-adapter-8888',          // 适配服务的 nai_key 默认值；留空则任意 key 可调
        // V站 共享盐。留空 = 用内置默认值（对齐线上正式站点）；
        // 自部署的 V站 实例若改过 config.json 的 exclusiveSalt，或线上轮换过盐，在这里填同样的值。
        exclusive_salt: '',
        // V站 专属签名开关：
        //   auto（默认）= 仅当密钥是 vcs_ 开头的 V站 专属密钥时才附加 X-V-Sig，其余一律不加。
        //                 对官方 NAI / 第三方中转 / V站 通用密钥而言，与「关闭」完全等价。
        //   off         = 任何密钥都不附加签名头（彻底关闭；此时连 V站 专属密钥也会被 403）。
        //   on          = 任何密钥都附加（自部署 V站 想把通用额度也一起锁住时用）。
        // 三种取值下：请求体、请求流程、其它请求头全部不变，只是多/少一个 X-V-Sig 头。
        sign_mode: 'auto',
        // 上游是什么类型的服务 —— 决定「送自然语言描述」还是「送 Danbooru 标签串」。
        //   auto（默认）= 靠地址猜：127.0.0.1 / localhost / 带 :8888 / 同页面装了适配服务扩展
        //                 → 算适配服务；其余一律按 NAI 算。
        //   adapter      = 适配服务（V.Adapter 等）或聊天画图模型 / OpenAI 兼容生图 —— 吃自然语言。
        //                 **部署在服务器上的适配服务必须选这一档**：它是远程域名，
        //                 与第三方 NAI 网关在地址上无法区分，靠猜一定猜错。
        //   nai          = 官方 NovelAI / NAI 网关 / 第三方中转 —— 按 Danbooru 标签训练，吃标签串。
        // 只在「提示词形态」为 auto 时起作用；形态被手动指定时以形态为准。
        upstream_type: 'auto',
        model: '',                          // 手填字符串，不设默认值
        width: 832,
        height: 1216,
        negative: '',                       // 对应 NAI 的负面提示词
        prompt_format: 'auto',              // 送出内容形态：auto / description / tags / both
        steps: 28,
        scale: 6.0,
        max_per_round: 2,                   // 每轮最多生成张数
        timeout_sec: 300,                   // 单张超时（上游 30~60s/张）
        interval_ms: 0,                     // 相邻两张的间隔，用于规避限流
        parallel: false,                    // 并行出图（默认串行；上游允许并发时可开启）
        exclude_types: 'impersonate',       // 忽略的消息类型（逗号分隔）
        swipe_regenerate: true,             // swipe 换回复时重新配图
        strip_marker: true,                 // 正文中剔除 tag（插图不进上下文）
        inject_prompt: true,                // 动态追加 ILLUST 规则到 system prompt
        inject_position: 'in_chat',         // 规则注入位置：in_chat（贴近回复，遵循度更高）/ in_prompt
        inject_depth: 0,                    // in_chat 时的插入深度（0 = 紧贴回复之前）
        // ── 上下文出图：由独立模型阅读正文产出提示词（不依赖剧情模型配合）──
        ctx_enabled: true,                  // 总开关（默认开启）
        // 无标记时的补图方式：
        //   direct（默认） = 跳过分析模型，把 AI 正文原样送生图上游（文 → 图，真正的文生图）。
        //                    省掉一次模型调用与十几秒等待，也不需要配任何分析模型 —— 装上就能用。
        //                    代价是没有分镜、没有插入位置：一条回复固定一张图、挂在末尾。
        //                    只对「读得懂自然语言」的上游成立（聊天画图模型 / OpenAI 兼容生图）；
        //                    送出形态为标签串时自动跳过，见 lib/analysis.js 的 directAppliesTo。
        //   analyze         = 先由分析模型读正文、写成出图提示词，再送上游（文 → 文 → 图）。
        //                    直连官方 NAI / NAI 网关必须选这一档 —— 那类上游只认标签串，
        //                    喂一整段中文散文等于喂噪料。好处是有分镜、能定点插图、可出多张。
        // 默认取 direct：多数链路（V.Adapter → 聊天画图模型）本来就要送自然语言，
        // 中间再插一个文字模型改写既慢又费钱；analyze 保留给直连官方 NAI 与需要多图的场景。
        ctx_mode: 'direct',
        // 直出模式下，除内置作画指令外额外拼给生图模型的话（可空）。
        // 内置指令只负责「挑一个瞬间、按正文还原人物、不把对话画进画面」这类通用约束，
        // 各人偏好的构图、镜头、色调等自己想固定的要求写在这里。
        // 仅在 ctx_mode = 'direct' 时生效；分析模式下由 ANALYSIS_SYSTEM_PROMPT 承担这件事。
        ctx_direct_guide: '',
        // 直出时插图插在哪：
        //   scene（默认）= 挑有效叙述最长的那一段，插在它下面（画面感来自叙述，不来自对白）。
        //                   零成本，但不如分析模型给的 anchor 准 —— 后者是「画什么」与「插哪」一起定的。
        //   end          = 一律挂在整条回复的末尾（挑不出落点时也会走到这里）。
        ctx_direct_place: 'scene',
        // 分析模型的来源。默认 'main' = 直接用酒馆当前正在用的那个模型，
        // 用户不需要填任何地址与密钥；想另配一个更便宜 / 更快的模型时再切到 'custom'。
        ctx_source: 'main',                 // main = 跟随酒馆主 API（无需配置）/ custom = 下面三项自填
        ctx_url: '',                        // 仅 ctx_source = 'custom' 时使用：OpenAI 兼容 API 地址
        ctx_key: '',                        // 仅 ctx_source = 'custom' 时使用
        ctx_model: '',                      // 仅 ctx_source = 'custom' 时使用（手填，无默认值）
        ctx_style: '',                      // 画风（可空 = 由分析模型按作品自行判定）
        ctx_quality: '',                    // 正面质量提示词（可空）
        ctx_negative: '',                   // 负面提示词（可空）
        jb_llm: '',                         // 破限词·分析模型（选填；拼入上下文出图的分析请求）
        jb_image: '',                       // 破限词·生图上游（选填；拼到出图提示词最前面）
        // ── 标记落点矫正 ──
        // 模型把 [ILLUST: …] 全写在回复末尾时，按段落把标记摊开再配图。
        // 纯文本不变，只改插图插在哪一段下面（见 lib/marker.js 的 redistributeMarkers）。
        marker_redistribute: true,
        // ── 分流通道（第二套出图后端）──
        // 主通道画不了的画面交给这里。判定命中时本次出图改用下列地址与密钥，
        // 未命中时完全走主通道，一个字节都不多发（见 lib/nsfw.js）。
        nsfw_enabled: false,                // 总开关（默认关闭：不填地址就不改变任何行为）
        nsfw_base_url: '',                  // NovelAI 协议服务地址（官方 NAI / 支持该协议的网关）
        nsfw_api_key: '',
        nsfw_model: '',                     // 手填，不设默认值
        nsfw_upstream_type: 'nai',          // 默认按 NAI 算：分流通道一般是官方 NAI 或其中转
        nsfw_prompt_format: 'tags',         // 默认送标签串：NAI 系上游按 Danbooru 标签训练
        nsfw_negative: '',                  // 可空 = 沿用主通道的负面提示词
        nsfw_words: '',                     // 判定词表（逗号分隔）；留空 = 只用内置判定词
        // 分流通道每次出几张（与主通道的 max_per_round 分开，两条通道各管各的）。
        nsfw_max: 2,                        // 默认 2：与「1 日常 + 1 NSFW」混合模式配套
        // 分流通道的内容组合：
        //   daily_nsfw = 日常 + NSFW 各一张（默认；nsfw_max 为 1 时退化为只出 NSFW）
        //   nsfw_only  = 全部都是 NSFW
        nsfw_mix: 'daily_nsfw',
        // 混合模式下「日常那一张」的画面位置（由分析模型据此选段；NSFW 那张永远由分析模型语义判断）：
        //   auto   = 分析模型自己挑一个非成人时刻（默认）
        //   front  = 正文前段
        //   middle = 正文中段
        //   end    = 正文后段
        nsfw_daily_place: 'auto',
        // 分流画面的提示词前缀（可空）。
        // 与主通道的「生图破限词」分开的原因见 index.js：破限词是为受限上游准备的，
        // 分流上游本身不设限，把它拼过去只会污染画面；这里放的是该上游真正需要的东西。
        nsfw_prefix: '',
        // 主通道（qwen）出图失败后的重试策略：
        //   off   = 不自动转分流 —— 主通道失败就失败，绝不碰 NAI 额度（最省；漏判时图出不来）
        //   smart = 仅当「疑似 NSFW」（正文/标记命中判定词，或错误是内容策略拒绝）才转分流重试 ——
        //           日常图 qwen 网络失败不会白烧 NAI 额度（默认）
        //   force = 主通道失败不管什么原因都强制转分流重试 —— 图必定出得来，
        //           但日常图失败也会消耗 NAI 额度
        nsfw_retry: 'smart',
        // ── 画师串（画风配方）──
        // 一串画师名标签（可带权重），拼在画面 tag 之前，用来锁定画风基调。
        // 只在会送标签串的形态下生效（直连官方 NovelAI / NAI 网关）；送自然语言描述时自动跳过，
        // 因为聊天模型不认画师名，拼进去只会污染描述 —— 理由见 lib/artist.js 的文件头。
        // 与 history 同类：这是用户创作的数据而非标量设置，因此不参与 applyPatch，
        // 也不在「恢复默认值」时被清空，只能经 saveArtistPresets 修改。
        artist_presets: [],
        active_artist: '',                  // 当前选中的条目 id；空串 = 不使用（是有意义的存储值）
        ctx_timeout_sec: 90,                // 单次分析超时
        history: [],                        // 生成记录（图片 URL + 提示词，持久化；与当前聊天解耦）
        debug: false,                       // 控制台详细日志
    };
}

// 生成记录的上限（条）。记录只存元数据（URL + 截断后的提示词），不存图片本身，
// 单条约 400 字节；该上限对应约 800 KB，不会让酒馆设置文件明显膨胀。
// 超出后丢弃最旧的条目。
const HISTORY_MAX = 2000;

// 单条记录中提示词的保存长度。完整提示词仍可从聊天消息的 extra.illust.src 读取。
const HISTORY_PROMPT_MAX = 500;

const BOOL_KEYS = ['enabled', 'swipe_regenerate', 'strip_marker', 'inject_prompt', 'debug', 'ctx_enabled', 'parallel', 'marker_redistribute', 'nsfw_enabled'];
const STR_KEYS = ['base_url', 'api_key', 'upstream_type', 'model', 'negative', 'prompt_format', 'exclude_types', 'inject_position', 'ctx_mode', 'ctx_direct_guide', 'ctx_direct_place', 'ctx_source', 'ctx_url', 'ctx_key', 'ctx_model', 'ctx_style', 'ctx_quality', 'ctx_negative', 'jb_llm', 'jb_image', 'active_artist', 'exclusive_salt', 'sign_mode', 'nsfw_base_url', 'nsfw_api_key', 'nsfw_model', 'nsfw_upstream_type', 'nsfw_prompt_format', 'nsfw_negative', 'nsfw_words', 'nsfw_prefix', 'nsfw_mix', 'nsfw_daily_place', 'nsfw_retry'];

// prompt_format 的合法取值（见 marker.js 的 resolvePromptMode）。
const PROMPT_FORMATS = ['auto', 'description', 'tags', 'both'];

// upstream_type 的合法取值（见 marker.js 的 resolvePromptMode）：
//   auto    = 靠地址猜（无法区分「远端适配服务」与「第三方 NAI 网关」）
//   adapter = 适配服务 / 聊天画图模型，吃自然语言
//   nai     = 官方 NAI / 网关 / 第三方中转，吃标签串
const UPSTREAM_TYPES = ['auto', 'adapter', 'nai'];

// ctx_direct_place 的合法取值（见 lib/analysis.js 的 pickProseAnchor）：
//   scene = 挑有效叙述最长的那一段，插在它下面
//   end   = 一律挂在回复末尾
const DIRECT_PLACES = ['scene', 'end'];

// nsfw_mix 的合法取值（见 index.js 的直出命中分流分支）：
//   daily_nsfw = 日常 + NSFW 各一张（nsfw_max=1 时退化为只出 NSFW）
//   nsfw_only  = 全部都是 NSFW
const NSFW_MIXES = ['daily_nsfw', 'nsfw_only'];

// nsfw_daily_place 的合法取值（见 lib/analysis.js 的 buildAnalysisParts）：
//   auto   = 分析模型自己挑非成人时刻
//   front  = 正文前段
//   middle = 正文中段
//   end    = 正文后段
const NSFW_DAILY_PLACES = ['auto', 'front', 'middle', 'end'];

// nsfw_retry 的合法取值（见 index.js 的 drawMarkers 兜底重试）：
//   off   = 不自动转分流（主通道失败就失败，不碰 NAI 额度）
//   smart = 仅疑似 NSFW（命中判定词 / 内容策略拒绝）才转分流重试（省额度）
//   force = 主通道失败不管什么原因都强制转分流重试（图必定出，但可能多烧额度）
const NSFW_RETRIES = ['off', 'smart', 'force'];

// ctx_mode 的合法取值（见 lib/analysis.js 的 directAppliesTo 与 index.js 的 runDirectPass）：
//   analyze = 分析模型把正文翻成出图提示词（直连官方 NAI 必须走这档）
//   direct  = 正文原样送生图上游，跳过分析模型
const CTX_MODES = ['analyze', 'direct'];

// ctx_source 的合法取值（见 index.js 的 pickAnalyzer）：
//   main   = 跟随酒馆主 API（默认，用户零配置）
//   custom = 用 ctx_url / ctx_key / ctx_model 指定的独立服务
const CTX_SOURCES = ['main', 'custom'];

// inject_position 的合法取值（见 index.js 的 syncPromptInjection）。
const INJECT_POSITIONS = ['in_chat', 'in_prompt'];

// sign_mode 的合法取值（见 lib/vsig.js 的 sigHeaders）：
//   auto（默认） = 仅 vcs_ 开头的 V站 专属密钥附加 X-V-Sig，其余一律不加
//   off          = 任何密钥都不附加（完全关闭）
//   on           = 任何密钥都附加（自部署 V站 想把通用额度也锁住时用）
const SIGN_MODES = ['off', 'auto', 'on'];

function clampInt(v, lo, hi, fallback) {
    const n = parseInt(v, 10);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

function clampFloat(v, lo, hi, fallback) {
    const n = parseFloat(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
}

// normalizeArtistPresets 把任意来源的画师串库压成一份合法列表。
//
// 口径：字段一律压成标量、去空白、限长；无 id 或 id 重复的条目丢弃（id 是唯一关联键，
// 重复会让「当前选中」指向两个条目）；名字与内容都为空的条目也丢弃（存下来没有意义）。
// 与 history 的处理同源，都是「避免把任意对象写进设置文件」。
function normalizeArtistPresets(raw) {
    const arr = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    return arr
        .filter(x => x && typeof x === 'object')
        .slice(-ARTIST_LIST_MAX)
        .map(x => ({
            id: String(x.id ?? '').trim().slice(0, 64),
            name: sanitizeArtistName(x.name),
            prompt: sanitizeArtistPrompt(x.prompt),
        }))
        .filter(x => {
            if (!x.id || seen.has(x.id)) return false;
            if (!x.name && !x.prompt) return false;
            seen.add(x.id);
            return true;
        });
}

// normalize 把任意来源的对象压成一份合法设置（缺字段用默认值补）。
export function normalize(raw) {
    const d = defaultSettings();
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};

    for (const k of BOOL_KEYS) out[k] = src[k] === undefined ? d[k] : !!src[k];
    for (const k of STR_KEYS) out[k] = src[k] === undefined ? d[k] : String(src[k]);

    out.base_url = out.base_url.trim().replace(/\/+$/, '');
    out.api_key = out.api_key.trim();
    out.upstream_type = out.upstream_type.trim();
    out.model = out.model.trim();
    out.negative = out.negative.trim();
    out.exclude_types = out.exclude_types.trim();
    out.ctx_mode = out.ctx_mode.trim();
    out.ctx_direct_guide = out.ctx_direct_guide.trim();
    out.ctx_direct_place = out.ctx_direct_place.trim();
    out.ctx_url = out.ctx_url.trim().replace(/\/+$/, '');
    out.ctx_key = out.ctx_key.trim();
    out.ctx_model = out.ctx_model.trim();
    out.ctx_style = out.ctx_style.trim();
    out.ctx_quality = out.ctx_quality.trim();
    out.ctx_negative = out.ctx_negative.trim();
    out.jb_llm = out.jb_llm.trim();
    out.jb_image = out.jb_image.trim();
    out.active_artist = out.active_artist.trim();
    out.exclusive_salt = out.exclusive_salt.trim();
    out.nsfw_base_url = out.nsfw_base_url.trim().replace(/\/+$/, '');
    out.nsfw_api_key = out.nsfw_api_key.trim();
    out.nsfw_model = out.nsfw_model.trim();
    out.nsfw_upstream_type = out.nsfw_upstream_type.trim();
    out.nsfw_prompt_format = out.nsfw_prompt_format.trim();
    out.nsfw_negative = out.nsfw_negative.trim();
    out.nsfw_words = out.nsfw_words.trim();
    out.nsfw_prefix = out.nsfw_prefix.trim();
    out.nsfw_mix = out.nsfw_mix.trim();
    out.nsfw_daily_place = out.nsfw_daily_place.trim();
    out.nsfw_retry = out.nsfw_retry.trim();

    // 枚举值：非法取值一律回落到默认项，避免下游 resolvePromptMode 拿到未定义分支。
    out.prompt_format = PROMPT_FORMATS.includes(out.prompt_format) ? out.prompt_format : d.prompt_format;
    out.upstream_type = UPSTREAM_TYPES.includes(out.upstream_type) ? out.upstream_type : d.upstream_type;
    out.ctx_direct_place = DIRECT_PLACES.includes(out.ctx_direct_place) ? out.ctx_direct_place : d.ctx_direct_place;
    out.sign_mode = SIGN_MODES.includes(out.sign_mode) ? out.sign_mode : d.sign_mode;
    out.inject_position = INJECT_POSITIONS.includes(out.inject_position) ? out.inject_position : d.inject_position;
    out.nsfw_prompt_format = PROMPT_FORMATS.includes(out.nsfw_prompt_format) ? out.nsfw_prompt_format : d.nsfw_prompt_format;
    out.nsfw_upstream_type = UPSTREAM_TYPES.includes(out.nsfw_upstream_type) ? out.nsfw_upstream_type : d.nsfw_upstream_type;
    out.nsfw_mix = NSFW_MIXES.includes(out.nsfw_mix) ? out.nsfw_mix : d.nsfw_mix;
    out.nsfw_daily_place = NSFW_DAILY_PLACES.includes(out.nsfw_daily_place) ? out.nsfw_daily_place : d.nsfw_daily_place;
    out.nsfw_retry = NSFW_RETRIES.includes(out.nsfw_retry) ? out.nsfw_retry : d.nsfw_retry;
    out.ctx_mode = CTX_MODES.includes(out.ctx_mode) ? out.ctx_mode : d.ctx_mode;
    out.ctx_source = CTX_SOURCES.includes(out.ctx_source) ? out.ctx_source : d.ctx_source;

    out.width = clampInt(src.width, 64, 2048, d.width);
    out.height = clampInt(src.height, 64, 2048, d.height);
    out.steps = clampInt(src.steps, 1, 50, d.steps);
    out.scale = clampFloat(src.scale, 0, 30, d.scale);
    out.max_per_round = clampInt(src.max_per_round, 1, 6, d.max_per_round);
    out.nsfw_max = clampInt(src.nsfw_max, 1, 6, d.nsfw_max);
    out.timeout_sec = clampInt(src.timeout_sec, 30, 1800, d.timeout_sec);
    out.interval_ms = clampInt(src.interval_ms, 0, 60000, d.interval_ms);
    out.inject_depth = clampInt(src.inject_depth, 0, 20, d.inject_depth);
    out.ctx_timeout_sec = clampInt(src.ctx_timeout_sec, 10, 600, d.ctx_timeout_sec);

    // 生成记录：只保留结构完整的条目，字段一律压成标量，避免把任意对象写进设置文件。
    const rawHist = Array.isArray(src.history) ? src.history : [];
    out.history = rawHist
        .filter(x => x && typeof x === 'object' && x.url)
        .slice(-HISTORY_MAX)
        .map(x => ({
            t: Number(x.t) || 0,
            url: String(x.url ?? ''),
            prompt: String(x.prompt ?? '').slice(0, HISTORY_PROMPT_MAX),
            name: String(x.name ?? '').slice(0, 120),
            mid: Number(x.mid) || 0,
            idx: Number(x.idx) || 0,
        }));

    // 画师串库：同属持久化数据，校验口径见 normalizeArtistPresets。
    out.artist_presets = normalizeArtistPresets(src.artist_presets);

    return out;
}

let rt = defaultSettings();

// 旧的存储键（v_illust）：仅在首次从旧版本升级时用于迁移设置，不再写入。
const LEGACY_MODULE_KEY = 'v_illust';

// initSettings 启动初始化：默认值 → 酒馆持久化覆盖。
export function initSettings() {
    // 首次以新键启动时，若存在旧键数据则迁移，避免保存过的设置丢失。
    if (extension_settings[MODULE_KEY] === undefined && extension_settings[LEGACY_MODULE_KEY] !== undefined) {
        extension_settings[MODULE_KEY] = extension_settings[LEGACY_MODULE_KEY];
        delete extension_settings[LEGACY_MODULE_KEY];
    }
    rt = normalize(extension_settings[MODULE_KEY]);
    persist();
    return rt;
}

function persist() {
    extension_settings[MODULE_KEY] = JSON.parse(JSON.stringify(rt));
    saveSettingsDebounced();
}

// settingsGet 热生效读取点统一走这里。
export function settingsGet() {
    return rt;
}

function parseTypes(s) {
    return String(s ?? '')
        .split(/[,，\s]+/)
        .map(v => v.trim().toLowerCase())
        .filter(Boolean);
}

// isTypeExcluded 该消息类型是否被用户排除。
export function isTypeExcluded(type) {
    if (!type) return false;
    return parseTypes(rt.exclude_types).includes(String(type).toLowerCase());
}

/**
 * applyPatch 应用面板提交的键值：校验后热生效并落盘。
 * @param {object} patch
 * @returns {string[]} notes 需要提示用户的问题（例如型号为空、地址非法）
 */
export function applyPatch(patch) {
    const notes = [];
    const merged = { ...rt };
    for (const k of Object.keys(defaultSettings())) {
        // 这两项是用户数据而非设置，不参与设置写入，也不参与「恢复默认值」——
        // 生成记录由 clearHistory 清空，画师串库由 saveArtistPresets 改写。
        // 否则一次误点「恢复默认值」就会毁掉用户存的画风配方。
        if (k === 'history' || k === 'artist_presets') continue;
        if (patch[k] !== undefined) merged[k] = patch[k];
    }
    const next = normalize(merged);

    // 提示只在「本次确实改到了相关字段」时给出，避免每改一个无关设置都重复同一句提醒。
    const touched = (...keys) => keys.some(k => patch[k] !== undefined);

    if (touched('base_url')) {
        if (next.base_url !== '' && !/^https?:\/\//i.test(next.base_url)) {
            notes.push('NAI 服务地址应以 http:// 或 https:// 开头，请检查');
        }
        if (next.base_url === '') {
            notes.push('NAI 服务地址为空：将直连同页面的 V.Adapter 扩展；未安装该扩展时请在此填写服务地址');
        }
    }

    // 开了分流却没填地址：命中判定的画面会走到一个空地址上，必然失败。
    if (touched('nsfw_enabled', 'nsfw_base_url', 'nsfw_api_key')
        && next.nsfw_enabled && !next.nsfw_base_url) {
        notes.push('分流通道已开启但未填写服务地址：命中判定的画面会出图失败，请补充地址或关闭该开关');
    }

    // 切到自定义分析模型却没填全时当场提示，不必等到下一轮生成才发现。
    // 仅在 analyze 档下提示：正文直出不用分析模型，填不填都不影响。
    if (touched('ctx_source', 'ctx_url', 'ctx_model', 'ctx_mode')
        && next.ctx_mode === 'analyze'
        && next.ctx_source === 'custom' && (!next.ctx_url || !next.ctx_model)) {
        notes.push('已选择自定义分析模型，请填写 API 地址与模型名，否则该路线不会发起请求');
    }

    rt = next;
    persist();
    return notes;
}

/**
 * recordHistory 追加一条生成记录并落盘。
 *
 * 记录与当前聊天解耦：切聊天、换角色、重开酒馆后仍可查阅。
 * 超过上限时丢弃最旧的条目。
 *
 * @param {{url:string, prompt?:string, name?:string, mid?:number, idx?:number}} entry
 * @returns {number} 当前记录条数
 */
export function recordHistory(entry) {
    const url = String(entry?.url ?? '').trim();
    if (!url) return rt.history?.length ?? 0;
    const list = Array.isArray(rt.history) ? rt.history.slice() : [];
    list.push({
        t: Date.now(),
        url,
        prompt: String(entry?.prompt ?? '').slice(0, HISTORY_PROMPT_MAX),
        name: String(entry?.name ?? '').slice(0, 120),
        mid: Number(entry?.mid) || 0,
        idx: Number(entry?.idx) || 0,
    });
    if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX);
    rt.history = list;
    persist();
    return list.length;
}

/** clearHistory 清空生成记录（已落盘的图片文件不受影响）。 */
export function clearHistory() {
    rt.history = [];
    persist();
    return 0;
}

/**
 * saveArtistPresets 整体替换画师串库（面板提交的是完整列表）。
 *
 * 走这个入口而不是 applyPatch 的原因见 defaultSettings 里的注释：它是用户数据，
 * 必须与「恢复默认值」隔离。可选地一并落盘 active_artist，
 * 因为「删掉正在用的那一条」必须同时把它置空，否则会留下悬空 id。
 *
 * @param {Array<{id:string,name:string,prompt:string}>} list
 * @param {{activeArtist?:string}} [opt]
 * @returns {{list:Array, activeArtist:string}}
 */
export function saveArtistPresets(list, opt = {}) {
    rt.artist_presets = normalizeArtistPresets(list);
    if (opt.activeArtist !== undefined) {
        rt.active_artist = String(opt.activeArtist ?? '').trim();
    }
    persist();
    return { list: rt.artist_presets, activeArtist: rt.active_artist };
}

// resolveApiBase 供出图模块用的地址串（去掉尾部斜杠）。
export function apiBase() {
    return rt.base_url;
}
