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

/**
 * resolveCtxSource 把设置里的「分析模型来源」解析成本次实际要用的实现。
 *
 * 两条分析路径（跟随酒馆主 API / 自定义服务）都从这个结果分叉，
 * 且它决定「本轮到底发不发请求」—— 因此放在本模块（不依赖酒馆、可离线单测），
 * 由单测锁死三种结果，避免以后改动时悄悄变成「配不全也照发」。
 *
 * @param {string} source 'main' | 'custom'（settings.js 已保证只能是这两个）
 * @param {{url?:string, model?:string}} cfg
 * @returns {'main'|'custom'|null} null = 选了自定义但地址或模型名没填，本轮不发请求
 */
export function resolveCtxSource(source, cfg = {}) {
    if (source !== 'custom') return 'main';
    const url = String(cfg.url ?? '').trim();
    const model = String(cfg.model ?? '').trim();
    return (url && model) ? 'custom' : null;
}

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
   动作与身体部位必须写具体：画面中实际发生的动作、涉及的身体部位与接触关系
   逐一落成准确的 Danbooru 标签（如 kissing、hugging、groping、handjob、fellatio、
   cunnilingus、spread legs、breasts、nipples 等），与正文该时刻实际发生的内容一一对应；
   不得用 nsfw、nude、sex 这类只表示内容分级的泛化词代替具体画面，泛化词最多只能作附加说明。
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

// analysisTokenBudget 单次分析请求的输出预算（token 数）。
// 每个画面约 500~600 字描述 + 300~400 字符标签，中文按每字 1~1.5 token 计，
// 单画面约 1200 token。固定上限会在第二个画面处截断 JSON，
// 表现为「分析成功但一张图都不出，零报错」。故按画面数放大，再封一个顶。
// 两条分析路径（自定义服务 / 酒馆主 API）共用此值，避免两处各写一个数字而对不上。
export function analysisTokenBudget(max) {
    const n = Math.max(1, parseInt(max, 10) || 1);
    return Math.min(8192, 1200 * n + 600);
}

/**
 * buildAnalysisParts 组装分析请求的两段内容。
 *
 * 与 buildAnalysisMessages 同源：后者只负责把它包成 OpenAI 的 messages 数组，
 * 而走酒馆主 API 的路径需要的是「系统提示词 + 单条用户消息」两段字符串，故单独导出。
 *
 * reply 为待配图的正文；context 为前文摘要串（可为空）；
 * meta.work 为作品信息（角色卡名等）；
 * meta.style / meta.quality / meta.negative 为用户在「提示词」页填写的画风、
 * 正面质量提示词与负面提示词（均可空）。
 * meta.jb 为使用者自填的破限词（可空），拼在 user 消息最前，
 * 用于分析模型对血腥 / 成人向正文拒答时由使用者自行注入的附加说明。
 * 本插件不内置任何此类内容。
 * meta.nsfw 为布尔：本次正文已命中 NSFW 分流条件，将走专门的成人向出图通道。
 * 此时画面必须落在正文中**真正成人的那一时刻** —— 位置由分析模型自行语义判断
 * （前段 / 中段 / 后段皆有可能，正文怎么写就画哪），不得按「画面感最强」去挑
 * 日常铺垫或对话。既然已经分流到成人通道，这一张就该画成人内容。
 *
 * @returns {{system:string, user:string}}
 */
export function buildAnalysisParts(reply, context, max, meta = {}) {
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
    // nsfw：本次正文命中 NSFW 分流条件，将走专门的成人向出图通道。
    // 画面必须落在真正成人的那一时刻 —— 位置由分析模型语义判断，不靠关键词硬挑段
    // （正文怎么布局都可能：前段铺垫、中段高潮、后段余韵；也可能通篇都是成人内容）。
    if (meta.nsfw) {
        parts.push(`【本次画面要求】\n本次正文已判定为成人向（NSFW），将走专门的成人向出图通道。`
            + `请通读正文，自行判断其中**真正发生亲密 / 成人行为的那一个时刻**（位置不限，`
            + `前段、中段或后段都可能），画面必须取自该时刻；`
            + `不得为了「画面感强」去选日常铺垫、普通对话或非成人内容作为画面主体。`
            + `若正文确有成人时刻，就直接画它；没有成人行为时，选最接近的亲密画面。\n`);
    }
    parts.push(`【需要配图的正文】\n${String(reply ?? '').trim()}\n`);
    parts.push(`本次最多输出 ${n} 个画面；若正文不足以支撑 ${n} 个画面，按实际可配数量输出。`);
    return { system: ANALYSIS_SYSTEM_PROMPT, user: parts.join('\n') };
}

// buildAnalysisMessages 组装直连分析请求的 messages。
//
// 每次调用都是一份全新的两轮 messages（system + 单条 user），不带历史轮次：
// 分析请求是「一次性窗口」，正文字数只由本次打包的前文规模决定，不随对话轮次累积。
export function buildAnalysisMessages(reply, context, max, meta = {}) {
    const { system, user } = buildAnalysisParts(reply, context, max, meta);
    return [
        { role: 'system', content: system },
        { role: 'user', content: user },
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

// ── 正文直出（跳过分析模型，把 AI 正文原样送生图模型）──
//
// 与上面那条路线的分工：
//   分析模型路线 —— 先由文字模型把正文改写成出图提示词，再送上游（文 → 文 → 图）
//   正文直出路线 —— 正文本身就是提示词，直接送上游（文 → 图）
//
// 后者成立的唯一前提是「上游自己读得懂自然语言」—— 也就是聊天画图模型 /
// OpenAI 兼容生图那一路。直连官方 NAI 时正文是中文散文，送进去等于喂噪料，
// 那种链路必须走分析模型把正文翻成 Danbooru 标签。能否用由 directAppliesTo 判。
//
// 仍然走「包成标记」的路子，因为整条显示链路（就地替换、切聊天重建、提示词查看、
// 生成记录）都以标记为锚；另起一套状态会在 rehydrate 的标记数校验处被当成脏数据清掉。

// 直出时单条正文的字符上限。
//
// WARN: 上限由 MAX_MARKER_LEN 推导，不能另写一个数字 —— 直出也是包成标记实现的，
//       超过保护线的标记会被 findMarkers 整条丢弃，表现为「请求发出去了、图也拿到了、
//       但正文里什么都不显示，切一次聊天连图一起消失」，且全程零报错。
export const DIRECT_PROSE_MAX = MAX_MARKER_LEN - 32;

/**
 * directAppliesTo 当前送出形态下，正文直出是否可用。
 *
 * 只有自然语言处理档位成立。'tags'（直连官方 NAI / NAI 网关）必须走分析模型：
 * 那类上游按 Danbooru 标签训练，喂一整段中文散文等于喂噪料。
 *
 * @param {'description'|'tags'|'both'} mode
 * @returns {boolean}
 */
export function directAppliesTo(mode) {
    return mode === 'description' || mode === 'both';
}

/**
 * DIRECT_GUIDE 直出时固定拼在最前面的作画指令。
 *
 * 它顶替的是分析模型原本顺带完成的三件事 —— 缺了它，直接甩一整段带对话的正文过去，
 * 生图模型容易把多个时刻糊进一张图（四不像）、自行把人物改成现代时装、
 * 或把正文里的对话当画面内容。**这三条正是分析模式与直出模式画风一致性的来源**，
 * 因此直出不能只是「把正文发出去」就算完。
 *
 * 与 ANALYSIS_SYSTEM_PROMPT 的区别：那条要求输出 JSON 结构（desc/tags/anchor），
 * 这条只要求画一张图，不要求任何结构化输出。
 */
export const DIRECT_GUIDE = `你是一名插画师。下面是一段小说正文，请为它绘制一幅插画。

【硬性要求】
1. 只画正文中最具画面感的那一个瞬间；不要把多个场景、多个时刻拼进同一张图。
2. 人物的发型发色、瞳色、体型、服饰与表情，一律按正文描写还原，不得自行改为现代时装或通用脸。
3. 场景、建筑与道具须符合正文的设定与时代感。
4. 正文里的对话、独白与旁白不是画面内容；画面中不要出现任何文字。
5. 构图完整、主体突出，一眼能看清「谁、在哪、在做什么」。`;

/**
 * buildDirectProse 组装直出要送的那段文字。
 *
 * 顺序：内置作画指令 → 使用者附加指令 → 作品信息 → 画风 → 画质 → 负面提示词 → 正文。
 * 越靠前权重越高，故正文永远在最后。
 *
 * 负面提示词照常拼（只要用户填了就生效）：它默认是空的，属于使用者主动选择；
 * 对聊天画图模型说「不要出现 X」偶尔会有反向提示的副作用，但**那是使用者自己权衡的事** ——
 * 遇到的人把这一栏清空即可，不该由插件替他决定不给。
 *
 * 正文按剩余额度截断，保证「指令 + 正文」整体不超过 DIRECT_PROSE_MAX ——
 * 否则会被包成的标记整条丢弃（见 proseToMarker 的说明）。
 *
 * @param {string} reply AI 正文
 * @param {{guide?:string, work?:string, style?:string, quality?:string, negative?:string}} [meta]
 * @returns {string} 正文为空时返回空串（调用方据此跳过，不产生空标记）
 */
export function buildDirectProse(reply, meta = {}) {
    const head = [DIRECT_GUIDE];
    const guide = String(meta.guide ?? '').trim();
    if (guide) head.push(guide);
    const work = String(meta.work ?? '').trim();
    if (work) head.push(`【作品信息】\n${work}`);
    const style = String(meta.style ?? '').trim();
    if (style) head.push(`【画风】${style}`);
    const quality = String(meta.quality ?? '').trim();
    if (quality) head.push(`【画质】${quality}`);
    const negative = String(meta.negative ?? '').trim();
    if (negative) head.push(`【负面提示词】${negative}`);

    const prefix = head.join('\n');
    const sep = '\n\n';
    // 连分隔空行一起算进去，否则「指令 + 正文」会比上限多出 sep 的长度。
    const body = sanitize(reply, Math.max(0, DIRECT_PROSE_MAX - prefix.length - sep.length));
    if (!body) return '';
    return prefix + sep + body;
}

/**
 * proseToMarker 把一段正文包成标记。
 *
 * 刻意不带 `|` 段：直出只有描述、没有标签，而 findMarkers 的正则要求 `|` 之后
 * 至少有一个非 `]` 字符，`[ILLUST: x | ]` 会整条匹配不上 —— 同样是静默吞掉、零报错。
 *
 * @returns {string} 空正文返回空串（调用方据此跳过，不产生空标记）
 */
export function proseToMarker(text) {
    const t = sanitize(text, DIRECT_PROSE_MAX);
    return t ? `[ILLUST: ${t}]` : '';
}

// ── 直出的落点 ──
//
// 分析模型会给出 anchor（原文引句）来决定插图插在哪一段下面；直出不经分析，就没有这个信息。
// 一律挂在末尾虽然不会错，但一条长回复的图永远在最底下，读起来不像「配图」，更像「附件」。
//
// 这里用一个零成本的启发式：**画面感来自叙述，不来自对白**。
// 把引号内容与括号内容去掉后，剩下最长的那一段，就是最可能正在写景 / 写人的地方。
// 它当然不如模型给的 anchor 准（模型是「画什么」和「插哪」一起定的），
// 但比一律挂末尾强得多，且不需要多花一次模型调用。

// narrativeLength 一段文字去掉对话与括号后的有效叙述长度。
function narrativeLength(s) {
    return String(s ?? '')
        .replace(/[「『“"][^」』”"]*[」』”"]/g, '')   // 引号里的是对白，不算
        .replace(/[（(][^）)]*[）)]/g, '')             // 括号里的是心理 / 动作补充，不算
        .replace(/\s+/g, '')
        .length;
}

/**
 * pickProseAnchor 挑一个落点：返回插图应插在哪个下标之前。
 *
 * @param {string} text 正文原文
 * @returns {number} 落点下标；-1 = 挑不出来（只有一段，或整段都是纯对白），调用方退回末尾
 */
export function pickProseAnchor(text) {
    const src = String(text ?? '');
    const paras = [];
    let start = 0;
    const re = /\n[ \t]*\n/g;
    let m;
    while ((m = re.exec(src)) !== null) {
        paras.push([start, m.index]);
        start = m.index + m[0].length;
    }
    paras.push([start, src.length]);

    // 只有一段时没有落点可挑 —— 硬插到句子中间会把一段话劈成两半，观感更差。
    if (paras.length < 2) return -1;

    let best = -1;
    let bestScore = 0;
    for (const [s, e] of paras) {
        const score = narrativeLength(src.slice(s, e));
        if (score > bestScore) { bestScore = score; best = e; }
    }
    return bestScore > 0 ? best : -1;   // 全是纯对白 → 同样退回末尾
}

/**
 * applyProseMarker 把直出标记插到正文里。
 *
 * @param {string} text 正文原文
 * @param {string} prose 直出要送的文字
 * @param {number} [at] 落点下标（来自 pickProseAnchor）；为 -1 或越界时挂在末尾
 * @returns {string}
 */
export function applyProseMarker(text, prose, at = -1) {
    const src = String(text ?? '');
    const line = proseToMarker(prose);
    if (!line || !src.trim()) return src;
    if (at >= 0 && at < src.length) {
        const head = src.slice(0, at).replace(/\s+$/, '');
        const tail = src.slice(at).replace(/^\s+/, '');
        return head + '\n\n' + line + (tail ? '\n\n' + tail : '');
    }
    return src.replace(/\s+$/, '') + '\n\n' + line;
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
