// st-llm.js — 借酒馆当前正在用的那个模型完成一次分析请求。
//
// 与 llm-api.js 的分工：两者产出的画面列表完全一致，只是走不同的通道。
//   llm-api.js → 直连用户自填的 OpenAI 兼容服务（要地址、要密钥、受浏览器跨域限制）
//   st-llm.js  → 借用酒馆主 API（用户零配置）
//
// 为什么借酒馆而不是自己发请求：
//   酒馆已经把当前 API 的地址、密钥与来源（OpenAI / Claude / Gemini / 本地后端…）
//   都配好了，并提供了「发一次性请求、不写入聊天记录」的官方通道
//   （getContext().generateRaw）。借它同时得到三件事：
//     ① 用户不用把同一份配置再填一遍；
//     ② 密钥只存在酒馆里，不进扩展代码、不出现在浏览器请求头；
//     ③ 请求由酒馆服务端转发，没有跨域问题，本地后端也能直连。
//
// 代价：分析用的就是用户平时聊天那个模型 —— 换主模型会连带影响分析质量，
//       且主模型偏贵 / 偏慢时每轮都要多付一次。想解耦就在设置里切到自定义来源。

import { getContext } from '/scripts/extensions.js';

import { buildAnalysisParts, parseAnalysisJSON, analysisTokenBudget } from './analysis.js';

// 酒馆把「当前来源对应的模型名」存在 chatCompletionSettings 的 `${source}_model` 字段里。
// 各来源的字段名并不统一，因此先按来源名猜一次，再退化为「找任意一个非空的 *_model」。
// 该值只用于面板展示，取不到也不影响任何功能。
function pickModel(settings, api) {
    if (!settings || typeof settings !== 'object') return '';
    const direct = settings[`${api}_model`];
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    for (const [k, v] of Object.entries(settings)) {
        if (!k.endsWith('_model')) continue;
        if (typeof v === 'string' && v.trim()) return v.trim();
    }
    return '';
}

/**
 * describeMainApi 读出院当前主 API 的来源与模型名，供面板显示与试连回报。
 *
 * 不发起任何请求：主 API 能正常聊天就说明它可用，没必要为此多花一次调用。
 *
 * @returns {{api:string, model:string, label:string}}
 */
export function describeMainApi() {
    let api = '';
    let model = '';
    try {
        const ctx = getContext();
        api = String(ctx?.mainApi ?? '').trim();
        model = pickModel(ctx?.chatCompletionSettings, api);
    } catch { /* 酒馆未就绪：按空处理，调用方自行降级 */ }

    const apiLabel = api || '未设置';
    const label = model ? `酒馆主 API · ${apiLabel} · ${model}` : `酒馆主 API · ${apiLabel}`;
    return { api, model, label };
}

// normalizeError 把酒馆抛出的任意形状的失败压成一条可读信息。
// 酒馆在部分链路上是 `throw await response.json()`，抛出来的是对象而非 Error，
// 直接把对象塞进 toastr 会显示成 [object Object]，因此统一在这里收口。
function normalizeError(e) {
    if (e instanceof Error) return e;
    if (e && typeof e === 'object') {
        const msg = e.message ?? e.error?.message ?? e.error ?? e.response;
        if (typeof msg === 'string' && msg.trim()) return new Error(msg.trim());
        try { return new Error(JSON.stringify(e)); } catch { /* 继续兜底 */ }
    }
    return new Error(String(e ?? '未知错误'));
}

/**
 * settle 让「等待主 API 返回」可以被超时与本插件的终止按钮打断。
 *
 * WARN: 底层请求由酒馆发出，本插件拿不到它的 AbortController ——
 *       这里的超时与终止只能做到「不再等待，并把这一轮结果作废」；
 *       请求本身仍会跑完（酒馆自己的停止按钮才能中断它）。
 *       这一点与直连路径不同，面板与文档均按此口径描述，不夸大。
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} timeoutMs
 * @param {AbortSignal} [signal]
 * @returns {Promise<T>}
 */
function settle(promise, timeoutMs, signal) {
    const wait = Math.max(5000, timeoutMs);
    return new Promise((resolve, reject) => {
        let done = false;
        let timer = null;

        function cleanup() {
            if (timer) clearTimeout(timer);
            try { signal?.removeEventListener('abort', onAbort); } catch { /* 忽略 */ }
        }

        function finish(fn, v) {
            if (done) return;
            done = true;
            cleanup();
            fn(v);
        }

        function onAbort() {
            finish(reject, new Error('已终止'));
        }

        timer = setTimeout(
            () => finish(reject, new Error(`分析模型请求超时（${Math.round(wait / 1000)} 秒）`)),
            wait,
        );

        if (signal) {
            if (signal.aborted) return onAbort();
            signal.addEventListener('abort', onAbort, { once: true });
        }

        Promise.resolve(promise).then(v => finish(resolve, v), e => finish(reject, normalizeError(e)));
    });
}

/**
 * analyzeViaMainApi 用酒馆主 API 阅读正文与前文，产出画面列表。
 *
 * 参数与返回值与 llm-api.js 的 analyzeContext 保持一致，可互换调用。
 *
 * 注意两处与直连路径的行为差异，均为借用主 API 的固有结果：
 *   1. 生成参数（温度、惩罚项等）取自主 API 当前的设置，本插件不逐项覆盖，
 *      只把输出预算按画面数抬高，避免 JSON 被截断；
 *   2. 酒馆会对送出的文本做一次宏替换（{{user}}、{{char}} 等），
 *      直连路径不会。这是酒馆既有行为，不额外绕开。
 *
 * @param {object} p
 * @param {string} p.reply   待配图的正文
 * @param {string} [p.context] 前文（可为空）
 * @param {string} [p.work]    作品信息（角色卡名等；可空）
 * @param {string} [p.style]   画风要求（可空）
 * @param {string} [p.quality] 正面质量提示词（可空）
 * @param {string} [p.negative] 负面提示词（可空）
 * @param {string} [p.jb]      使用者自填的破限词（可空）
 * @param {number} [p.max]     最多画面数
 * @param {number} [p.timeoutMs]
 * @param {AbortSignal} [p.signal]
 * @returns {Promise<Array<{desc:string,tags:string,anchor:string}>>}
 */
export async function analyzeViaMainApi({
    reply, context = '', work = '', style = '', quality = '', negative = '', jb = '', nsfw = false, max = 1,
    timeoutMs = 90000, signal,
} = {}) {
    const text = String(reply ?? '').trim();
    if (!text) return [];

    const ctx = getContext();
    const generateRaw = ctx?.generateRaw;
    if (typeof generateRaw !== 'function') {
        throw new Error('当前酒馆版本未提供主 API 直调通道：请在「上下文出图」页改用自定义分析模型，或升级酒馆');
    }

    const { system, user } = buildAnalysisParts(text, context, max, { work, style, quality, negative, jb, nsfw });

    const pending = generateRaw({
        systemPrompt: system,
        prompt: user,
        // 输出预算与直连路径同口径，避免换来源后张数一多就被截断。
        responseLength: analysisTokenBudget(max),
        // 关掉「去掉开头的角色名前缀」这一步：返回值是 JSON，不该被当成人名处理。
        trimNames: false,
    });

    const raw = await settle(pending, timeoutMs, signal);
    return parseAnalysisJSON(raw);
}
