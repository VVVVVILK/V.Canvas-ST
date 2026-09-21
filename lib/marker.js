// marker.js — [ILLUST: 描述 | Danbooru,Tags] 标记的捕获、定位与就地替换。
//
// 设计要点：
//   - 正则写得宽容：容忍全角冒号、缺 `|`、多余空格、标记内换行；
//   - 标记的两半分别对应两类上游输入形态（见 resolvePromptMode）：
//       `|` 之后的 Danbooru Tags   → 扩散模型（官方 NovelAI / NAI 网关）
//       `|` 之前的自然语言描述      → OpenAI 格式上游（聊天模型等）
//     具体送出哪一半由 prompt_format 设置决定；
//   - 记录每个标记在原文中的起止下标，替换时按下标就地插入，不追加到消息末尾。

// 在标准写法的基础上把 `[^|\]\n]` 放宽成 `[^|\]]`，以便容忍标记内换行。
export const ILLUST_RE = /\[ILLUST[:：]\s*([^|\]]+?)\s*(?:\|\s*([^\]]+?)\s*)?\]/gi;

// 单个标记的原文长度上限：超过这个长度基本可以断定是正则误吞了正文。
//
// WARN: 该值必须大于 analysis.js 产出标记的最大长度（desc 700 + tags 400 + 外壳 ≈ 1114），
//       否则上下文出图路线生成的标记会被这里整条丢弃（静默，零报错）。
//       两者错位时的表现是「分析成功、出图零次」且无任何报错。
//
// 导出给 analysis.js 使用：后者拼接标记时按此值预留余量，避免两处各写一个数字而对不上。
export const MAX_MARKER_LEN = 1800;

function norm(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim();
}

// hasMarkers 快速判断文本里有没有标记（每次重置 lastIndex，避免全局正则的状态污染）。
export function hasMarkers(text) {
    const re = new RegExp(ILLUST_RE.source, 'gi');
    return re.test(String(text ?? ''));
}

/**
 * findMarkers 找出文本里所有标记，按出现顺序返回。
 *
 * `prompt` 字段为标记的双段内容的兜底合成（Tags 优先），仅用于展示与日志；
 * 真正送上游的 input 由 selectPrompt() 按 prompt_format 组装。
 *
 * @param {string} text
 * @returns {Array<{index:number,start:number,end:number,raw:string,desc:string,tags:string,prompt:string}>}
 */
export function findMarkers(text) {
    const src = String(text ?? '');
    const re = new RegExp(ILLUST_RE.source, 'gi');
    const out = [];
    let m;
    while ((m = re.exec(src)) !== null) {
        if (m[0].length > MAX_MARKER_LEN) continue;
        const desc = norm(m[1]);
        const tags = norm(m[2]);
        const prompt = tags || desc; // 仅供展示/日志，不参与出图内容选择
        if (!prompt) continue;       // 空标记直接忽略
        out.push({
            index: out.length,
            start: m.index,
            end: m.index + m[0].length,
            raw: m[0],
            desc,
            tags,
            prompt,
        });
        if (re.lastIndex <= m.index) re.lastIndex = m.index + 1; // 防零宽死循环
    }
    return out;
}

// ── 送出内容的选择（prompt_format）──
//
// 标记的两半对应两类上游输入形态：
//   - 官方 NovelAI / NAI 网关使用 Danbooru 系数据训练，标签是最有效的输入形态；
//   - OpenAI 格式上游（含聊天模型）的 prompt 形态为自然语言，对标签串处理效果差。
// 因此按链路分流：本地地址（V.Adapter 等适配服务）走描述，其余走标签。

const LOCAL_UPSTREAM_RE = /127\.0\.0\.1|localhost|:8888/i;

// isLocalUpstream 地址是否指向本机适配服务（链路①：经 V.Adapter）。
export function isLocalUpstream(baseUrl) {
    // 同页面的 V.Adapter 挂出页面内调用桥时，桥的另一端就是本地的适配服务：
    // 语义上等同「本地上游」—— 送自然语言描述、支持 expand 扩写。
    if (typeof globalThis.__V_ADAPTER_NAI__ === 'function') return true;
    return LOCAL_UPSTREAM_RE.test(String(baseUrl ?? ''));
}

/**
 * resolvePromptMode 把 prompt_format 设置解析成具体的送出内容形态。
 *
 * upstreamType 是用户显式声明的上游类型，优先级高于地址猜测：
 * 地址能区分「本机适配服务」与「远端」，但**区分不了「远端适配服务」与「第三方 NAI 网关」** ——
 * 两者在地址上长得一模一样（都是远程域名）。部署在 VPS 上的适配服务会被误判成标签上游，
 * 直连官方 NAI 的人则相反。这件事只能由使用者声明，猜不出来。
 *
 * @param {string} format auto / description / tags / both
 * @param {string} baseUrl 当前上游地址（仅 auto 档 + 未声明上游类型时使用）
 * @param {'auto'|'adapter'|'nai'} [upstreamType]
 * @returns {'description'|'tags'|'both'}
 */
export function resolvePromptMode(format, baseUrl, upstreamType = 'auto') {
    const f = String(format ?? 'auto');
    // 形态被手动指定时，上游类型不影响结果 —— 用户已经直接说了要送哪一半
    if (f === 'description' || f === 'tags' || f === 'both') return f;
    const u = String(upstreamType ?? 'auto');
    if (u === 'adapter') return 'description';   // 适配服务 / 聊天画图模型：吃自然语言
    if (u === 'nai') return 'tags';              // 官方 NAI / 网关 / 第三方中转：吃标签串
    return isLocalUpstream(baseUrl) ? 'description' : 'tags';
}

/**
 * selectPrompt 按形态从标记中取出发往上游的内容。
 * 任一档在对应部分缺失时回退到另一部分，避免送出空串。
 *
 * @param {{desc?:string, tags?:string}} marker
 * @param {'description'|'tags'|'both'} mode
 * @returns {string}
 */
export function selectPrompt(marker, mode) {
    const desc = norm(marker?.desc);
    const tags = norm(marker?.tags);
    switch (mode) {
        case 'description': return desc || tags;
        case 'both': return [desc, tags].filter(Boolean).join(', ');
        case 'tags':
        default: return tags || desc;
    }
}

/**
 * stripMarkers 从正文里剔除标记，顺带把留下的空行收拾干净。
 * 用于「插图不进上下文」：mes 只保留纯文本。
 * @param {string} text
 * @returns {string}
 */
export function stripMarkers(text) {
    const src = String(text ?? '');
    const markers = findMarkers(src);
    if (!markers.length) return src;
    let out = '';
    let cursor = 0;
    for (const m of markers) {
        out += src.slice(cursor, m.start);
        cursor = m.end;
    }
    out += src.slice(cursor);
    return out
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * effectiveSource 还原「含标记的完整原文」，并说明这次正文是怎么变的。
 *
 * 首次回复时 mes 就是原文；续写（continue / append）时酒馆做的是 `mes += 新文`，
 * 而我们上一轮可能已经把标记从 mes 里剔掉了，所以此时 mes = 已剔除的旧文 + 新文。
 * 认出这种情况就把旧原文接回去，保证标记和 URL 的下标一一对应（已出的图不会被重画）。
 *
 * mode：
 *   'new'    —— 这条还没有过插图状态
 *   'same'   —— 正文没变（只是显示没贴上）
 *   'append' —— 在旧正文后面续写了，旧标记原地保留
 *   'reset'  —— 正文被整体换掉（swipe 到了另一条回复 / 手动改过）→ 旧状态作废，重新配图
 *
 * @param {string} mes 当前正文
 * @param {{src?:string}} [st] 已有的插图状态
 * @returns {{src: string, mode: 'new'|'same'|'append'|'reset'}}
 */
export function effectiveSource(mes, st) {
    const text = String(mes ?? '');
    if (!st?.src) return { src: text, mode: 'new' };
    if (text === st.src) return { src: st.src, mode: 'same' };
    const strippedPrev = stripMarkers(st.src);
    if (text === strippedPrev) return { src: st.src, mode: 'same' };
    if (text.startsWith(strippedPrev)) {
        const tail = text.slice(strippedPrev.length);
        return tail ? { src: st.src + tail, mode: 'append' } : { src: st.src, mode: 'same' };
    }
    return { src: text, mode: 'reset' };
}

// encodeMdUrl 把图片地址转成可嵌入 Markdown 的形式。
//
// WARN: `saveBase64AsFile` 返回的地址会落在以角色名命名的目录下，而角色名**可能含空格、
//       括号等字符**。直接塞进 `![alt](url)` 会让 Markdown 解析失败，
//       图片就会以**纯文本**形式出现在正文里（角色名含空格或括号时即可触发）。
function encodeMdUrl(u) {
    try {
        return encodeURI(String(u ?? ''))
            .replace(/\(/g, '%28')
            .replace(/\)/g, '%29')
            .replace(/#/g, '%23');
    } catch {
        return String(u ?? '');
    }
}

/**
 * buildDisplayText 把标记就地替换成块级 markdown 图片，生成「只给用户看」的显示文本。
 *
 * 文字段落 A
 * ──────────
 * 文字段落 B      ← 标记在这里
 * ──────────
 * [ 插 画 ]       ← 图独占一行，插在段落正下方
 * ──────────
 * 文字段落 C      ← 被图挤到下面继续排
 *
 * pending 决定「还没出图的标记」怎么处理：
 *   'keep'   —— 原样保留（默认，供离线自测与需要保留原文的场景使用）
 *   'drop'   —— 从显示层移除
 *
 * WARN: 出图进行中与收尾都必须用 'drop'。保留原文会把整段提示词（数百字）
 *       直接摊在正文里：第一张图出来时，第二张的提示词会以纯文本形式混在正文中，
 *       观感是「图没出来、只冒出一堆文字」。
 *
 * @param {string} src 含标记的原始正文
 * @param {Array<string|null>} urls 与标记一一对应的图片 URL（null = 这张还没生成出来）
 * @param {string} [alt='Illustration'] 图片 alt 文本
 * @param {'keep'|'drop'} [pending='keep'] 未出图标记的处理方式
 * @returns {string|null} 至少替换成功一张时返回新文本，否则返回 null（调用方应保持原样）
 */
export function buildDisplayText(src, urls, alt = 'Illustration', pending = 'keep') {
    const text = String(src ?? '');
    const markers = findMarkers(text);
    if (!markers.length) return null;
    // 标记后面紧跟的空白与换行一并收掉，避免堆出三连换行
    const skipTrailing = (i) => {
        let c = i;
        while (c < text.length && (text[c] === ' ' || text[c] === '\t')) c++;
        if (text[c] === '\n') c++;
        return c;
    };
    let out = '';
    let cursor = 0;
    let changed = false;
    for (const m of markers) {
        const url = urls?.[m.index];
        if (!url && pending === 'keep') continue; // 没出图成功 → 保留原标记不动

        out += text.slice(cursor, m.start);
        out = out.replace(/[ \t]+$/, '');   // 只收行内空白，换行留给下面的分支决定

        if (url) {
            out = out.replace(/\s+$/, '');  // 收掉标记前面那行留下的空行
            out += `\n\n![${alt}](${encodeMdUrl(url)})\n\n`; // 图独占一行（块级），插在该段落正下方
            cursor = skipTrailing(m.end);
        } else {
            // 移除标记本身，但保留其后紧跟的那个换行 —— 否则相邻两段会被粘成一坨
            cursor = m.end;
            while (cursor < text.length && (text[cursor] === ' ' || text[cursor] === '\t')) cursor++;
            if (text[cursor] === '\n') cursor++;
        }
        changed = true;
    }
    if (!changed) return null;
    return (out + text.slice(cursor)).replace(/\s+$/, '');
}

// ── 标记落点矫正 ──
//
// 背景：标记驱动路线下，插图的位置完全由剧情模型决定 —— 插件只是把标记就地换成图片，
// 不会搬运它。而多数模型写结构化内容时习惯把它堆在回复末尾，于是插图变成「附件」
// 而不是「配图」。改提示词只能缓解，无法保证。
//
// 因此在插件侧补一道确定性的矫正：认出「标记扎堆在末尾」这种形态后，按段落把标记
// 重新摊开。纯文本一字不动（stripMarkers 的结果不变），只改标记插在哪一段下面。

// splitParagraphs 切段，返回 [[start, end], …]（不含分隔用的换行）。
//
// 两种分段写法都要认：
//   空行分段 —— `段一\n\n段二`（多数模型的默认写法）
//   单换行分段 —— `段一\n段二`（同样常见，尤其国产模型与带输出模板的角色卡）
// 只认空行时，单换行的正文会被整段算作「一段」，于是「只有一段、无处可插」，
// 矫正静默失效 —— 表面上开关开着却什么都没发生。
// 因此先按空行切；切不出两段再退回按单换行切。
function splitParagraphs(text) {
    const src = String(text ?? '');
    const cut = (re) => {
        const paras = [];
        let start = 0;
        let m;
        const r = new RegExp(re.source, 'g');
        while ((m = r.exec(src)) !== null) {
            paras.push([start, m.index]);
            start = m.index + m[0].length;
        }
        paras.push([start, src.length]);
        return paras.filter(([a, b]) => b > a);   // 丢掉空段
    };
    const byBlank = cut(/\n[ \t]*\n/);
    if (byBlank.length >= 2) return byBlank;
    return cut(/\n/);
}

/**
 * isTailClustered 判定标记是否全部堆在正文末尾。
 *
 * 口径：**最后一个标记之后基本没有正文了**，而它之前有相当篇幅。
 * 按「正文还剩多少」量而不是按「下标落在全文百分之几」量 ——
 * 后者会把标记自身的长度算进分母：标记一长，阈值就被推到更后面，反而判不出来。
 *
 * 只在有多个段落时才有意义 —— 只有一段时无处可插，改不动也不该改。
 *
 * @param {string} text 含标记的原文
 * @returns {boolean}
 */
export function isTailClustered(text) {
    const src = String(text ?? '');
    const markers = findMarkers(src);
    if (!markers.length) return false;
    if (splitParagraphs(stripMarkers(src)).length < 2) return false;

    const pure = (s) => String(s ?? '').replace(/\s+/g, '').length;
    const before = pure(src.slice(0, markers[0].start));
    const after = pure(src.slice(markers[markers.length - 1].end));
    if (before === 0) return false;                       // 正文全在标记后面，不是「堆在末尾」
    return after <= Math.min(30, before * 0.1);
}

/**
 * redistributeMarkers 把扎堆在末尾的标记按段落均匀摊开。
 *
 * 落点公式：第 k 个标记（共 n 个）插在第 `floor((k+1) * (p-1) / (n+1))` 段之后，
 * p 为段落数。分子用 p-1 而非 p，是为了保证标记后面永远还有正文 ——
 * 否则单标记 + 双段落时会又落回末尾，等于没改。
 *
 * 只在 isTailClustered() 为真时动手；其余情况返回 null，调用方保持原样。
 * 纯文本部分原样保留，因此不会影响正文内容与上下文。
 *
 * @param {string} text 含标记的原文
 * @returns {string|null} 重排后的原文；无需改动返回 null
 */
export function redistributeMarkers(text) {
    const src = String(text ?? '');
    const markers = findMarkers(src);
    if (!markers.length) return null;

    const body = stripMarkers(src);
    const paras = splitParagraphs(body);
    if (paras.length < 2) return null;          // 只有一段：没有落点可挑
    if (!isTailClustered(src)) return null;

    const n = markers.length;
    const p = paras.length;
    // 每个标记落在哪个段落之后（0-based 段落下标；插在该段末尾）
    const slots = markers.map((_, k) => {
        const slot = Math.floor(((k + 1) * (p - 1)) / (n + 1));
        return Math.min(Math.max(slot, 0), p - 2);   // 夹住，保证后面还有正文
    });

    // 插入符跟随正文原本的分段风格：正文用空行分段就插空行，用单换行就插单换行。
    // 一律插空行会把单换行的正文改造出空行 —— 正文的排版被插件悄悄改掉了。
    const sep = /\n[ \t]*\n/.test(body) ? '\n\n' : '\n';

    // 从后往前插，避免先插入的内容把后面的下标顶偏
    const order = slots
        .map((slot, k) => ({ slot, k }))
        .sort((a, b) => (b.slot - a.slot) || (b.k - a.k));

    let out = body;
    for (const { slot, k } of order) {
        const at = paras[slot][1];
        const head = out.slice(0, at).replace(/\s+$/, '');
        // 段落分隔本身已经是换行，tail 开头的空白必须收掉，
        // 否则标记后面会叠出一串换行（渲染出来就是一段空白）。
        const tail = out.slice(at).replace(/^\s+/, '');
        out = `${head}${sep}${markers[k].raw}${tail ? `${sep}${tail}` : ''}`;
    }
    return out;
}
