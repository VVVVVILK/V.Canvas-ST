// analysis.js — 上下文出图：由文字模型阅读正文得到出图提示词，再把结果转成标记。
//
// 本模块只做纯逻辑（拼提示词、解析 JSON、把结果插回正文），不发起任何网络请求，
// 也不依赖酒馆，因此可离线自测。网络部分见 llm-api.js。
//
// 设计意图：标记驱动路线要求剧情模型主动配合，遇到输出模板极强的角色卡会失效。
// 本路线改为事后由独立模型阅读正文，再由插件把结果转成同样的 [ILLUST: …] 标记，
// 从而复用既有的出图、就地替换、状态记录与提示词查看链路。

import { MAX_MARKER_LEN } from './marker.js';

// 两段各自的字符上限。
//
// WARN: 两者之和加上标记外壳，必须小于 marker.js 的 MAX_MARKER_LEN ——
//       后者是「防正则误吞正文」的保护线，超过它的标记会被整条丢弃。
//       两者之和一旦超过保护线，表现为「分析成功、出图零次、零报错」。
//       上限直接由 MAX_MARKER_LEN 推导，两处不再各写一个数字。
const MAX_DESC_LEN = 700;
const MAX_TAGS_LEN = 400;

// 拼接标记时预留给外壳（[ILLUST:  | ]）的余量。
const MARKER_SHELL_RESERVE = 50;

// 每轮最多接受的画面数上限（与设置项的取值上限一致）。
const MAX_ITEMS = 6;

export const ANALYSIS_SYSTEM_PROMPT = `你是一名插画分镜与美术指导。用户会给出一段小说正文、它的前文、作品信息，以及一组出图提示词要求。
职责：先判定正文所属的作品与世界观，再从中挑出最值得配插画的画面，
并按固定格式写出可直接用于出图的提示词。

【第一步：判定作品与画风】
- 依据作品信息、前文与正文中的专有名词，判定正文所属的作品与世界观
  （例如《火影忍者》《英雄联盟》，或明确的原创世界观）。
- 画面的美术风格必须与该作品一致，并在 desc 的开头明确写出。
- 用户提供了画风要求时，以用户要求为准，不得替换为自行判定的风格。
- 角色必须还原原作设定：发型发色、瞳色、脸型、体型、标志性服饰与配饰，
  不得凭空脑补为现代时装或通用网红脸。
- 角色的身份、服饰与道具依据正文与前文自行判断，无需用户逐一指定，
  也不应将用户提示词中的示例人物套用到不相关的角色身上。
- 场景、建筑与道具须符合该世界的设定与时代感。

【第二步：选取画面】
1. 每个画面输出三段内容：desc、tags、anchor。
2. desc 为一段连贯的自然语言，长度 500~600 字，不得简略，
   按固定顺序书写：「作品与画风 → 场景环境 → 人物（外貌、服装、动作、表情）→ 构图与镜头 → 光影与氛围」。
3. tags 为英文 Danbooru 标签串，长度 300~400 字符，以英文逗号分隔，
   按「主体 → 外观 → 服装 → 动作 → 场景 → 画风」的顺序排列。
4. 正面质量提示词、画风要求（若用户提供）为强制约束：
   desc 与 tags 必须体现其中要求的画质、要素与风格。
5. 负面提示词（若用户提供）为排除项：其中列出的内容不得出现在 desc 与 tags 中。
6. 上述提示词中给出的措辞与标签可直接沿用；需要补充细节时自行补全，
   补充内容不得与既有要求冲突。
7. anchor 须为正文中的原样摘录，不得改写或缩写；图片将插在该句所在段落的下方。
8. 各画面须对应正文中不同的时刻，anchor 不得重复，也不得取自相邻文字。
9. anchor 须沿正文均匀分布：将正文按画面数量等分为若干段，第 k 个画面取自第 k 段，
   不得全部取自开头。仅有一个画面时，取自画面感最强的段落，不得默认取开头第一段。
10. 对话密集或无画面感的段落不予配图。若整段正文均无可配图的画面，输出空数组。

【输出格式】
严格输出如下 JSON，不得附加任何解释文字，也不得包裹 Markdown 代码块：
{"images":[{"desc":"…","tags":"…","anchor":"…"}]}`;

// sanitize 清掉会破坏标记语法的字符（标记以 `|` 分段、以 `]` 结束），并限制长度。
// preferCommaBreak 为 true 时（用于标签串），超长截断回退到上一个逗号，避免把单词切成两半。
function sanitize(s, maxLen, preferCommaBreak = false) {
    let t = String(s ?? '')
        .replace(/[\r\n]+/g, ' ')
        .replace(/[|｜]/g, '/')
        .replace(/[[\]]/g, '')
        .trim();
    if (t.length > maxLen) {
        t = t.slice(0, maxLen);
        if (preferCommaBreak) {
            const c = t.lastIndexOf(',');
            if (c > 0) t = t.slice(0, c);
        }
    }
    return t;
}

// buildAnalysisMessages 组装分析请求的 messages。
// reply 为待配图的正文；context 为前文摘要串（可为空）；
// meta.work 为作品信息（角色卡名等）；
// meta.style / meta.quality / meta.negative 为用户在「提示词」页填写的画风、
// 正面质量提示词与负面提示词（均可空）。
//
// 每次调用都是一份全新的两轮 messages（system + 单条 user），不带历史轮次：
// 分析请求是「一次性窗口」，正文字数只由本次打包的前文规模决定，不随对话轮次累积。
// meta.jb 为使用者自填的破限词（可空）：拼在 user 消息最前，
// 用于分析模型对血腥 / 成人向正文拒答时由使用者自行注入的附加说明。
// 本插件不内置任何此类内容。
export function buildAnalysisMessages(reply, context, max, meta = {}) {
    const n = Math.min(MAX_ITEMS, Math.max(1, parseInt(max, 10) || 1));
    const parts = [];
    const jb = String(meta.jb ?? '').trim();
    if (jb) parts.push(`【附加说明】\n${jb}\n`);
    const work = String(meta.work ?? '').trim();
    if (work) parts.push(`【作品信息】\n${work}\n`);
    const style = String(meta.style ?? '').trim();
    if (style) parts.push(`【画风要求】\n${style}\n`);
    const quality = String(meta.quality ?? '').trim();
    if (quality) parts.push(`【正面质量提示词】\n${quality}\n`);
    const negative = String(meta.negative ?? '').trim();
    if (negative) parts.push(`【负面提示词】\n${negative}\n`);
    const ctx = String(context ?? '').trim();
    if (ctx) parts.push(`【前文】\n${ctx}\n`);
    parts.push(`【需要配图的正文】\n${String(reply ?? '').trim()}\n`);
    parts.push(`本次最多输出 ${n} 个画面；若正文不足以支撑 ${n} 个画面，按实际可配数量输出。`);
    return [
        { role: 'system', content: ANALYSIS_SYSTEM_PROMPT },
        { role: 'user', content: parts.join('\n') },
    ];
}

/**
 * parseAnalysisJSON 宽容解析模型返回的画面列表。
 * 容忍 Markdown 代码块包裹、前后夹杂解释文字、顶层直接给数组。
 * @param {string} content
 * @returns {Array<{desc:string,tags:string,anchor:string}>}
 */
export function parseAnalysisJSON(content) {
    const text = String(content ?? '');
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    let data = null;
    if (start >= 0 && end > start) {
        try { data = JSON.parse(text.slice(start, end + 1)); } catch { data = null; }
    }
    if (!data) {
        const s2 = text.indexOf('[');
        const e2 = text.lastIndexOf(']');
        if (s2 >= 0 && e2 > s2) {
            try { data = JSON.parse(text.slice(s2, e2 + 1)); } catch { data = null; }
        }
    }
    if (!data) return [];
    const raw = Array.isArray(data) ? data : (Array.isArray(data.images) ? data.images : []);
    const out = [];
    for (const it of raw) {
        if (!it || typeof it !== 'object') continue;
        const desc = sanitize(it.desc ?? it.description ?? '', MAX_DESC_LEN);
        const tags = sanitize(it.tags ?? '', MAX_TAGS_LEN, true);
        const anchor = String(it.anchor ?? it.quote ?? '').replace(/[\r\n]+/g, ' ').trim();
        if (!desc && !tags) continue;
        out.push({ desc, tags, anchor });
        if (out.length >= MAX_ITEMS) break;
    }
    return out;
}

// escapeRegExp 正则转义。
function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * findAnchor 在正文里定位 anchor。
 * 先按原样找；找不到再按「空白折叠」的方式找 —— 模型引文与正文之间常有
 * 换行/空格的差异，两个方向都要容忍，因此把 anchor 里的空白折成 `\s*`。
 * @returns {number} 命中下标，未命中返回 -1
 */
export function findAnchor(text, anchor) {
    const a = String(anchor ?? '').trim();
    if (!a) return -1;
    const direct = text.indexOf(a);
    if (direct >= 0) return direct;
    const pattern = a.split(/\s+/).map(escapeRegExp).join('\\s*');
    if (!pattern) return -1;
    const m = new RegExp(pattern).exec(text);
    return m ? m.index : -1;
}

// paragraphEnd 取「包含 from 的那一行」的结尾下标（不含换行符）。
function paragraphEnd(text, from) {
    const nl = text.indexOf('\n', from);
    return nl < 0 ? text.length : nl;
}

/**
 * applyMarkers 把画面列表转成标记，插到 anchor 所在段落的正下方。
 *
 * 输出仍是普通正文，只是多了 `[ILLUST: desc | tags]` 行；后续由既有的标记链路消费
 * （出图 → 就地替换成图片 → 正文不留提示词文字）。
 *
 * anchor 未命中的画面统一追加到正文末尾，不丢弃。
 *
 * @param {string} text 正文
 * @param {Array<{desc:string,tags:string,anchor:string}>} items
 * @returns {string}
 */
export function applyMarkers(text, items) {
    const src = String(text ?? '');
    const list = Array.isArray(items) ? items : [];
    if (!list.length || !src.trim()) return src;

    const used = new Set();
    const placed = [];   // { at, line }
    const tail = [];     // 没找到 anchor 的

    for (const it of list) {
        const desc = sanitize(it?.desc, MAX_DESC_LEN);
        const tags = sanitize(it?.tags, MAX_TAGS_LEN, true);
        if (!desc && !tags) continue;

        // 兜底：把两段收紧到不会被 marker.js 丢弃的长度（宁可截短，也不整条丢掉）
        const limit = MAX_MARKER_LEN - MARKER_SHELL_RESERVE;
        let first = desc || tags;
        let second = tags || desc;
        while (`[ILLUST: ${first} | ${second}]`.length > limit) {
            if (second.length >= first.length && second.length > 0) second = second.slice(0, -1);
            else if (first.length > 0) first = first.slice(0, -1);
            else break;
        }
        const line = `[ILLUST: ${first} | ${second}]`;

        const anchor = String(it?.anchor ?? '').trim();
        let at = -1;
        if (anchor) {
            at = findAnchor(src, anchor);
            if (at >= 0) {
                // 同一位置只保留一张：模型重复引用同一段文字时，多余的直接丢弃，
                // 不能甩到文末（否则会在消息末尾堆出无归属的插图）。
                if (used.has(at)) continue;
                used.add(at);
            }
        }
        if (at < 0) { tail.push(line); continue; }
        placed.push({ at: paragraphEnd(src, at), line });
    }

    if (!placed.length && !tail.length) return src;

    placed.sort((a, b) => a.at - b.at);
    let out = '';
    let cursor = 0;
    for (const p of placed) {
        out += src.slice(cursor, p.at) + `\n${p.line}`;
        cursor = p.at;
    }
    out += src.slice(cursor);

    if (tail.length) out = out.replace(/\s+$/, '') + '\n\n' + tail.join('\n');
    return out;
}
