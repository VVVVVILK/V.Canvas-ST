// nsfw.js — 分流判定：本次画面该交给主通道，还是交给第二套出图后端。
//
// 存在理由：主通道（例如经 V.Adapter 走聊天画图模型）受平台内容策略限制，
// 某些画面提交上去只会得到拒绝或失败，白白耗掉一次额度与几十秒等待。
// 使用者的做法是：这类画面改投一个自己有账号的 NovelAI 协议服务。
//
// 因此本模块只回答一个是非题：**这次的提示词是否命中分流条件**。
// 命中则由调用方改用另一套地址 / 密钥 / 提示词形态出图；
// 未命中则一切照旧 —— 不额外发任何请求，也不改动提示词本身。
//
// 判定口径与词表的归属：
//   判定是纯字符串匹配，词表由使用人在设置里自行维护（逗号分隔）。
//   插件只内置一组最通用的内容分级词，用来保证新装即可工作；
//   具体要拦下哪些内容，完全取决于使用者填了什么 —— 插件不做价值判断，
//   也不替使用者决定什么该画、什么不该画。

// 内置判定词：收录内容分级层面的通用词（Danbooru 的 rating / 内容类别标签名
// 与对应的中文说法），并补一组高频的中文动作/部位词与英文具体标签词。
// 使用者可按自己的需要任意增删改。
//
// 口径说明：判定词太少（最初只有 nsfw/nude/naked 等几个）会导致中文 NSFW 剧情
// 用「脱衣、抚摸、亲吻、胸部」这类常见词时漏判 → 误送主通道（qwen 画不了 NSFW）→
// 整轮报废。这里在分级词基础上补高频词让判定尽量命中；仍漏判的用户可开
// 「NSFW 专用模式」（nsfw_force）彻底不做关键词判定、全部强制走分流通道。
const BUILTIN_WORDS = [
    // 分级 / 题材词（英文）
    'nsfw', 'nude', 'nudity', 'naked', 'explicit', 'sexual', 'erotic',
    'porn', 'porno', 'hentai', 'lewd', '18+', 'r18',
    // 分级 / 题材词（中文）
    '裸体', '裸露', '成人', '色情', '情色', '性爱', '做爱', '交配', '交合',
    '性交', '媾合', '云雨', '春宫', '淫荡', '淫乱', '纵欲', '欢爱', '缠绵',
    // 高频动作 / 部位词（中文，NSFW 剧情常用）
    '脱衣', '脱光', '抚摸', '爱抚', '亲吻', '接吻', '舌吻', '胸部', '乳房',
    '乳头', '大腿', '内裤', '胸罩', '插入', '抽插', '口交', '舔', '吮吸',
    // 英文具体标签（分析模型 / 标记里常见）
    'sex', 'intercourse', 'making love', 'kissing', 'groping', 'breasts',
    'nipples', 'handjob', 'fellatio', 'cunnilingus', 'penis', 'vagina',
    'spread legs', 'topless', 'bottomless', 'undressing', 'making out',
];

// 英文词按词边界匹配，避免 `sexual` 命中 `asexual` 这类包含关系；
// 中文没有词边界，直接子串匹配。
const HAS_CJK = /[一-鿿぀-ヿ]/;

/**
 * parseWords 把使用者填的词表切成词数组。
 * 分隔符同时接受中英文逗号、分号、空白与换行；空项丢弃；长度上限 200 条。
 *
 * @param {string} s
 * @returns {string[]}
 */
export function parseWords(s) {
    return String(s ?? '')
        .split(/[,，;；\s]+/)
        .map(v => v.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 200);
}

/**
 * buildWordList 合并内置词与使用者词表（去重，保持内置词在前）。
 * @param {string} [extra] 使用者填写的词表原文
 * @returns {string[]}
 */
export function buildWordList(extra) {
    const out = BUILTIN_WORDS.slice();
    const seen = new Set(out);
    for (const w of parseWords(extra)) {
        if (!seen.has(w)) { seen.add(w); out.push(w); }
    }
    return out;
}

/**
 * detectNsfw 判定一段提示词是否命中分流条件。
 *
 * 输入应同时包含画面的自然语言描述与标签串：两者都可能携带分级线索，
 * 只判其中一半会漏。大小写不敏感。
 *
 * @param {string} text 待判定的提示词
 * @param {string} [extraWords] 使用者填写的词表原文（留空则只用内置词）
 * @returns {boolean}
 */
export function detectNsfw(text, extraWords) {
    const hay = String(text ?? '').toLowerCase();
    if (!hay.trim()) return false;
    for (const w of buildWordList(extraWords)) {
        if (!w) continue;
        if (HAS_CJK.test(w)) {
            if (hay.includes(w)) return true;
        } else {
            // 词边界：两侧不能是字母或数字。标签串里常见 `1girl, nude` 这类写法，
            // 下划线连接的复合标签（如 `nude_`）也应命中，故下划不计入边界字符。
            // 用捕获组而不是 lookbehind —— 后者在部分旧版 WebView 上不被支持。
            const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(w)}([^a-z0-9]|$)`, 'i');
            if (re.test(hay)) return true;
        }
    }
    return false;
}

// escapeRegExp 正则转义：词表里可能出现 `.` `+` `(` 等字符。
function escapeRegExp(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
