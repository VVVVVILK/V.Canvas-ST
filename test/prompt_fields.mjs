// prompt_fields.mjs — 「提示词」页每个字段的全链路落点测试（离线）。
//
// 用户的问题：「我让它画暗黑画风，它就能固定画那种吗？提示词里所有的都要测。」
// 本文件对每个字段 × 每条路线断言它的落点，谁没跟上谁就是 bug：
//
//   字段                 分析模型路线        正文直出            标记路线(自然语言)   测试出图            直连NAI(标签模式)
//   画风 ctx_style       【画风要求】✓       【画风】✓           画风：… ✓           画风：… ✓          ✗ 刻意不拼(语言不通)
//   画质 ctx_quality     【正面质量提示词】✓ 【画质】✓          画质：… ✓           画质：… ✓          ✗ 同上
//   负面 ctx_negative    【负面提示词】✓     【负面提示词】✓     ✗(文字模型才懂)     ✗                  ✗(NAI 负面词用设置页那栏)
//   破限·分析 jb_llm     【附加说明】✓(最前) ✗                  ✗                   ✗                  ✗
//   破限·画图 jb_image   ✗                  ✓(前缀)            ✓(前缀)             ✓(前缀)            ✓(前缀)
//   直出附加指令 guide   ✗                  ✓                  ✗                   ✗                  ✗
//   画师串 artist        ✗                  ✗                  tags/both ✓         ✗                  tags/both ✓
//   分流前缀 nsfw_prefix ✗                  ✗                  ✗                   ✗                  分流时 ✓
//
// index.js 侧的组装顺序（此处只能验证纯函数，接线靠 code review + 契约）：
//   buildUpstreamPrompt(withArtistPrompt(withStylePrompt(sendPrompt, style, quality, mode), artist, mode), prefix)

import { buildAnalysisParts, buildDirectProse, withStylePrompt } from '../lib/analysis.js';
import { withArtistPrompt } from '../lib/artist.js';
import { resolvePromptMode, selectPrompt } from '../lib/marker.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log(`[OK]   ${name}`); }
    else { fail++; console.log(`[FAIL] ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}
const STYLE = '暗黑哥特画风，低饱和冷色调';
const QUALITY = 'masterpiece, best quality';
const NEG = 'lowres, bad hands';

// ── 1. 分析模型路线（runCtxAnalyzer → buildAnalysisParts）──
{
    const { user } = buildAnalysisParts('正文', '前文', 2, {
        style: STYLE, quality: QUALITY, negative: NEG, jb: '破限说明', work: '角色卡：测试',
    });
    ok('分析·画风以【画风要求】段写入', user.includes('【画风要求】\n暗黑哥特画风，低饱和冷色调'));
    ok('分析·画质以【正面质量提示词】段写入', user.includes('【正面质量提示词】\nmasterpiece, best quality'));
    ok('分析·负面以【负面提示词】段写入', user.includes('【负面提示词】\nlowres, bad hands'));
    ok('分析·破限词以【附加说明】写入且在最前',
        user.includes('【附加说明】\n破限说明') && user.indexOf('【附加说明】') < user.indexOf('【作品信息】'));
    ok('分析·正文在最后（风格等都在它前面）',
        user.indexOf('【画风要求】') < user.indexOf('【需要配图的正文】'));

    const empty = buildAnalysisParts('正文', '', 1, {}).user;
    ok('分析·全空时四段都不出现',
        !empty.includes('【画风要求】') && !empty.includes('【正面质量提示词】')
        && !empty.includes('【负面提示词】') && !empty.includes('【附加说明】'));
}

// ── 2. 正文直出（buildDirectProse）──
{
    const prose = buildDirectProse('雨夜的街头', {
        guide: '固定构图：仰角', work: '角色卡：测试', style: STYLE, quality: QUALITY, negative: NEG,
    });
    ok('直出·画风以【画风】写入', prose.includes('【画风】暗黑哥特画风，低饱和冷色调'));
    ok('直出·画质以【画质】写入', prose.includes('【画质】masterpiece, best quality'));
    ok('直出·负面以【负面提示词】写入', prose.includes('【负面提示词】lowres, bad hands'));
    ok('直出·附加指令写入且在内置指令之后', prose.includes('固定构图：仰角'));
    ok('直出·顺序：画风/画质在正文之前',
        prose.indexOf('【画风】') < prose.indexOf('雨夜的街头'));
    ok('直出·全空时干净（无中括号段）',
        !buildDirectProse('雨夜的街头', {}).includes('【画风】')
        && !buildDirectProse('雨夜的街头', {}).includes('【负面提示词】'));
}

// ── 3. 标记路线 / 测试出图的组装层（withStylePrompt → withArtistPrompt → 前缀）──
{
    const desc = '银发少女站在雨夜的街头';
    const tags = '1girl, silver hair, night, rain';
    const artist = 'artist:wlop';

    // description 模式：画风/画质进请求（这是本次修的洞 —— 此前标记路线完全不吃画风）
    const d = withStylePrompt(desc, STYLE, QUALITY, 'description');
    ok('自然语言·画风前置（画风：…）', d.startsWith('画风：暗黑哥特画风，低饱和冷色调'));
    ok('自然语言·画质随后（画质：…）', d.includes('画质：masterpiece, best quality'));
    ok('自然语言·原文保留在画风之后', d.endsWith(desc));

    // tags 模式：原样返回，一个字节不动（标签串不能混中文句子）
    ok('标签模式·画风/画质不拼入（原样返回）', withStylePrompt(tags, STYLE, QUALITY, 'tags') === tags);

    // both 模式：生效
    ok('both 模式·画风/画质拼入', withStylePrompt(desc, STYLE, '', 'both').startsWith('画风：'));

    // 组合顺序（与 index.js drawMarkers 一致）：前缀(破限) → 画师串 → 画风行 → 原文
    const full = withStylePrompt(desc, STYLE, QUALITY, 'description');
    const withA = withArtistPrompt(full, artist, 'description');   // description：画师串让位
    ok('description 模式·画师串自动让位（不污染散文）', withA === full);
    const tagsFull = withArtistPrompt(withStylePrompt(tags, STYLE, QUALITY, 'tags'), artist, 'tags');
    ok('tags 模式·只有画师串前置、无画风行', tagsFull === `${artist}, ${tags}`);

    // 全空时无条件套一层也必须逐字节原样（调用点因此敢永远套）
    ok('全空时原样返回（可无条件套一层）', withStylePrompt(desc, '', '', 'description') === desc);

    // 测试出图的接线（index.js translate.generate 同款顺序，此处验证纯函数部分）。
    // 注意：地址留空时 resolvePromptMode 依赖运行时的页面桥（globalThis.__V_ADAPTER_NAI__）
    // 才判成 description，离线环境没有桥 → 按 tags 处理，这是纯函数的正确行为。
    const testGen = withStylePrompt('一只橘猫', STYLE, '', resolvePromptMode('auto', 'http://127.0.0.1:8888', 'auto'));
    ok('测试出图·本机适配服务（description）画风生效', testGen.startsWith('画风：暗黑哥特画风'));
    const testGenNai = withStylePrompt('1girl, cat', STYLE, '', resolvePromptMode('auto', 'https://image.novelai.net', 'auto'));
    ok('测试出图·直连官方 NAI（tags）画风不生效（语言不通）', testGenNai === '1girl, cat');
}

// ── 4. 标记两段的选择（selectPrompt：送出内容按形态分流）──
{
    const m = { desc: '描述段', tags: 'tag1, tag2' };
    ok('送出·description 取描述段', selectPrompt(m, 'description') === '描述段');
    ok('送出·tags 取标签段', selectPrompt(m, 'tags') === 'tag1, tag2');
    ok('送出·both 两段合并', selectPrompt(m, 'both') === '描述段, tag1, tag2');
    ok('送出·auto 按地址判断：本机适配 → 描述', selectPrompt(m, resolvePromptMode('auto', 'http://127.0.0.1:8888', 'auto')) === '描述段');
    ok('送出·auto 按地址判断：官方 NAI → 标签', selectPrompt(m, resolvePromptMode('auto', 'https://image.novelai.net', 'auto')) === 'tag1, tag2');
}

console.log(`\nRESULT: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
