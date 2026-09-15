// index.js — V.Canvas · SillyTavern 前端扩展入口。
//
// 职责：AI 回复中出现 [ILLUST: 画面描述 | Danbooru,Tags] 标记（下称 tag）时，
//       将该 tag 就地替换为一整行插画，插在其所在段落的正下方，形成图文竖排版式。
//
// 出图协议：仅实现 NovelAI 协议（POST /ai/generate-image），指向外部 NAI 协议服务
// （V.Adapter，默认 http://127.0.0.1:8888）。
// 响应处理：图片二进制流直接取用；ZIP 走兼容解包分支。
//
// WARN: SillyTavern 的扩展加载器只挂载 <script type="module">，不会调用扩展导出的 init()，
//       因此本文件末尾必须自行启动。

import { eventSource, event_types, setExtensionPrompt, extension_prompt_types, extension_prompt_roles } from '/script.js';
import { getContext } from '/scripts/extensions.js';
import { saveBase64AsFile } from '/scripts/utils.js';

import {
    initSettings, settingsGet, applyPatch, isTypeExcluded, defaultSettings, recordHistory, clearHistory,
} from './lib/settings.js';
import { findMarkers, hasMarkers, stripMarkers, buildDisplayText, effectiveSource, resolvePromptMode, selectPrompt, isLocalUpstream } from './lib/marker.js';
import { generateIllustration, testConnection } from './lib/nai-api.js';
import { applyMarkers } from './lib/analysis.js';
import { analyzeContext, testAnalyzeModel } from './lib/llm-api.js';
import { showProgress, updateProgress, finishProgress, hideProgress, setCancelHandler } from './lib/progress.js';

export const MODULE_NAME = 'v_canvas';
const VERSION = '0.1.2';

// system prompt 注入用的键名（同一键重复写入会覆盖，不会累积）。
const PROMPT_KEY = 'v_canvas_rule';

// 默认 tag 规则的模板：出图上限按「每轮上限」替换。
//
// 规则文案即模型产出标记的全部依据，因此逐条写明：格式、描述段须覆盖的要素、
// 标签段的形式与排序、单个标记的自足性、多标记的分布要求。
function ruleTemplate(n) {
    return `若情节出现显著的场景切换、角色外观变化或高张力画面，请在对应段落正下方另起一行输出标记：\n`
        + `[ILLUST: 自然语言描述 | Danbooru,Tags]\n`
        + `标记须遵守下列要求：\n`
        + `1. 两段都必须填写，以 | 分隔，不得省略其中任一段。\n`
        + `2. 描述段用自然语言书写，须覆盖角色外貌特征、服装与道具、动作姿态、场景环境、构图与镜头、画风。\n`
        + `3. 标签段用英文 Danbooru Tag，以英文逗号分隔，按「主体、外观、服装、动作、场景、风格」的顺序排列。\n`
        + `4. 单个标记须自足：应包含该画面完整的主角特征与场景信息，不依赖其他标记补全。\n`
        + `5. 一轮输出多个标记时，各标记须针对不同的画面时刻，并分布在正文的不同位置（例如中段与末段），不得集中在一处，也不得重复描述同一画面。\n`
        + `6. 画面构思与剧情正文在同一次生成中一并完成，无需等待额外步骤。\n`
        + `7. 标记写在正文叙事段落的正下方，不要写在状态栏、思考块、表格等结构化区块内部；若正文被包裹在某个标签中（如 <story_scene>），标记写在标签内的对应段落下方。\n`
        + `单次回复最多输出 ${n} 个标记，每个标记对应一张插画，分别插在各自段落正下方。`;
}

// ── 运行期状态 ──

const inFlight = new Set();   // 正在处理中的 messageId（防抖）
const lastPass = new Map();   // messageId → 上次处理的时间戳（防连点风暴）
const PASS_COOLDOWN = 4000;

// ── 当前这轮的取消控制 ──
// 分析请求与出图请求都挂在这个 signal 上，「终止」按钮 abort 它即可中断整轮。
let runAbort = null;

function beginRun() {
    try { runAbort?.abort(); } catch { /* 上一轮已结束 */ }
    runAbort = new AbortController();
    setCancelHandler(() => { try { runAbort?.abort(); } catch { /* 忽略 */ } });
    return runAbort.signal;
}

function endRun() {
    runAbort = null;
    setCancelHandler(null);
}

function isAborted(signal) {
    return !!signal?.aborted;
}

function s() { return settingsGet(); }

// buildUpstreamPrompt 把生图破限词（若填写）拼到出图提示词最前面。
// 空则原样返回。拼接符为「, 」，对 Danbooru 标签串与自然语言均无害。
// 本插件不内置任何破限内容，框中内容由使用者自行填写并自行负责。
function buildUpstreamPrompt(prompt, jbImage) {
    const p = String(prompt ?? '');
    const j = String(jbImage ?? '').trim();
    return j ? `${j}, ${p}` : p;
}

function log(...args) {
    if (s().debug) console.log('[V.Canvas]', ...args);
}

function warn(...args) {
    console.warn('[V.Canvas]', ...args);
}

// ── 初始化 ──

export async function init() {
    initSettings();
    addSettingsUI();
    syncPromptInjection();
    registerEvents();
    installPromptViewer();
    log(`已加载 v${VERSION}`);
}

export async function exit() {
    closePanel();
    closePromptOverlay();
    hideProgress();
    $('#v_canvas_drawer').remove();
    try {
        setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.NONE, 0);
    } catch { /* 忽略 */ }
}

function registerEvents() {
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);

    // 切聊天 / 重新渲染：把已出图的插画重新写回 DOM。display_text 已随聊天记录持久化，
    // 此处仅兜住 ST 清除 display_text 的少数情况。
    const rehydrate = () => { rehydrateAll().catch(err => warn('重建插图显示失败:', err)); };
    eventSource.on(event_types.CHAT_CHANGED, rehydrate);
    eventSource.on(event_types.MORE_MESSAGES_LOADED, rehydrate);
    eventSource.on(event_types.MESSAGE_EDITED, rehydrate);
    eventSource.on(event_types.MESSAGE_UPDATED, rehydrate);

    eventSource.on(event_types.MESSAGE_SWIPED, (mesId) => {
        // 延迟处理：若该次 swipe 触发了重新生成，则交由流式流程处理，此处跳过。
        setTimeout(() => { onSwipeSettled(mesId).catch(err => warn('swipe 处理失败:', err)); }, 700);
    });

    // WARN: 酒馆渲染时 extra.display_text 的优先级高于 mes。
    //       续写 / 重新生成期间 mes 持续变化而 display_text 仍为旧值，不移除会导致流式内容不可见。
    //       因此在这两类生成开始时先移除最后一条消息上的 display_text。
    //       注意必须排除 type === 'normal'：那是「发送新消息」，上一条消息的 display_text
    //       仍然有效，此时删掉会让已经画好的插图整张消失（图还在，只是不显示）。
    eventSource.on(event_types.GENERATION_STARTED, (type) => {
        if (type === 'normal') return;
        try {
            const ctx = getContext();
            const last = (ctx.chat?.length ?? 0) - 1;
            const msg = ctx.chat?.[last];
            if (last >= 0 && msg?.extra?.illust && msg.extra.display_text) {
                delete msg.extra.display_text;
                ctx.updateMessageBlock(last, { ...msg });
                log(`#${last} ${type} 生成开始，先摘掉旧的 display_text`);
            }
        } catch (err) {
            warn('清理旧 display_text 失败:', err);
        }
    });
}

// ── 消息收到 ──

async function onMessageReceived(messageId, type) {
    if (!s().enabled) return;
    if (type === 'extension') return;                        // 别的扩展插进来的消息，不管
    if (isTypeExcluded(type)) { log(`跳过被排除的类型 ${type}`); return; }
    if (type === 'swipe' && !s().swipe_regenerate) { log('swipe 重新配图已关闭，跳过'); return; }

    const ctx = getContext();
    const msg = ctx.chat?.[messageId];
    if (!msg || msg.is_user || msg.is_system) return;

    // 两条路线并存，互不重复：
    //   ① 标记驱动 —— 正文里已含 [ILLUST: …] 时由 processMessage 处理（零额外等待）
    //   ② 上下文驱动 —— 正文没有标记、且启用了上下文出图时，交由独立模型阅读正文后补位
    await processMessage(messageId, type, msg);
    await processContextIllustration(messageId, msg);
}

// ── 上下文出图（独立模型阅读正文 → 产出提示词 → 交给 8888 / NAI 出图）──
//
// 存在的理由：标记驱动要求剧情模型主动配合，遇到输出模板极强的角色卡（大量沙盒卡）会失效。
// 本路线把「决定画什么」交给一个独立配置的 OpenAI 兼容模型，因此不依赖任何角色卡的配合。
//
// 产出的提示词同时包含自然语言描述与 Danbooru 标签，最终由 prompt_format 决定送哪一半，
// 因此经 V.Adapter（OpenAI 格式上游）与直连官方 NAI / NAI 网关两条路都能用。

const ctxInFlight = new Set();

// collectContext 取本条之前的若干条消息作为前文，供分析模型理解人物与场景。
// 默认取 8 条、每条 800 字：判定作品与世界观需要足够的专有名词与角色信息，
// 喂得太少会导致分析模型写出与世界观脱节的通用提示词。
function collectContext(chat, messageId, maxMessages = 8, perMessage = 800) {
    const parts = [];
    for (let i = Math.max(0, messageId - maxMessages); i < messageId; i++) {
        const m = chat?.[i];
        if (!m) continue;
        const text = String(m.extra?.illust?.src ?? m.mes ?? '').trim();
        if (!text) continue;
        parts.push(`${m.is_user ? '用户' : '角色'}：${truncateText(text, perMessage)}`);
    }
    return parts.join('\n');
}

// workLabel 供分析模型判定作品与画风的角色卡信息。
function workLabel(ctx) {
    const parts = [];
    const name = String(ctx?.name2 ?? '').trim();
    if (name) parts.push(`角色卡：${name}`);
    if (ctx?.groupId) parts.push('（群聊）');
    return parts.join(' ');
}

async function processContextIllustration(messageId, msg) {
    const cfg = s();
    if (!cfg.ctx_enabled) return;
    if (msg.extra?.illust) return;                    // 标记路线已经配过图
    if (ctxInFlight.has(messageId)) return;

    const mes = String(msg.mes ?? '');
    if (hasMarkers(mes)) return;                      // 正文自带标记，走标记路线
    if (!mes.trim()) return;
    if (!cfg.ctx_url || !cfg.ctx_model) {
        warn('已启用上下文出图，但未配置分析模型的地址或模型名，本次跳过');
        finishProgress('已启用上下文出图，但未配置分析模型的地址或模型名', true);
        return;
    }

    const tag = `#${messageId}(上下文)`;
    ctxInFlight.add(messageId);
    const ctx = getContext();
    // 张数统一走「每轮上限」（与标记驱动路线同一个设置项），
    // 避免两套上限各说各话：在设置页改了却在上下文出图上不生效。
    const maxImages = Math.min(6, Math.max(1, cfg.max_per_round | 0));
    const signal = beginRun();
    showProgress(`正在分析正文…（约 10~30 秒，最多 ${maxImages} 张）`);
    try {
        log(`${tag} 送分析模型（${cfg.ctx_model}），正文 ${[...mes].length} 字`);
        const items = await analyzeContext({
            baseUrl: cfg.ctx_url,
            apiKey: cfg.ctx_key,
            model: cfg.ctx_model,
            reply: mes,
            context: collectContext(ctx.chat, messageId),
            work: workLabel(ctx),
            style: cfg.ctx_style,
            quality: cfg.ctx_quality,
            negative: cfg.ctx_negative,
            jb: cfg.jb_llm,
            max: maxImages,
            timeoutMs: cfg.ctx_timeout_sec * 1000,
            signal,
        });
        if (isAborted(signal)) { finishProgress('已终止', false); return; }
        if (!items.length) {
            log(`${tag} 分析模型认为本文没有值得配图的画面`);
            finishProgress('分析结果为空：这条回复没有找到值得配图的画面', false);
            return;
        }
        log(`${tag} 分析得到 ${items.length} 个画面`);
        await runIllustration(ctx, messageId, msg, items, signal);
    } catch (err) {
        if (isAborted(signal)) { finishProgress('已终止', false); return; }
        const m = truncateText(err?.message ?? String(err), 300);
        warn(`${tag} 失败：`, m);
        finishProgress(`上下文出图失败：${m}`, true);
        toastr.error(`上下文出图失败：${m}`, 'V.Canvas', { timeOut: 12000 });
    } finally {
        ctxInFlight.delete(messageId);
        endRun();
    }
}

// runIllustration 把画面列表转成标记后，复用既有的出图与就地替换链路。
async function runIllustration(ctx, messageId, msg, items, signal) {
    const cfg = s();
    const reply = String(msg.mes ?? '');
    const src = applyMarkers(reply, items);
    const markers = findMarkers(src);
    if (!markers.length) {
        log(`#${messageId} 标记组装后为空，跳过`);
        finishProgress('没有可插入的标记', true);
        return;
    }

    msg.extra = msg.extra || {};
    const st = { src, urls: new Array(markers.length).fill(null) };
    msg.extra.illust = st;

    const promptMode = resolvePromptMode(cfg.prompt_format, cfg.base_url);
    const { ok, errors } = await drawMarkers(ctx, messageId, msg, st, markers, cfg, signal, promptMode);

    if (isAborted(signal)) {
        finishProgress('已终止', false);
    } else if (ok > 0) {
        finishProgress(`插画完成${ok > 1 ? `（${ok} 张）` : ''}`);
    } else {
        finishProgress(`插画生成失败：${errors[0] ?? '未知原因'}`, true);
    }
    await finishMessage(ctx, messageId, msg, st, ok, errors);
}

// onSwipeSettled 切换到另一条已有回复（未触发重新生成）时，为其补齐或恢复插画。
async function onSwipeSettled(messageId) {
    if (!s().enabled) return;
    if (messageId === undefined || messageId === null) return;
    if (!s().swipe_regenerate) { await rehydrateAll(); return; }
    if (isGenerating()) { log('swipe 触发了重新生成，交给 MESSAGE_RECEIVED 处理'); return; }

    const ctx = getContext();
    const msg = ctx.chat?.[Number(messageId)];
    if (!msg || msg.is_user || msg.is_system) return;

    const st = msg.extra?.illust;
    if (st && Array.isArray(st.urls) && st.urls.length > 0 && st.urls.every(Boolean)) {
        rehydrateOne(Number(messageId), msg); // 这条已经有图了，只把显示贴回来
        return;
    }
    if (!hasMarkers(String(msg.mes ?? ''))) return;
    await processMessage(Number(messageId), 'swipe', msg);
}

// isGenerating 酒馆是否正在生成/流式输出（此期间不要重渲染消息 DOM）。
function isGenerating() {
    const sp = getContext().streamingProcessor;
    return !!(sp && sp.isFinished === false);
}

// ── 主流程：捕获标记 → 串行出图 → 就地替换 ──

async function processMessage(messageId, type, msg) {
    const mes = String(msg.mes ?? '');
    const tag = `#${messageId}(${type ?? '-'})`;

    if (msg.extra?.illust_done) { log(`${tag} 已配过图，跳过`); return; }
    if (inFlight.has(messageId)) { log(`${tag} 正在处理中，跳过`); return; }

    const now = Date.now();
    if (now - (lastPass.get(messageId) ?? 0) < PASS_COOLDOWN) { log(`${tag} 冷却中，跳过`); return; }
    lastPass.set(messageId, now);

    // 状态：src = 含标记的完整原文（显示与重试的唯一依据），urls 与标记一一对应。
    // continue / append 时 mes = 已剔除标记的旧文 + 新文，这里把原文拼回去再数标记。
    const st0 = msg.extra?.illust;
    const eff = effectiveSource(mes, st0);
    const markers = findMarkers(eff.src);
    if (!markers.length) return; // 静默跳过，不打扰用户
    log(`${tag} 命中 ${markers.length} 个标记，source mode=${eff.mode}`);

    const cfg = s();
    if (!cfg.base_url && !isLocalUpstream(cfg.base_url)) {
        toastr.warning('未配置 NAI 服务地址：装了 V.Adapter 会自动直连；否则请填写一个 NovelAI 协议服务地址', 'V.Canvas');
        return;
    }

    // 送出内容按链路分流：本地适配服务走自然语言描述，其余走 Danbooru 标签。
    const promptMode = resolvePromptMode(cfg.prompt_format, cfg.base_url);
    log(`${tag} prompt_format=${cfg.prompt_format} → 送出 ${promptMode}`);

    const ctx = getContext();
    inFlight.add(messageId);
    const signal = beginRun();

    msg.extra = msg.extra || {};
    let st = st0;
    const oldCount = st?.src ? findMarkers(st.src).length : 0;
    const reuse = !!st && Array.isArray(st.urls) && !!st.src
        && st.urls.length === oldCount
        && (eff.mode === 'same' || eff.mode === 'append');
    if (!reuse) {
        st = { src: eff.src, urls: new Array(markers.length).fill(null) };
        msg.extra.illust = st;
    } else {
        // 续写场景：已有标记保持原样（已生成的图继续复用），只为新增标记补占位
        if (markers.length > st.urls.length) {
            st.urls = st.urls.concat(new Array(markers.length - st.urls.length).fill(null));
        }
        st.src = eff.src;
    }
    if (markers.length < st.urls.length) st.urls.length = markers.length;

    const todo = markers.filter(m => !st.urls[m.index]);
    const batch = todo.slice(0, Math.max(1, cfg.max_per_round));
    let ok = 0;
    const errors = [];

    try {
        if (batch.length === 0) {
            // 全部图片此前已生成，仅显示未回填
            await finishMessage(ctx, messageId, msg, st, 0, []);
            return;
        }
        const r = await drawMarkers(ctx, messageId, msg, st, batch, cfg, signal, promptMode);
        ok = r.ok;
        errors.push(...r.errors);
    } finally {
        inFlight.delete(messageId);
        endRun();
    }

    if (isAborted(signal)) {
        finishProgress('已终止', false);
    } else if (ok > 0) {
        finishProgress(`插画完成${ok > 1 ? `（${ok} 张）` : ''}`);
    } else {
        finishProgress(`插画生成失败：${errors[0] ?? '未知原因'}`, true);
    }
    finishMessage(ctx, messageId, msg, st, ok, errors);
}

// finishMessage 收尾：统计结果 → 持久化 → 提示（聊天记录中不残留 loading 文本）。
async function finishMessage(ctx, messageId, msg, st, ok, errors) {
    const allDone = st.urls.length > 0 && st.urls.every(Boolean);
    msg.extra.illust_done = allDone;

    // 插图不进上下文：正文只保留纯文本，图片只写入 extra.display_text。
    if (ok > 0 && s().strip_marker) {
        const cleaned = stripMarkers(String(msg.mes ?? ''));
        if (cleaned && cleaned !== msg.mes) msg.mes = cleaned;
    }

    applyDisplay(ctx, messageId, msg, st);

    try {
        await ctx.saveChat();
    } catch (err) {
        warn('保存聊天失败:', err);
    }

    if (ok > 0 && errors.length === 0) {
        toastr.success(`插画完成${ok > 1 ? `（${ok} 张）` : ''}`, 'V.Canvas');
    } else if (ok > 0) {
        toastr.warning(`插画完成 ${ok} 张，另有 ${errors.length} 张失败：${errors[0]}`, 'V.Canvas', { timeOut: 12000 });
    } else if (errors.length) {
        toastr.error(`插画生成失败：${errors[0]}`, 'V.Canvas', { timeOut: 12000 });
    }
}

// applyDisplay 把「原文 + 已出图的 URL」渲染成 display_text 并刷新这一条 DOM。
//
// pending 固定为 'drop'：还没出图的标记不留在正文里。
// 否则第一张图出现时，第二张那数百字的提示词会以纯文本形式混在正文中 ——
// 观感是「图没出来、只冒出一堆文字」，而实际上第一张已经生成完毕。
function applyDisplay(ctx, messageId, msg, st) {
    const dt = buildDisplayText(st.src ?? String(msg.mes ?? ''), st.urls, 'Illustration', 'drop');
    if (dt) {
        msg.extra.display_text = dt;
    } else {
        delete msg.extra.display_text;
    }
    try {
        ctx.updateMessageBlock(messageId, { ...msg }); // 只重渲染这一条，不会再触发事件
        hardenChatIllustrationImages(messageId);
    } catch (err) {
        warn('刷新消息 DOM 失败:', err);
    }
    try {
        if (messageId === (ctx.chat?.length ?? 0) - 1) ctx.scrollOnMediaLoad?.();
    } catch { /* 老版本没有这个方法 */ }
}

/**
 * drawMarkers 执行一批出图任务，每张成功后立即单独落位。
 *
 * 串行（parallel 关闭，默认）：逐个请求。上游限制并发或存在风控时适用。
 * 并行（parallel 开启）：同时发起全部请求，各自 await，先返回的先落位 ——
 *   不等其他请求，也不等整批结束。适用于允许并发的上游。
 *
 * 两种模式下每张成功后都会立刻重渲染该条消息，因此第一张一出来就能看到，
 * 不会被尚未完成的第二张拖住。失败互不影响：一张失败不中断其余请求。
 *
 * @returns {Promise<{ok:number, errors:string[]}>}
 */
async function drawMarkers(ctx, messageId, msg, st, batch, cfg, signal, promptMode) {
    const total = batch.length;
    let ok = 0;
    let done = 0;
    const errors = [];

    updateProgress(cfg.parallel
        ? `正在绘制 ${total} 张插画 … 约 30~60 秒`
        : (total > 1
            ? `正在绘制插画 1/${total} … 约 30~60 秒/张，可以先聊别的`
            : '正在绘制插画 … 约 30~60 秒'));

    // 占位符只改 DOM，不落盘（写入后一旦失败或刷新会永久残留「正在绘制」文本）。
    for (const m of batch) showPlaceholder(messageId, m.raw, '正在绘制插画 …');

    const runOne = async (m) => {
        try {
            const gen = await generateIllustration({
                baseUrl: cfg.base_url,
                apiKey: cfg.api_key,
                model: cfg.model,
                prompt: buildUpstreamPrompt(selectPrompt(m, promptMode), cfg.jb_image),
                negative: cfg.negative,
                width: cfg.width,
                height: cfg.height,
                steps: cfg.steps,
                scale: cfg.scale,
                timeoutMs: cfg.timeout_sec * 1000,
                signal,
            });

            const subFolder = ctx.name2 || '';
            const fileName = `illust_${Date.now()}_${m.index}`;
            // url 存在 = 上游远程链接降级结果（无本地字节），直接引用，不落盘
            const url = gen.url ?? await saveBase64AsFile(gen.base64, subFolder, fileName, gen.extension);
            st.urls[m.index] = url;
            ok++;
            done++;
            log(`#${messageId} 第 ${m.index + 1} 张完成 → ${url}`);

            // 写入生成记录：与当前聊天解耦，切聊天后仍可查阅
            recordHistory({
                url,
                prompt: selectPrompt(m, promptMode),
                name: subFolder,
                mid: messageId,
                idx: m.index,
            });

            applyDisplay(ctx, messageId, msg, st);
            updateProgress(total > 1 ? `已完成 ${done}/${total} 张` : '插画完成');
        } catch (err) {
            if (isAborted(signal)) return;
            const msgText = truncateText(err?.message ?? String(err), 300);
            errors.push(msgText);
            warn(`#${messageId} 第 ${m.index + 1} 张失败:`, msgText);
        }
    };

    if (cfg.parallel) {
        await Promise.all(batch.map(m => runOne(m)));
    } else {
        for (let i = 0; i < batch.length; i++) {
            await runOne(batch[i]);
            if (isAborted(signal)) break;
            if (i < batch.length - 1 && cfg.interval_ms > 0) {
                await sleep(cfg.interval_ms);
            }
        }
    }
    return { ok, errors };
}

// ── 插图提示词查看 ──
//
// 提示词本身已随聊天记录保存（extra.illust.src 为含标记的完整原文），
// 此处只补一个展示入口：点击插图 → 浮层显示该图对应标记的描述与标签。
//
// 性能约束：
//   - 事件委托：监听器在整个应用生命周期内只挂一次，挂在消息容器的祖先上，
//     不为每张插图单独绑定（插图数量增长或重复渲染都不会累积监听器）；
//   - 按需解析：提示词只在点击时解析，渲染阶段不做任何预处理；
//   - 浮层即时销毁：浮层与配套的键盘监听仅存在于弹出期间，关闭即移除。
//   - 不触发任何模型调用或网络请求。

const PROMPT_OVERLAY_ID = 'v_canvas_prompt_overlay';
let promptViewerInstalled = false;
let promptKeyHandler = null;

function installPromptViewer() {
    if (promptViewerInstalled) return;
    promptViewerInstalled = true;
    // 捕获阶段触发：避免消息内部的其他 click 处理中断冒泡后本入口失效。
    document.addEventListener('click', onChatImageClick, true);
}

function onChatImageClick(ev) {
    const img = ev.target?.closest?.('.mes_text img');
    if (!img) return;
    const info = resolveIllustration(img);
    if (info) showPromptOverlay(info);
}

// normalizeUrl 去掉查询串与协议主机部分，再做一次解码 ——
// 存下来的 URL 是原始形式（可能含空格），而 display_text 里是经 encodeMdUrl 编码后的形式，
// 两侧都解码后才能对上。
function normalizeUrl(u) {
    let s = String(u ?? '').split('?')[0].replace(/^https?:\/\/[^/]+/i, '');
    try {
        s = decodeURIComponent(s);
    } catch { /* 编码不完整时按原样比较 */ }
    return s;
}

/**
 * resolveIllustration 由被点击的插图反查它在 extra.illust 中的序号与原始标记。
 * 非本扩展生成的图片（角色卡头像、用户手插的图等）一律返回 null。
 * @param {HTMLImageElement} img
 * @returns {{messageId:number,index:number,marker:object}|null}
 */
function resolveIllustration(img) {
    const mesEl = img.closest('.mes');
    if (!mesEl) return null;
    const messageId = Number(mesEl.getAttribute('mesid'));
    if (!Number.isInteger(messageId)) return null;

    const st = getContext().chat?.[messageId]?.extra?.illust;
    if (!st || !Array.isArray(st.urls) || !st.src) return null;

    const needle = normalizeUrl(img.getAttribute('src') || img.src);
    if (!needle) return null;
    const index = st.urls.findIndex(u => u && normalizeUrl(u) === needle);
    if (index < 0) return null;

    const marker = findMarkers(String(st.src))[index];
    if (!marker) return null;
    return { messageId, index, marker };
}

function closePromptOverlay() {
    document.getElementById(PROMPT_OVERLAY_ID)?.remove();
    if (promptKeyHandler) {
        document.removeEventListener('keydown', promptKeyHandler);
        promptKeyHandler = null;
    }
}

// showPromptOverlay 打开提示词浮层（DOM 即时创建，关闭即销毁，不写入聊天记录）。
function showPromptOverlay({ messageId, index, marker }) {
    closePromptOverlay();

    const section = (label, value, mono) => {
        const body = value
            ? escapeHtml(value)
            : '<span class="v_canvas_prompt_none">（标记中未提供）</span>';
        return `<div class="v_canvas_prompt_section">`
            + `<div class="v_canvas_prompt_lab">${label}</div>`
            + `<div class="v_canvas_prompt_text${mono ? ' mono' : ''}">${body}</div>`
            + `</div>`;
    };

    const el = document.createElement('div');
    el.id = PROMPT_OVERLAY_ID;
    el.innerHTML = `
        <div class="v_canvas_prompt_box" role="dialog" aria-label="插图提示词">
            <div class="v_canvas_prompt_head">
                <span>第 ${messageId} 条 · 第 ${index + 1} 张</span>
                <button type="button" class="menu_button v_canvas_prompt_close">关闭</button>
            </div>
            <div class="v_canvas_prompt_body">
                ${section('自然语言描述', marker.desc, false)}
                ${section('Danbooru 标签', marker.tags, true)}
            </div>
        </div>`;
    document.body.appendChild(el);

    el.addEventListener('click', (e) => {
        if (e.target === el || e.target.closest('.v_canvas_prompt_close')) closePromptOverlay();
    });
    promptKeyHandler = (e) => { if (e.key === 'Escape') closePromptOverlay(); };
    document.addEventListener('keydown', promptKeyHandler);
}

// ── 重新贴回显示（切聊天 / 切 swipe）──

// hardenChatIllustrationImages 给正文里的插图 <img> 补上 referrerpolicy="no-referrer"。
//
// 为什么需要：上游 CDN（cdn.qwenlm.ai）有防盗链，带酒馆 Referer 的请求一律 403。
// 面板里的 <img> 可以直接写属性；正文走 markdown 渲染，属性带不上
// （渲染管线会过滤），只能在 DOM 渲染后补——并重赋一次 src，
// 强制以新策略重新发起请求（首次请求可能已按默认策略发出并 403）。
// 只处理本插件写入的远程插图地址，不碰消息里其它来源的图片。
function hardenChatIllustrationImages(messageId) {
    try {
        const chat = getContext().chat ?? [];
        const urls = new Set();
        const collect = (msg) => {
            const list = msg?.extra?.illust?.urls;
            if (Array.isArray(list)) for (const u of list) {
                if (u && /^https?:/i.test(String(u))) urls.add(String(u));
            }
        };
        if (messageId === undefined) chat.forEach(collect);
        else collect(chat[messageId]);
        if (!urls.size) return;

        const norm = (u) => { try { return decodeURIComponent(String(u)); } catch { return String(u); } };
        const roots = messageId === undefined
            ? document.querySelectorAll('.mes_text')
            : document.querySelectorAll(`.mes[mesid="${messageId}"] .mes_text`);
        roots.forEach((root) => {
            root.querySelectorAll('img').forEach((im) => {
                const src = im.getAttribute('src') || '';
                if (!/^https?:/i.test(src)) return;                          // 只处理远程图
                if (!urls.has(src) && !urls.has(norm(src))) return;          // 只处理本插件的插图
                if (im.getAttribute('referrerpolicy') === 'no-referrer') return;
                im.setAttribute('referrerpolicy', 'no-referrer');
                im.src = src;                                                // 以新策略重新发起请求
            });
        });
    } catch (err) {
        warn('正文插图防盗链加固失败:', err);
    }
}

function rehydrateOne(messageId, msg) {
    const st = msg?.extra?.illust;
    if (!st || !Array.isArray(st.urls) || !st.src) return false;
    // drop：切聊天重载时若某张尚未出图，其提示词不应以纯文本留在正文里
    const dt = buildDisplayText(st.src, st.urls, 'Illustration', 'drop');
    const want = dt ?? undefined;
    if (msg.extra.display_text === want) return false;
    if (dt) msg.extra.display_text = dt; else delete msg.extra.display_text;
    try {
        getContext().updateMessageBlock(messageId, { ...msg });
        hardenChatIllustrationImages(messageId);
    } catch (err) {
        warn('重建显示失败:', err);
    }
    return true;
}

async function rehydrateAll() {
    if (!s().enabled) return;
    if (isGenerating()) return; // 生成中不碰 DOM

    const ctx = getContext();
    const chat = ctx.chat ?? [];
    let touched = false;
    for (let i = 0; i < chat.length; i++) {
        const msg = chat[i];
        if (!msg || msg.is_user || msg.is_system) continue;
        const st = msg.extra?.illust;
        if (!st || !Array.isArray(st.urls) || !st.src) continue;
        if (st.urls.length !== findMarkers(st.src).length) {
            // 标记数量不匹配（正文被手动编辑过）→ 清除过期状态，让正文按原始文本显示
            delete msg.extra.illust;
            delete msg.extra.illust_done;
            delete msg.extra.display_text;
            touched = true;
            continue;
        }
        if (rehydrateOne(i, msg)) touched = true;
    }
    if (touched) {
        try { await ctx.saveChat(); } catch { /* 忽略 */ }
    }
    // 切聊天 / 加载更多时整条过一遍：display_text 未变化的消息不会走 rehydrateOne，
    // 但里面的远程插图仍然需要补 referrerpolicy（首次请求可能已按默认策略 403）。
    hardenChatIllustrationImages();
}

// ── 原地占位符（只改 DOM，绝不写进聊天记录）──

/**
 * showPlaceholder 将消息中的 [ILLUST: …] 标记就地替换为「正在绘制」提示。
 *
 * 仅修改 DOM 的原因：占位符一旦写入 `mes`，生图失败或页面刷新后，
 * 聊天记录中会永久残留「正在绘制…」文本，且无机制移除。
 * 出图完成后通过 updateMessageBlock 整条重渲染，占位符即被真实图片替换；
 * 失败时 finishMessage 同样会重渲染一次，占位符消失，标记原样保留在正文中。
 *
 * @returns {boolean} 是否成功找到落点（上下文出图路线下标记不在正文里，会返回 false，
 *                    调用方应改用其他反馈方式）
 */
function showPlaceholder(messageId, markerRaw, label) {
    try {
        const root = document.querySelector(`.mes[mesid="${messageId}"] .mes_text`);
        if (!root) return false;
        const target = findLeafContaining(root, markerRaw);
        if (!target) return false;
        target.innerHTML = `<span class="v_canvas_placeholder">${escapeHtml(label.replace(/^（|）$/g, ''))}</span>`;
        return true;
    } catch (err) {
        warn('插入占位符失败:', err);
        return false;
    }
}

// findLeafContaining 在已渲染的正文里找出「装着这段标记」的最内层元素（通常就是那个 <p>）。
function findLeafContaining(root, needle) {
    if (!needle) return null;
    let fallback = null;
    for (const el of root.querySelectorAll('*')) {
        if (!el.textContent || !el.textContent.includes(needle)) continue;
        fallback = el;
        if (!el.querySelector('*')) return el; // 没有元素子节点 = 就是这段文字本身所在的块
    }
    return fallback;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function truncateText(str, n) {
    const t = String(str ?? '');
    return t.length > n ? `${t.slice(0, n)}…` : t;
}

// ── system prompt 注入 ──

function currentRule() {
    return ruleTemplate(s().max_per_round);
}

// syncPromptInjection 把 ILLUST 规则写进本次生成要发给模型的内容。
//
// 注入位置直接决定模型会不会照做：
//   in_chat（默认）—— 作为对话内的系统消息插在回复之前（默认深度 0）。
//     与角色卡世界书的 depth 0 条目同处一段，是模型注意力最强的位置。
//     重度「沙盒卡」会在 depth 0 塞入整套输出模板，写在 system prompt 顶部的规则会被忽略，
//     因此默认使用该位置。
//   in_prompt —— 并入主系统提示词。位置最靠前，仅在预设已自行处理格式约束时更合适。
function syncPromptInjection() {
    try {
        const c = s();
        if (!(c.enabled && c.inject_prompt)) {
            setExtensionPrompt(PROMPT_KEY, '', extension_prompt_types.NONE, 0, false, extension_prompt_roles.SYSTEM);
            return;
        }
        const text = currentRule();
        if (c.inject_position === 'in_prompt') {
            setExtensionPrompt(PROMPT_KEY, text, extension_prompt_types.IN_PROMPT, 0, false, extension_prompt_roles.SYSTEM);
            log('ILLUST 规则已并入主系统提示词');
        } else {
            setExtensionPrompt(PROMPT_KEY, text, extension_prompt_types.IN_CHAT, c.inject_depth, false, extension_prompt_roles.SYSTEM);
            log(`ILLUST 规则已插入对话（depth ${c.inject_depth}）`);
        }
    } catch (err) {
        warn('system prompt 注入失败:', err);
    }
}

// ── 扩展抽屉（仅保留：名称 + 版本 + 打开管理面板）──
//
// 全部设置已迁入管理面板（panel.html）。酒馆的 inline-drawer 面向少量开关设计，
// 放入二十余个字段会导致版式过长且难以阅读。

function addSettingsUI() {
    const html = `
    <div id="v_canvas_drawer" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>V.Canvas <span class="v_canvas_version">v${VERSION}</span></b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content v_canvas_content">
                <div class="v_canvas_row">
                    <button id="v_canvas_open_panel" class="menu_button">
                        <i class="fa-solid fa-sliders"></i><span>打开管理面板</span>
                    </button>
                </div>
            </div>
        </div>
    </div>`;

    $('#extensions_settings2').append(html);
    $('#v_canvas_open_panel').on('click', openPanel);
}

// ── 管理面板：全屏浮层 + iframe + 桥接 ──
//
// WARN: 面板是独立网页，无法访问酒馆上下文：既拿不到 getContext()，也不能 import '/script.js'。
//       iframe 拥有独立的 JS 世界，在其中加载 script.js 会导致酒馆被二次初始化
//       （两套 chat、两套事件系统）。
//
// 因此采用「面板只发指令、扩展负责执行」的桥接模型：
//   面板点击 → window.parent.__V_CANVAS_API__(action, payload)
//   → 酒馆页面中的扩展本体执行：改动数据 → 刷新 DOM → 持久化
//   → 返回 { ok, data } 或 { ok: false, error }，面板据此展示结果
//
// 无回执的动作视为未生效，不允许静默失败。

const PANEL_ID = 'v_canvas_panel_overlay';
let panelKeyHandler = null;
let panelFitHandler = null;

// 浮层高度按可视视口精确赋值：移动端浏览器地址栏收起/展开、横竖屏切换都会改变可视高度。
function fitPanelHeight(el) {
    const h = Math.round((window.visualViewport && window.visualViewport.height) || window.innerHeight || 0);
    if (h > 0) el.style.height = h + 'px';
}

function bindPanelFit(el) {
    panelFitHandler = () => fitPanelHeight(el);
    fitPanelHeight(el);
    window.addEventListener('resize', panelFitHandler);
    window.addEventListener('orientationchange', panelFitHandler);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', panelFitHandler);
}

function unbindPanelFit() {
    if (!panelFitHandler) return;
    window.removeEventListener('resize', panelFitHandler);
    window.removeEventListener('orientationchange', panelFitHandler);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', panelFitHandler);
    panelFitHandler = null;
}

function panelUrl() {
    return new URL('./panel.html', import.meta.url).href + '?v=' + encodeURIComponent(VERSION);
}

function openPanel() {
    closePanel();

    const overlay = $(`
        <div id="${PANEL_ID}">
            <div class="v_canvas_panel_chrome">
                <span class="v_canvas_panel_title">V.Canvas 管理面板</span>
                <div class="v_canvas_panel_actions">
                    <button class="menu_button" id="v_canvas_panel_newtab">新标签页</button>
                    <button class="menu_button" id="v_canvas_panel_close">关闭</button>
                </div>
            </div>
            <iframe id="v_canvas_panel_iframe" title="V.Canvas 管理面板"></iframe>
            <div id="v_canvas_panel_fallback">
                <div class="v_canvas_panel_fallback_card">
                    <b>面板未能内嵌显示</b>
                    <p>当前浏览环境可能禁止内嵌页面（部分手机浏览器与应用内 WebView 会限制 iframe）。
                       改用新标签页打开面板，功能与内嵌方式一致。</p>
                    <button class="menu_button" id="v_canvas_panel_fallback_open">在新标签页打开面板</button>
                </div>
            </div>
        </div>`);
    $('body').append(overlay);
    bindPanelFit(overlay[0]);

    installBridge();                 // 先挂桥再接面板，免得面板抢先自检说"没连上"
    const frame = overlay.find('#v_canvas_panel_iframe')[0];

    // 新标签页入口：面板页会改从 window.opener 取桥接函数，因此同样可用。
    const openInNewTab = () => {
        const w = window.open(panelUrl(), '_blank');
        if (!w) overlay.find('#v_canvas_panel_fallback').addClass('show');
    };

    let loaded = false;
    frame.addEventListener('load', () => {
        // 未设置 src 时也会触发一次 load（about:blank），据 body 是否为空区分。
        try {
            const doc = frame.contentDocument;
            if (doc && doc.body && doc.body.childElementCount > 0) loaded = true;
        } catch {
            loaded = true; // 跨域无法读取内容时视为已加载
        }
    });
    frame.src = panelUrl();

    overlay.find('#v_canvas_panel_close').on('click', closePanel);
    overlay.find('#v_canvas_panel_newtab').on('click', openInNewTab);
    overlay.find('#v_canvas_panel_fallback_open').on('click', openInNewTab);

    panelKeyHandler = (e) => { if (e.key === 'Escape') closePanel(); };
    document.addEventListener('keydown', panelKeyHandler);

    setTimeout(() => {
        if (!loaded && document.body.contains(frame)) {
            overlay.find('#v_canvas_panel_fallback').addClass('show');
        }
    }, 8000);
}

function closePanel() {
    $(`#${PANEL_ID}`).remove();
    unbindPanelFit();
    if (panelKeyHandler) {
        document.removeEventListener('keydown', panelKeyHandler);
        panelKeyHandler = null;
    }
    try { delete window.__V_CANVAS_API__; } catch { /* 忽略 */ }
}

// ── 桥接 ──

function maskKey(k) {
    const t = String(k ?? '');
    if (!t) return '';
    const r = [...t];
    return r.length <= 4 ? r[0] + '***' : r.slice(0, 3).join('') + '***' + r.slice(-2).join('');
}

// upstreamKind 概览页显示的上游类型描述。
function upstreamKind(base, model) {
    const b = String(base ?? '');
    if (!b) return '未配置';
    if (model) return String(model);
    if (/127\.0\.0\.1|localhost|:8888/.test(b)) return 'V.Adapter';
    return 'NAI 服务';
}

// collectImages 从当前聊天的消息中收集已生成的插画（概览页缩略图用）。
// 直接读取 chat（非缓存），面板展示的始终是当前真实状态。
function collectImages() {
    const ctx = getContext();
    const out = [];
    for (let i = 0; i < (ctx.chat?.length ?? 0); i++) {
        const st = ctx.chat[i]?.extra?.illust;
        if (!st || !Array.isArray(st.urls) || !st.urls.length) continue;
        const prompts = findMarkers(String(st.src ?? '')).map(m => m.prompt);
        st.urls.forEach((url, index) => {
            if (url) out.push({ messageId: i, index, url, prompt: prompts[index] ?? '' });
        });
    }
    return out;
}

function installBridge() {
    window.__V_CANVAS_API__ = async (action, payload) => {
        try {
            switch (action) {
                case 'state': {
                    const c = s();
                    return {
                        ok: true,
                        data: {
                            enabled: !!c.enabled,
                            version: VERSION,
                            upstreamKind: upstreamKind(c.base_url, c.model),
                            apiKeyMasked: maskKey(c.api_key) || '（未设置）',
                            settings: { ...c },
                            images: collectImages(),
                            chatMessages: getContext().chat?.length ?? 0,
                        },
                    };
                }

                case 'settings.get':
                    return { ok: true, data: { settings: { ...s() } } };

                case 'settings.patch': {
                    const before = { ...s() };
                    const notes = applyPatch(payload && typeof payload === 'object' ? payload : {});
                    const after = { ...s() };
                    const changed = Object.keys(after)
                        .filter(k => JSON.stringify(after[k]) !== JSON.stringify(before[k]));
                    syncPromptInjection();          // 总开关 / 注入开关可能一起变了
                    return { ok: true, data: { changed, notes, settings: after } };
                }

                case 'settings.reset': {
                    applyPatch(defaultSettings());
                    syncPromptInjection();
                    return { ok: true, data: { settings: { ...s() } } };
                }

                case 'rule':
                    return { ok: true, data: { rule: currentRule() } };

                // 生成记录：与当前聊天解耦的持久化列表。
                // 不并入 state —— 概览页每 8 秒轮询一次，带上它会反复传输整份记录。
                case 'history.list':
                    return { ok: true, data: { history: [...(s().history ?? [])].reverse() } };

                case 'history.clear': {
                    clearHistory();
                    return { ok: true, data: { count: 0 } };
                }

                case 'test': {
                    const c = s();
                    const message = await testConnection({ baseUrl: c.base_url, apiKey: c.api_key });
                    return { ok: true, data: { message } };
                }

                // 转译出图：由适配服务先把简短描述扩写为完整画面提示词，再出图。
                // 与自动插画流程互不影响 —— 不写入聊天记录，只把结果 URL 交回面板展示。
                case 'translate.generate': {
                    const text = String(payload?.text ?? '').trim();
                    if (!text) return { ok: false, error: '请输入描述' };

                    const c = s();
                    if (!c.base_url && !isLocalUpstream(c.base_url)) {
                        return { ok: false, error: '未配置 NAI 服务地址：装了 V.Adapter 会自动直连；否则请填写一个 NovelAI 协议服务地址' };
                    }

                    // 「自动尺寸」依赖上游的扩写能力（V.Adapter 的 expand=1）。
                    // 地址不是本地适配服务时扩写不会发生，此时回退用设置页的出图参数，避免上报 0 尺寸。
                    const followRecommended = payload?.sizeMode !== 'fixed' && isLocalUpstream(c.base_url);

                    const gen = await generateIllustration({
                        baseUrl: c.base_url,
                        apiKey: c.api_key,
                        model: c.model,
                        prompt: buildUpstreamPrompt(text, c.jb_image),
                        negative: c.negative,
                        width: followRecommended ? 0 : c.width,
                        height: followRecommended ? 0 : c.height,
                        steps: c.steps,
                        scale: c.scale,
                        timeoutMs: c.timeout_sec * 1000,
                        expand: true,
                    });

                    const ctx = getContext();
                    // url 存在 = 上游远程链接降级结果（无本地字节），直接引用，不落盘
                    const url = gen.url ?? await saveBase64AsFile(gen.base64, ctx.name2 || '', `translate_${Date.now()}`, gen.extension);
                    log(`转译出图完成 → ${url}（${followRecommended ? '跟随转译推荐尺寸' : '设置页尺寸'}）`);
                    return { ok: true, data: { url, prompt: gen.prompt || text } };
                }

                // 上下文出图：试连分析模型
                case 'ctx.test': {
                    const c = s();
                    const message = await testAnalyzeModel({
                        baseUrl: c.ctx_url, apiKey: c.ctx_key, model: c.ctx_model,
                    });
                    return { ok: true, data: { message } };
                }

                // 上下文出图：立即分析最后一条角色回复并出图（用于验证链路，不必等下一轮对话）
                case 'ctx.generate': {
                    const c = s();
                    if (!c.ctx_url || !c.ctx_model) {
                        return { ok: false, error: '请先填写分析模型的 API 地址与模型名' };
                    }
                    if (!c.base_url && !isLocalUpstream(c.base_url)) {
                        return { ok: false, error: '未配置 NAI 服务地址：装了 V.Adapter 会自动直连；否则请填写一个 NovelAI 协议服务地址' };
                    }
                    const ctx = getContext();
                    const chat = ctx.chat ?? [];
                    let id = -1;
                    for (let i = chat.length - 1; i >= 0; i--) {
                        const m = chat[i];
                        if (m && !m.is_user && !m.is_system && String(m.mes ?? '').trim()) { id = i; break; }
                    }
                    if (id < 0) return { ok: false, error: '当前聊天里没有可配图的角色回复' };

                    const msg = chat[id];
                    const maxImages = Math.min(6, Math.max(1, c.max_per_round | 0));
                    const signal = beginRun();
                    showProgress(`正在分析正文…（约 10~30 秒，最多 ${maxImages} 张）`);
                    let items;
                    try {
                        items = await analyzeContext({
                            baseUrl: c.ctx_url,
                            apiKey: c.ctx_key,
                            model: c.ctx_model,
                            reply: stripMarkers(String(msg.mes ?? '')),
                            context: collectContext(chat, id),
                            work: workLabel(ctx),
                            style: c.ctx_style,
                            quality: c.ctx_quality,
                            negative: c.ctx_negative,
                            jb: c.jb_llm,
                            max: maxImages,
                            timeoutMs: c.ctx_timeout_sec * 1000,
                            signal,
                        });
                    } catch (err) {
                        endRun();
                        const em = truncateText(err?.message ?? String(err), 300);
                        finishProgress(`分析失败：${em}`, true);
                        return { ok: false, error: em };
                    }
                    if (!items.length) {
                        endRun();
                        finishProgress('分析结果为空：这条回复没有找到值得配图的画面', false);
                        return { ok: false, error: '分析模型认为这条回复没有值得配图的画面' };
                    }

                    // 重新分析时先清掉上一条的插图状态，避免与旧图叠加
                    if (msg.extra?.illust) { delete msg.extra.illust; delete msg.extra.illust_done; }
                    try {
                        await runIllustration(ctx, id, msg, items, signal);
                    } finally {
                        endRun();
                    }
                    const urls = (msg.extra?.illust?.urls ?? []).filter(Boolean);
                    if (!urls.length) return { ok: false, error: '分析完成，但图片没有生成成功（详见生成记录与浏览器控制台）' };
                    return { ok: true, data: { messageId: id, count: urls.length, prompts: items.map(it => it.desc || it.tags) } };
                }

                default:
                    return { ok: false, error: `不认识的指令：${action}` };
            }
        } catch (err) {
            const msg = truncateText(err?.message ?? String(err), 300);
            warn(`桥接动作 ${action} 失败:`, msg);
            return { ok: false, error: msg };
        }
    };
}

// ── 自行启动 ──
// SillyTavern 的扩展加载器只负责挂载 <script type="module">，不会调用 init()，
// 因此在模块加载完成后自行初始化（与官方系统扩展、V.Adapter 扩展行为一致）。
init().catch(err => console.error('[V.Canvas] 初始化失败:', err));
