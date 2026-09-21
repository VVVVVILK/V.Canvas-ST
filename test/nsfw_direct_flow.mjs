// nsfw_direct_flow.mjs — 直出模式命中分流条件的完整链路测试（离线模拟）。
//
// 复刻 runDirectPass / drawMarkers 里的分流判定与送出内容选择：
//   1. 直出正文（stripMarkers 后）→ detectNsfw 判定是否命中分流条件；
//   2. 命中 → 强制走分流通道（forceDivert），形态按分流通道解析（nai → tags）；
//   3. 分流通道送 selectPrompt(marker, 'tags') —— 取分析模型产物里的标签，而不是散文。
// 核心断言：NSFW 正文绝不把散文当标签送给 NAI；普通正文绝不误切。

import { detectNsfw, parseWords, buildWordList } from '../lib/nsfw.js';
import { resolvePromptMode, selectPrompt } from '../lib/marker.js';
import { buildAnalysisParts, splitProseChunks, applyProseMarkers } from '../lib/analysis.js';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
    if (cond) { pass++; console.log(`[OK]   ${name}`); }
    else { fail++; console.log(`[FAIL] ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}

// ── 直出模式的分流判定（复刻 runDirectPass 逻辑）──
// 直出时：主通道形态必须是 description（qwen 吃自然语言），命中分流才转分析。
function directDivertDecide(cfg, body) {
    const needDivert = cfg.nsfw_enabled && !!cfg.nsfw_base_url
        && detectNsfw(body, cfg.nsfw_words);
    return needDivert;
}

// 分流通道路由（复刻 drawMarkers 的 route 解析）：默认 nai + tags
function divertRoute(cfg) {
    return {
        mode: resolvePromptMode(cfg.nsfw_prompt_format, cfg.nsfw_base_url, cfg.nsfw_upstream_type),
        baseUrl: cfg.nsfw_base_url,
    };
}

// 分析模型产物：desc（自然语言）+ tags（Danbooru 标签）
const analyzedItem = {
    desc: '金发少女躺在床上，双手撑在身后，双腿张开，神情迷离',
    tags: '1girl, blonde hair, lying on bed, spread legs, handjob, breasts, nipple slip, blush',
    anchor: '她缓缓张开了双腿',
};

// 普通正文 —— 不应命中
const SFW_BODY = '少女站在雨夜的霓虹灯下，长发被风吹起，望着远处的高楼。';
// NSFW 正文（含内置判定词：裸体）
const NSFW_BODY = '她解开衣扣，露出裸体的上身，两人的唇贴在一起，忘情地吻着。';
// NSFW 正文（英文判定词：explicit）
const NSFW_BODY_EN = 'The two of them engaged in explicit acts on the bed.';

const cfgOn = {
    nsfw_enabled: true,
    nsfw_base_url: 'https://example-nai-relay.example.com',
    nsfw_upstream_type: 'nai',
    nsfw_prompt_format: 'tags',
    nsfw_words: '',
};
const cfgOff = { ...cfgOn, nsfw_enabled: false };
const cfgNoUrl = { ...cfgOn, nsfw_base_url: '' };

// ── 1. 判定 ──
ok('普通正文不命中分流（开关开）', directDivertDecide(cfgOn, SFW_BODY) === false);
ok('NSFW 正文命中分流（中文词：裸体）', directDivertDecide(cfgOn, NSFW_BODY) === true);
ok('NSFW 正文命中分流（英文词：explicit）', directDivertDecide(cfgOn, NSFW_BODY_EN) === true);
ok('分流开关关闭时永不命中', directDivertDecide(cfgOff, NSFW_BODY) === false);
ok('分流地址为空时永不命中', directDivertDecide(cfgNoUrl, NSFW_BODY) === false);
ok('空正文不命中', directDivertDecide(cfgOn, '') === false);

// ── 2. 分流通道形态解析 ──
const route = divertRoute(cfgOn);
ok('分流通道形态为 tags（nai + tags 默认）', route.mode === 'tags', route);
ok('分流通道地址就是 nsfw_base_url', route.baseUrl === cfgOn.nsfw_base_url);

// ── 3. 送出内容：必须取分析模型的标签，而不是散文 ──
const sendToNai = selectPrompt(analyzedItem, route.mode);
ok('分流送出去的是 Danbooru 标签串', sendToNai === analyzedItem.tags, sendToNai);
ok('标签串不含散文正文', !sendToNai.includes('张开了双腿') || sendToNai.length < 20, sendToNai);
ok('标签串含具体部位/动作标签（handjob）', sendToNai.includes('handjob'));
ok('标签串含具体动作标签（spread legs）', sendToNai.includes('spread legs'));

// 主通道形态：直出必须仍是 description（qwen 吃自然语言）
const mainMode = resolvePromptMode('auto', 'http://example-adapter.example.com', 'adapter');
ok('主通道形态为 description（adapter 上游）', mainMode === 'description', mainMode);

// ── 4. 边界：分析产物缺 tags 时（理论不发生，防呆）──
const noTags = { desc: '一段描述', tags: '' };
const fallback = selectPrompt(noTags, 'tags');
ok('分析产物缺 tags 时回退 desc（防呆，不送空串）', fallback === '一段描述');

// ── 5. 判定词表 ──
ok('自定义词表可扩展（加 topless 命中）', detectNsfw('她只穿着 topless 的短衣', 'topless') === true);
ok('内置词 nsfw 命中', detectNsfw('this image is nsfw', '') === true);
ok('词表解析支持中英文逗号分号', parseWords('a，b;c,d').join(',') === 'a,b,c,d');

// ── 6. 命中分流后的选图要求：交给分析模型语义判断，而不是关键词硬挑段 ──
// 用户场景：正文前段聊日常、中段/后段才是真正的成人画面 —— 但位置不是固定的，
// 也可能通篇都是成人内容。因此命中分流后只告诉分析模型「本次是 NSFW」，由它自己判断
// 哪一刻才是真正的成人时刻并据此选图，禁止为了「画面感」去选日常铺垫。
const MIXED_BODY = [
    '两人在咖啡馆里聊着最近的工作，气氛轻松，窗外的阳光洒在桌面上。',
    '',
    '她解开衣扣，露出裸体的上身，两人的唇贴在一起，忘情地吻着。',
    '',
    '夜色渐深，他们相拥而卧，房间里只剩床头灯的光。',
].join('\n');

ok('命中分流判定：整段正文任一位置命中即分流', detectNsfw(MIXED_BODY, cfgOn.nsfw_words) === true);
ok('普通正文不命中分流', detectNsfw(SFW_BODY, cfgOn.nsfw_words) === false);

// ── 7. nsfw 指令拼进分析请求（语义判断，不预选段）──
const nsfwParts = buildAnalysisParts(MIXED_BODY, '', 1, { nsfw: true });
ok('nsfw 指令拼进 user 消息：标注本次为成人向', nsfwParts.user.includes('成人向（NSFW）'));
ok('nsfw 指令拼进 user 消息：要求自行判断成人时刻', nsfwParts.user.includes('自行判断'));
ok('nsfw 指令拼进 user 消息：禁止选日常铺垫', nsfwParts.user.includes('日常铺垫'));
ok('nsfw 指令拼进 user 消息：正文仍完整下发', nsfwParts.user.includes('咖啡馆'));
ok('nsfw 指令拼进 user 消息：不预选任何段落', !nsfwParts.user.includes('必须选图的段落'));
const plainParts = buildAnalysisParts(MIXED_BODY, '', 1, {});
ok('无 nsfw 时 user 消息不含 NSFW 指令', !plainParts.user.includes('成人向（NSFW）'));
ok('无 nsfw 时 user 消息不含 NSFW 指令（语义判断句）', !plainParts.user.includes('自行判断'));

// ── 8. 混合模式（nsfw_mix = daily_nsfw / nsfw_only）──
const mixDaily = buildAnalysisParts(MIXED_BODY, '', 2, { nsfw: true, nsfwMix: 'daily_nsfw' });
ok('混合模式 daily_nsfw：要求 1 张日常 + 1 张成人', mixDaily.user.includes('1 张为日常画面') && mixDaily.user.includes('成人画面'), mixDaily.user.slice(0, 120));
ok('混合模式 daily_nsfw：日常位置默认 auto（自行挑）', mixDaily.user.includes('由你自行挑一个非成人时刻'));
const mixDailyFront = buildAnalysisParts(MIXED_BODY, '', 2, { nsfw: true, nsfwMix: 'daily_nsfw', nsfwDailyPlace: 'front' });
ok('混合模式 daily_nsfw + front：日常取自正文前段', mixDailyFront.user.includes('取自正文前段'));
const mixDailyEnd = buildAnalysisParts(MIXED_BODY, '', 2, { nsfw: true, nsfwMix: 'daily_nsfw', nsfwDailyPlace: 'end' });
ok('混合模式 daily_nsfw + end：日常取自正文后段', mixDailyEnd.user.includes('取自正文后段'));
const mixNsfwOnly = buildAnalysisParts(MIXED_BODY, '', 2, { nsfw: true, nsfwMix: 'nsfw_only' });
ok('混合模式 nsfw_only：全部必须是成人画面', mixNsfwOnly.user.includes('全部必须是成人画面'));
// daily_nsfw 但 nsfw_max=1 → 退化为只出 NSFW（走单张分支）
const mixDailyOne = buildAnalysisParts(MIXED_BODY, '', 1, { nsfw: true, nsfwMix: 'daily_nsfw' });
ok('daily_nsfw + 1 张：退化为单张 NSFW 指令', mixDailyOne.user.includes('真正发生亲密 / 成人行为的那一个时刻'));

// ── 9. qwen 直出多张：按段切分（splitProseChunks）──
const CHUNK_BODY = '第一段：咖啡馆闲聊。\n\n第二段：她解开了衣扣。\n\n第三段：夜色相拥而卧。\n\n第四段：清晨醒来。';
const chunks2 = splitProseChunks(CHUNK_BODY, 2);
ok('切分 2 份：得到 2 段', chunks2.length === 2, chunks2);
ok('切分 2 份：第 1 份含前段内容', chunks2[0].includes('咖啡馆'));
ok('切分 2 份：第 2 份含后段内容', chunks2[1].includes('清晨'));
const chunks4 = splitProseChunks(CHUNK_BODY, 4);
ok('切分 4 份（段落数=份数）：每段一份', chunks4.length === 4);
const chunks6 = splitProseChunks(CHUNK_BODY, 6);
ok('切分 6 份（段落数<份数）：按实际段数出', chunks6.length === 4);
ok('切分空正文：返回空数组', splitProseChunks('', 2).length === 0);
ok('切分单段正文：返回单段', splitProseChunks('只有一段。', 3).length === 1);

// ── 10. 多张直出标记落位（applyProseMarkers）：每张插到对应段落下 ──
const markItems = [
    { prose: '画面甲', at: CHUNK_BODY.indexOf('第二段') },
    { prose: '画面乙', at: CHUNK_BODY.indexOf('第三段') },
];
const placed = applyProseMarkers(CHUNK_BODY, markItems);
ok('多标记落位：第一段后插入画面甲', placed.includes('咖啡馆闲聊。\n\n[ILLUST: 画面甲]'), placed);
ok('多标记落位：第二段后插入画面乙', placed.includes('衣扣。\n\n[ILLUST: 画面乙]'), placed);
ok('多标记落位：正文内容完整保留', placed.includes('清晨醒来'));
const placedEmpty = applyProseMarkers(CHUNK_BODY, []);
ok('多标记落位：无 items 原样返回', placedEmpty === CHUNK_BODY);
const placedAtEnd = applyProseMarkers('只有一段。', [{ prose: '图', at: -1 }]);
ok('多标记落位：at 越界挂末尾', placedAtEnd.endsWith('[ILLUST: 图]'), placedAtEnd);

console.log(`\nRESULT: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
