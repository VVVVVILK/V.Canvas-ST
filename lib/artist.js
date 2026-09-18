// artist.js — 画师串（画风配方）的解析与拼装。
//
// 画师串是一串画师名标签（可带权重，如 `0.8::artist:yalmyu::`），
// 用来锁定整幅画的画风基调 —— 它被放在正向提示词的**最前面**，
// 因为 NAI 对靠前 tag 的权重更高，而画师串决定的是整张图的画风底子。
//
// 它只对**扩散模型**有意义：官方 NovelAI / NAI 网关是拿 Danbooru 数据训练的，
// 而 Danbooru 上每张图都标了画师；OpenAI 格式的聊天模型不认这串东西。
//
// 所以本模块的核心不是「怎么拼」，而是**什么时候不拼**：
// 经 V.Adapter（OpenAI 格式上游）出图时送出去的是自然语言描述，
// 往里塞画师名只会污染描述 —— 必须跳过。判断依据直接复用 marker.js 定下的
// prompt 形态（description / tags / both），即「只有会送标签串的形态才拼」。
//
// 纯逻辑，不依赖酒馆，可离线单测（见 test/test.mjs 的「画师串」一节）。

// 单条画师串的长度上限。正常画师串在数百字符内，超过这个量级基本可断定为误粘贴正文，
// 与其让一整段小说跟着每次出图发出去，不如截断。
export const ARTIST_PROMPT_MAX = 2000;

// 名字上限（仅用于面板列表显示）。
export const ARTIST_NAME_MAX = 60;

// 库的条目数上限。同为安全阀：超过就该拆成多套配置、而不是无上限地堆。
export const ARTIST_LIST_MAX = 30;

/**
 * artistAppliesTo 该 prompt 形态下画师串是否生效。
 *
 * - tags   ：送标签串（直连官方 NAI / NAI 网关）→ 生效
 * - both   ：描述与标签合并送出 → 生效
 * - description：送自然语言描述（经 V.Adapter 的 OpenAI 格式上游）→ **不生效**
 *   往一段中文描述里塞 `artist:wlop` 会让聊天模型把它当成描述内容去理解，
 *   结果是描述被污染、出图变差。这是本模块存在的理由。
 */
export function artistAppliesTo(mode) {
    return mode === 'tags' || mode === 'both';
}

/** sanitizeArtistPrompt 把画师串折成单行并限长。 */
export function sanitizeArtistPrompt(s, max = ARTIST_PROMPT_MAX) {
    return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** sanitizeArtistName 名字只去首尾空白（中间允许空格，如「厚涂 写实」）。 */
export function sanitizeArtistName(s, max = ARTIST_NAME_MAX) {
    return String(s ?? '').trim().slice(0, max);
}

/**
 * artistPromptFor 取当前选中那条的画师串内容。
 *
 * 三种情况都返回空串（= 不使用），调用方无需另作判断：
 *   - 未选（空 id）；
 *   - id 悬空（指向已被删除的条目）；
 *   - 条目内容为全空白。
 *
 * 注意：**刻意不改写存储里的 id**。悬空 id 只是「暂时不生效」，
 * 若用户之后又建了同 id 的条目（如撤销误删），仍会自动恢复。
 *
 * @param {Array<{id:string,name:string,prompt:string}>} presets
 * @param {string} activeId
 * @returns {string}
 */
export function artistPromptFor(presets, activeId) {
    const id = String(activeId ?? '').trim();
    if (!id) return '';
    const list = Array.isArray(presets) ? presets : [];
    const hit = list.find(a => a && String(a.id) === id);
    return hit ? sanitizeArtistPrompt(hit.prompt) : '';
}

/**
 * withArtistPrompt 按 prompt 形态决定要不要把画师串拼到最前。
 *
 * 不生效（形态不符 / 未选 / 内容为空）时**原样返回入参**，
 * 因此调用点可以无条件套一层，行为与未加本功能时逐字节相同。
 *
 * @param {string} prompt 已经过 selectPrompt 处理、即将发往上游的提示词
 * @param {string} artistStr 画师串内容（通常来自 artistPromptFor）
 * @param {'description'|'tags'|'both'} mode
 * @returns {string}
 */
export function withArtistPrompt(prompt, artistStr, mode) {
    const p = String(prompt ?? '');
    const a = sanitizeArtistPrompt(artistStr);
    // 不生效时原样返回，一个字节都不动 —— 调用点因此可以无条件套一层。
    if (!artistAppliesTo(mode) || !a) return p;
    const body = p.trim();
    return body ? `${a}, ${body}` : a;
}
