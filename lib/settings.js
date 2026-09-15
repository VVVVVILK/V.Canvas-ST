// settings.js — 设置项的读写、校验与持久化。
//
// 持久化位置：酒馆的 extension_settings[MODULE_KEY]，随酒馆设置文件一并保存。
// 读取统一走 settingsGet()：返回运行期快照，界面修改后立即生效。

import { saveSettingsDebounced } from '/script.js';
import { extension_settings } from '/scripts/extensions.js';

export const MODULE_KEY = 'v_canvas';

// ── 出厂默认值 ──
// model 默认留空字符串：硬约束要求不得硬编码任何模型名，输入框只提供 placeholder。
export function defaultSettings() {
    return {
        enabled: false,                     // 总开关（默认关闭，避免未配置即自动发起请求）
        base_url: '',                       // NAI 协议服务地址。留空时使用同页面的 V.Adapter 扩展直连（无需端口）
        api_key: 'v-adapter-8888',          // 适配服务的 nai_key 默认值；留空则任意 key 可调
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
        ctx_enabled: false,                 // 总开关（默认关闭，避免未配置即发起请求）
        ctx_url: '',                        // OpenAI 兼容 API 地址
        ctx_key: '',                        // 该服务的 Key
        ctx_model: '',                      // 模型名（手填，无默认值）
        ctx_style: '',                      // 画风（可空 = 由分析模型按作品自行判定）
        ctx_quality: '',                    // 正面质量提示词（可空）
        ctx_negative: '',                   // 负面提示词（可空）
        jb_llm: '',                         // 破限词·分析模型（选填；拼入上下文出图的分析请求）
        jb_image: '',                       // 破限词·生图上游（选填；拼到出图提示词最前面）
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

const BOOL_KEYS = ['enabled', 'swipe_regenerate', 'strip_marker', 'inject_prompt', 'debug', 'ctx_enabled', 'parallel'];
const STR_KEYS = ['base_url', 'api_key', 'model', 'negative', 'prompt_format', 'exclude_types', 'inject_position', 'ctx_url', 'ctx_key', 'ctx_model', 'ctx_style', 'ctx_quality', 'ctx_negative', 'jb_llm', 'jb_image'];

// prompt_format 的合法取值（见 marker.js 的 resolvePromptMode）。
const PROMPT_FORMATS = ['auto', 'description', 'tags', 'both'];

// inject_position 的合法取值（见 index.js 的 syncPromptInjection）。
const INJECT_POSITIONS = ['in_chat', 'in_prompt'];

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

// normalize 把任意来源的对象压成一份合法设置（缺字段用默认值补）。
export function normalize(raw) {
    const d = defaultSettings();
    const src = raw && typeof raw === 'object' ? raw : {};
    const out = {};

    for (const k of BOOL_KEYS) out[k] = src[k] === undefined ? d[k] : !!src[k];
    for (const k of STR_KEYS) out[k] = src[k] === undefined ? d[k] : String(src[k]);

    out.base_url = out.base_url.trim().replace(/\/+$/, '');
    out.api_key = out.api_key.trim();
    out.model = out.model.trim();
    out.negative = out.negative.trim();
    out.exclude_types = out.exclude_types.trim();
    out.ctx_url = out.ctx_url.trim().replace(/\/+$/, '');
    out.ctx_key = out.ctx_key.trim();
    out.ctx_model = out.ctx_model.trim();
    out.ctx_style = out.ctx_style.trim();
    out.ctx_quality = out.ctx_quality.trim();
    out.ctx_negative = out.ctx_negative.trim();
    out.jb_llm = out.jb_llm.trim();
    out.jb_image = out.jb_image.trim();

    // 枚举值：非法取值一律回落到默认项，避免下游 resolvePromptMode 拿到未定义分支。
    out.prompt_format = PROMPT_FORMATS.includes(out.prompt_format) ? out.prompt_format : d.prompt_format;
    out.inject_position = INJECT_POSITIONS.includes(out.inject_position) ? out.inject_position : d.inject_position;

    out.width = clampInt(src.width, 64, 2048, d.width);
    out.height = clampInt(src.height, 64, 2048, d.height);
    out.steps = clampInt(src.steps, 1, 50, d.steps);
    out.scale = clampFloat(src.scale, 0, 30, d.scale);
    out.max_per_round = clampInt(src.max_per_round, 1, 6, d.max_per_round);
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
        // 生成记录是数据而非设置，不参与设置写入与恢复默认，只能由 clearHistory 清空
        if (k === 'history') continue;
        if (patch[k] !== undefined) merged[k] = patch[k];
    }
    const next = normalize(merged);

    if (next.base_url !== '' && !/^https?:\/\//i.test(next.base_url)) {
        notes.push('NAI 服务地址应以 http:// 或 https:// 开头，请检查');
    }
    if (next.base_url === '') {
        notes.push('NAI 服务地址为空：将直连同页面的 V.Adapter 扩展；未安装该扩展时请在此填写服务地址');
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

// resolveApiBase 供出图模块用的地址串（去掉尾部斜杠）。
export function apiBase() {
    return rt.base_url;
}
