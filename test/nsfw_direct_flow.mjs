// nsfw_direct_flow.mjs — 直出模式命中分流条件的完整链路测试（离线模拟）。
//
// 复刻 runDirectPass / drawMarkers 里的分流判定与送出内容选择：
//   1. 直出正文（stripMarkers 后）→ detectNsfw 判定是否命中分流条件；
//   2. 命中 → 强制走分流通道（forceDivert），形态按分流通道解析（nai → tags）；
//   3. 分流通道送 selectPrompt(marker, 'tags') —— 取分析模型产物里的标签，而不是散文。
// 核心断言：NSFW 正文绝不把散文当标签送给 NAI；普通正文绝不误切。

import { detectNsfw, parseWords, buildWordList } from '../lib/nsfw.js';
import { resolvePromptMode, selectPrompt } from '../lib/marker.js';

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

console.log(`\nRESULT: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
