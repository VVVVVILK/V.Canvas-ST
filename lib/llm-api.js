// llm-api.js — OpenAI 兼容聊天接口调用，用于「上下文出图」。
//
// 与 lib/nai-api.js 的分工：
//   nai-api.js  → 出图（NovelAI 协议）
//   llm-api.js  → 读上下文、产出出图提示词（OpenAI 兼容聊天接口）
//
// 这里可以填任意 OpenAI 兼容服务（官方 / 中转 / 本地反代），与出图上游相互独立：
// 出图走 V.Adapter 或 NAI 网关，分析走这个模型，互不影响。

import { buildAnalysisMessages, parseAnalysisJSON, analysisTokenBudget } from './analysis.js';

function truncate(s, n) {
    const t = String(s ?? '');
    return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * analyzeContext 让配置的模型阅读正文与前文，产出出图提示词。
 *
 * @param {object} p
 * @param {string} p.baseUrl OpenAI 兼容 base url（通常以 /v1 结尾）
 * @param {string} p.apiKey
 * @param {string} p.model   模型名
 * @param {string} p.reply   待配图的正文
 * @param {string} p.context 前文（可为空）
 * @param {string} p.work    作品信息（角色卡名等，供判定作品与画风；可空）
 * @param {string} p.style   用户填写的画风（可空 = 由模型判定）
 * @param {string} p.quality 用户填写的正面质量提示词（可空）
 * @param {string} p.negative 用户填写的负面提示词（可空）
 * @param {string} p.jb      用户自填的破限词（可空，原样拼入请求）
 * @param {number} p.max     最多画面数
 * @param {number} p.timeoutMs
 * @param {AbortSignal} [p.signal] 外部取消信号，与内部超时叠加
 * @returns {Promise<Array<{desc:string,tags:string,anchor:string}>>}
 */
export async function analyzeContext(p = {}) {
    const {
        baseUrl, apiKey, model, reply, context = '', work = '', style = '', quality = '', negative = '',
        jb = '', nsfw = false, max = 1, timeoutMs = 90000, signal,
    } = p;
    const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('未配置分析模型的 API 地址');
    const name = String(model ?? '').trim();
    if (!name) throw new Error('未配置分析模型名');
    const text = String(reply ?? '').trim();
    if (!text) return [];

    // 单次请求即一个完整窗口：system + 一条 user，不携带历史轮次。
    // 输出预算按画面数放大，口径与主 API 路径共用 analysisTokenBudget。
    const budget = analysisTokenBudget(max);
    const messages = buildAnalysisMessages(text, context, max, { work, style, quality, negative, jb, nsfw });

    // ── 瞬时错误重试 ──
    // 反代 / 网关的内容安全检查（data_inspection_failed）与 5xx 是**偶发**的：
    // 同一份请求体重发一次往往就过（实测）。分析一次要 10~30 秒，因为偶发拦截
    // 就让整轮报废太亏 —— 所以这里对「可重试」的失败自动再试，最多 3 次。
    // 可重试：HTTP 5xx / 429 / 内容安全检查 / 限流 / 响应不是合法 JSON / 空内容。
    // 不重试：401/403（密钥）、404（模型名错）、参数类 400、以及使用者的「已终止」。
    const RETRYABLE = /data_inspection_failed|rate.?limit|too many requests|HTTP 5\d\d| upstream /i;

    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
        if (signal?.aborted) throw new Error('已终止');
        try {
            return await analyzeOnce({ base, apiKey, model: name, text, context, max, budget, messages, timeoutMs, signal });
        } catch (err) {
            lastErr = err;
            const m = String(err?.message ?? err);
            if (m === '已终止') throw err;
            if (attempt >= 3) break;
            if (!RETRYABLE.test(m) && !/HTTP 5\d\d|解析不出画面 JSON|返回了空内容|缺少 choices/.test(m)) break;
            await new Promise(r => setTimeout(r, 1200 * attempt));
        }
    }
    throw lastErr;
}

// analyzeOnce 发起一次分析请求（含超时与外部取消），成功即返回画面数组。
async function analyzeOnce({ base, apiKey, model, text, context, max, budget, messages, timeoutMs, signal }) {
    const body = {
        model,
        messages,
        temperature: 0.3,
        max_tokens: budget,
    };

    const ctrl = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, Math.max(5000, timeoutMs));
    if (signal) {
        if (signal.aborted) {
            cancelled = true;
            ctrl.abort();
        } else {
            signal.addEventListener('abort', () => { cancelled = true; ctrl.abort(); }, { once: true });
        }
    }

    let resp;
    try {
        resp = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${String(apiKey ?? '')}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify(body),
            signal: ctrl.signal,
        });
    } catch (err) {
        clearTimeout(timer);
        if (cancelled) throw new Error('已终止');
        if (timedOut) throw new Error(`分析模型请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
        throw new Error(`连不上分析模型（${base}）：${err?.message ?? err}。请确认地址正确、服务已启动且允许跨域（CORS）`);
    }

    let raw = '';
    try {
        raw = await resp.text();
    } catch (err) {
        clearTimeout(timer);
        throw new Error(`读取分析模型响应失败：${err?.message ?? err}`);
    }
    clearTimeout(timer);

    if (!resp.ok) {
        let msg = '';
        let code = '';
        try {
            const j = JSON.parse(raw);
            msg = j?.error?.message ?? j?.message ?? j?.error ?? '';
            code = String(j?.error?.code ?? j?.code ?? '');
            if (typeof msg !== 'string') msg = JSON.stringify(msg);
        } catch { /* 不是 JSON */ }
        if (!msg) msg = `${truncate(raw.replace(/\s+/g, ' '), 200)}（HTTP ${resp.status}）`;
        // 网关的错误码（如 data_inspection_failed / rate limit）一并带出，供重试判定
        throw new Error(code ? `${msg}（${code}，HTTP ${resp.status}）` : msg);
    }

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        throw new Error(`分析模型返回的不是 JSON：${truncate(raw.replace(/\s+/g, ' '), 200)}`);
    }

    const choice = parsed?.choices?.[0];
    if (!choice) throw new Error('分析模型响应缺少 choices');
    // 推理模型可能把正文放在 reasoning_content 里；两处都取，优先 content
    const content = String(choice.message?.content ?? '').trim() || String(choice.message?.reasoning_content ?? '').trim();
    if (!content) throw new Error('分析模型返回了空内容');

    return parseAnalysisJSON(content);
}

/**
 * testAnalyzeModel 试连：发一条极短请求，确认地址与密钥可用。
 * @returns {Promise<string>} 可读的成功描述
 */
export async function testAnalyzeModel({ baseUrl, apiKey, model, timeoutMs = 20000 } = {}) {
    const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('请先填写分析模型的 API 地址');
    const name = String(model ?? '').trim();
    if (!name) throw new Error('请先填写分析模型名');

    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, Math.max(3000, timeoutMs));
    let resp;
    try {
        resp = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${String(apiKey ?? '')}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            body: JSON.stringify({
                model: name,
                messages: [{ role: 'user', content: '只回复两个字：可用' }],
                max_tokens: 16,
            }),
            signal: ctrl.signal,
        });
    } catch (err) {
        clearTimeout(timer);
        if (timedOut) throw new Error('连接超时：分析模型没有响应');
        throw new Error(`连不上 ${base}：${err?.message ?? err}`);
    }
    const raw = await resp.text();
    clearTimeout(timer);
    if (!resp.ok) {
        let msg = '';
        try {
            const j = JSON.parse(raw);
            msg = j?.error?.message ?? j?.message ?? '';
            if (typeof msg !== 'string') msg = JSON.stringify(msg);
        } catch { /* ignore */ }
        throw new Error(msg || `HTTP ${resp.status}`);
    }
    let reply = '';
    try {
        reply = String(JSON.parse(raw)?.choices?.[0]?.message?.content ?? '').trim();
    } catch { /* ignore */ }
    return `连接正常${reply ? `（模型回复：${truncate(reply, 20)}）` : ''}`;
}
