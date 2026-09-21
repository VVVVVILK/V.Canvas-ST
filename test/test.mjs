// V.Canvas offline self-test.
//
// Boots a fake NovelAI-protocol service on 127.0.0.1:18999 and exercises the whole
// "NAI protocol -> ZIP -> base64" path plus every marker parsing / inline-replace branch.
// No SillyTavern needed.
//
//   1) python make_fixtures.py
//   2) node test.mjs
//
// JSZip comes from the SillyTavern install (the extension never bundles its own copy).
// Set ST_JSZIP to point at it; otherwise the usual install locations are probed.
// Report labels are ASCII on purpose: the Windows console codepage mangles CJK output.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

globalThis.window = globalThis; // 模拟浏览器：酒馆页面里 window.JSZip 由 <script> 提前挂好

const here = path.dirname(fileURLToPath(import.meta.url));
const zipBytes = fs.readFileSync(path.join(here, 'image_0.zip'));
const pngBytes = fs.readFileSync(path.join(here, 'image_0.png'));

const jszipPath = [
    process.env.ST_JSZIP,
    // installed copy -> <ST>/data/default-user/extensions/<ext>/test/
    path.resolve(here, '../../../../../public/lib/jszip.min.js'),
    path.resolve(here, '../../../public/lib/jszip.min.js'),
].filter(Boolean).find((p) => fs.existsSync(p));
if (!jszipPath) {
    console.error('[fatal] JSZip not found. Run with ST_JSZIP=<path/to/jszip.min.js>.');
    process.exit(2);
}
await import(pathToFileURL(jszipPath).href);

const mode = { value: 'zip' };
let lastPayload = null;
let lastQuery = '';
let lastAuth = '';

const server = http.createServer((req, res) => {
    if (req.url === '/ai/user/subscription') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ tier: 0, active: true, subscription: { tier: 0, active: true, expiresAt: 0 } }));
        return;
    }
    if (req.url.startsWith('/ai/generate-image')) {
        lastQuery = req.url;
        lastAuth = String(req.headers.authorization ?? '');
        let body = '';
        req.on('data', c => { body += c; });
        req.on('end', () => {
            lastPayload = JSON.parse(body);
            // V.Adapter 在 expand=1 时会把实际送入上游的提示词与状态放在响应头上回传
            const extra = /[?&]expand=1(?:&|$)/.test(req.url)
                ? {
                    'X-Illust-Via': 'images',
                    'X-Illust-Expand': 'ok',
                    'X-Illust-Prompt': encodeURIComponent('扩写后的中文提示词 long form'),
                }
                : {};
            switch (mode.value) {
                case 'zip': res.writeHead(200, { 'Content-Type': 'application/zip', ...extra }); res.end(zipBytes); break;
                case 'raw': res.writeHead(200, { 'Content-Type': 'image/png', ...extra }); res.end(pngBytes); break;
                case 'err': res.writeHead(502, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'CONTENT_POLICY_REJECTED', statusCode: 502 })); break;
                case 'json200': res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ message: 'CIRCUIT_OPEN' })); break;
                case 'empty': res.writeHead(200, { 'Content-Type': 'application/zip' }); res.end(Buffer.alloc(0)); break;
                case 'b64': res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ data: [{ b64_json: pngBytes.toString('base64') }] })); break;
                case 'neko': res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ images: [{ image: pngBytes.toString('base64'), index: 0, seed: 0 }] })); break;
                default: res.writeHead(500); res.end('nope');
            }
        });
        return;
    }
    res.writeHead(404);
    res.end('nope');
});

await new Promise(r => server.listen(18999, '127.0.0.1', r));

const { generateIllustration, testConnection } = await import('../lib/nai-api.js');
const { findMarkers, buildDisplayText, stripMarkers, hasMarkers, effectiveSource, resolvePromptMode, selectPrompt, isLocalUpstream, MAX_MARKER_LEN, redistributeMarkers, isTailClustered } = await import('../lib/marker.js');
const { detectNsfw, parseWords, buildWordList } = await import('../lib/nsfw.js');
const { parseAnalysisJSON, applyMarkers, findAnchor, buildAnalysisMessages, buildAnalysisParts, analysisTokenBudget, resolveCtxSource, directAppliesTo, buildDirectProse, proseToMarker, applyProseMarker, DIRECT_PROSE_MAX, DIRECT_GUIDE, pickProseAnchor } = await import('../lib/analysis.js');
const { artistAppliesTo, artistPromptFor, withArtistPrompt, sanitizeArtistPrompt, sanitizeArtistName, ARTIST_PROMPT_MAX } = await import('../lib/artist.js');

let pass = 0, fail = 0;
const report = [];
function ok(name, cond, extra = '') {
    if (cond) { pass++; report.push(`[OK]   ${name}`); }
    else { fail++; report.push(`[FAIL] ${name} :: ${extra}`); }
}

report.push(`JSZip loaded: ${typeof globalThis.JSZip}`);
report.push('', '== marker.js ==');

const SRC = 'A\n[ILLUST: one | 1girl]\nB\n[ILLUST: two | 2girls]\nC';
{
    const a = findMarkers('X\n\n[ILLUST: a girl on a neon street | 1girl, silver hair, neon] \n\nY');
    ok('single standard marker', a.length === 1);
    ok('tags win over description', a[0]?.prompt === '1girl, silver hair, neon', JSON.stringify(a[0]));
    ok('exact start/end offsets', a[0] && 'X\n\n[ILLUST: a girl on a neon street | 1girl, silver hair, neon] \n\nY'.slice(a[0].start, a[0].end) === a[0].raw, JSON.stringify(a[0]));

    const b = findMarkers('[ILLUST\uFF1Aa rainy roof]\nx');
    ok('full-width colon + no pipe -> desc fallback', b.length === 1 && b[0].prompt === 'a rainy roof', JSON.stringify(b));

    const c = findMarkers('[ILLUST:   spaced   out   |   a,  b ,c  ]');
    ok('extra spaces normalised', c.length === 1 && c[0].desc === 'spaced out' && c[0].tags === 'a, b ,c', JSON.stringify(c));

    const d = findMarkers('[ILLUST:\nCN desc | 1girl\n]');
    ok('newline inside marker tolerated', d.length === 1 && d[0].prompt === '1girl', JSON.stringify(d));

    ok('no marker -> empty', findMarkers('plain text, nothing here.').length === 0);
    ok('hasMarkers quick check', hasMarkers('x [ILLUST: y] z') && !hasMarkers('x y z'));

    const multi = findMarkers(SRC);
    ok('two markers numbered in order', multi.length === 2 && multi[0].index === 0 && multi[1].index === 1, JSON.stringify(multi.map(m => m.index)));

    const dt = buildDisplayText(SRC, ['/api/images/a.png', null]);
    ok('inline replace below its own paragraph', dt === 'A\n\n![Illustration](/api/images/a.png)\n\nB\n[ILLUST: two | 2girls]\nC', JSON.stringify(dt));

    // ── URL 含空格/括号时必须编码，否则 Markdown 解析失败、图片以纯文本显示 ──
    {
        const spaced = buildDisplayText(SRC, ['/user/images/Sample Character/a b(1).png', null]);
        const m = (spaced || '').match(/!\[[^\]]*\]\(([^)]*)\)/);
        ok('markdown url with spaces/parens gets encoded', !!m && m[1].length > 0 && !/\s|\(/.test(m[1]) && m[1].includes('%20'), m && m[1]);
        ok('encoded url still points at the same file', !!m && decodeURIComponent(m[1]) === '/user/images/Sample Character/a b(1).png', m && m[1]);
    }
    ok('no triple newline leftover', !!dt && !/\n{3,}/.test(dt), JSON.stringify(dt));
    ok('failed marker left untouched', !!dt && dt.includes('[ILLUST: two | 2girls]'));
    ok('all failed -> null', buildDisplayText(SRC, [null, null]) === null);

    // ── pending='drop'：未出图的标记必须从显示层移除，不得把提示词漏进正文 ──
    // 第一张出图后若保留第二张的标记原文，数百字提示词会直接摊在聊天里，
    // 观感是「图没出来、只冒出一堆文字」，而实际上第一张已经生成完毕。
    {
        const one = buildDisplayText(SRC, ['/api/images/a.png', null], 'Illustration', 'drop');
        ok('drop: finished image is kept', !!one && one.includes('![Illustration](/api/images/a.png)'));
        ok('drop: pending marker removed, prompt text does not leak', !!one && !one.includes('ILLUST'), JSON.stringify(one));
        ok('drop: prose before and after the pending marker survives', !!one && one.includes('A') && one.includes('B') && one.includes('C'), JSON.stringify(one));
        ok('drop: paragraphs are not glued together', !!one && /B\nC/.test(one), JSON.stringify(one));

        const none = buildDisplayText(SRC, [null, null], 'Illustration', 'drop');
        ok('drop: nothing ready yet -> clean prose without markers', !!none && !none.includes('ILLUST') && none.includes('A') && none.includes('C'), JSON.stringify(none));
    }

    const stripped = stripMarkers(SRC);
    ok('stripMarkers removes markers, no leftover blank lines', !stripped.includes('ILLUST') && !/\n{3,}/.test(stripped), JSON.stringify(stripped));
    ok('stripMarkers idempotent', stripMarkers(stripped) === stripped);
    ok('stripMarkers keeps surrounding prose', stripped.startsWith('A') && stripped.endsWith('C'), JSON.stringify(stripped));
}

report.push('', '== prompt format (prompt_format) ==');
{
    // 链路分流：本地适配服务（经 V.Adapter）走描述，其余走标签
    ok('auto + local adapter -> description', resolvePromptMode('auto', 'http://127.0.0.1:8888') === 'description');
    ok('auto + localhost -> description', resolvePromptMode('auto', 'http://localhost:8888') === 'description');
    ok('auto + official NAI -> tags', resolvePromptMode('auto', 'https://image.novelai.net') === 'tags');
    ok('auto + NAI gateway -> tags', resolvePromptMode('auto', 'https://example-nai-gateway.example.com') === 'tags');
    ok('auto + empty base -> tags', resolvePromptMode('auto', '') === 'tags');
    ok('explicit modes win over auto', resolvePromptMode('description', 'https://image.novelai.net') === 'description'
        && resolvePromptMode('tags', 'http://127.0.0.1:8888') === 'tags'
        && resolvePromptMode('both', '') === 'both');
    ok('unknown value falls back to auto behaviour', resolvePromptMode('nope', 'http://127.0.0.1:8888') === 'description');
    ok('isLocalUpstream detects adapter port', isLocalUpstream('http://127.0.0.1:8888') && !isLocalUpstream('https://image.novelai.net'));

    // ── 上游类型显式声明（upstream_type）──
    // 地址区分不了「远端部署的适配服务」与「第三方 NAI 网关」—— 两者都是远程域名。
    // 部署在 VPS 上的适配服务会被误判成标签上游，只能由使用者声明。
    const REMOTE_ADAPTER = 'https://novelai-ln.example.cfd';
    ok('auto + remote adapter -> tags (the misjudgement this fixes)',
        resolvePromptMode('auto', REMOTE_ADAPTER) === 'tags');
    ok('declared adapter wins over a remote address',
        resolvePromptMode('auto', REMOTE_ADAPTER, 'adapter') === 'description');
    ok('declared nai wins over a local address',
        resolvePromptMode('auto', 'http://127.0.0.1:8888', 'nai') === 'tags');
    ok('declared adapter does not override an explicit format',
        resolvePromptMode('tags', REMOTE_ADAPTER, 'adapter') === 'tags');
    ok('declared nai does not override an explicit format',
        resolvePromptMode('description', 'https://image.novelai.net', 'nai') === 'description');
    ok('unknown upstream type falls back to address guessing',
        resolvePromptMode('auto', 'http://127.0.0.1:8888', 'whatever') === 'description'
        && resolvePromptMode('auto', REMOTE_ADAPTER, 'whatever') === 'tags');

    const full = { desc: 'a knight in old chainmail', tags: '1boy, chainmail, sword' };
    ok('selectPrompt description', selectPrompt(full, 'description') === 'a knight in old chainmail');
    ok('selectPrompt tags', selectPrompt(full, 'tags') === '1boy, chainmail, sword');
    ok('selectPrompt both keeps desc first', selectPrompt(full, 'both') === 'a knight in old chainmail, 1boy, chainmail, sword');

    const onlyDesc = { desc: 'a rainy roof', tags: '' };
    const onlyTags = { desc: '', tags: '1girl, neon' };
    ok('missing tags -> description falls back to desc', selectPrompt(onlyTags, 'description') === '1girl, neon');
    ok('missing desc -> tags falls back to tags', selectPrompt(onlyDesc, 'tags') === 'a rainy roof');
    ok('missing desc -> both keeps the present half', selectPrompt(onlyDesc, 'both') === 'a rainy roof');
    ok('empty marker -> empty string', selectPrompt({ desc: '', tags: '' }, 'both') === '');

    // 标记的两半分别对应两类上游：解析结果须与 findMarkers 的字段对得上
    const mk = findMarkers('[ILLUST: a knight in old chainmail | 1boy, chainmail, sword]')[0];
    ok('marker exposes both halves', mk.desc === 'a knight in old chainmail' && mk.tags === '1boy, chainmail, sword');
    ok('local pipeline gets the description', selectPrompt(mk, resolvePromptMode('auto', 'http://127.0.0.1:8888')) === mk.desc);
    ok('direct pipeline gets the tags', selectPrompt(mk, resolvePromptMode('auto', 'https://image.novelai.net')) === mk.tags);
}

report.push('', '== analysis.js（上下文出图）==');
{
    // ── 解析：容忍各种包裹形式 ──
    const one = parseAnalysisJSON('{"images":[{"desc":"a girl","tags":"1girl","anchor":"她站在窗前"}]}');
    ok('plain JSON parsed', one.length === 1 && one[0].desc === 'a girl' && one[0].tags === '1girl', JSON.stringify(one));

    const fenced = parseAnalysisJSON('```json\n{"images":[{"desc":"d","tags":"t","anchor":"a"}]}\n```');
    ok('markdown fence tolerated', fenced.length === 1, JSON.stringify(fenced));

    const chatty = parseAnalysisJSON('好的，以下是结果：\n{"images":[{"desc":"d","tags":"t","anchor":"a"}]}\n希望有帮助。');
    ok('surrounding prose tolerated', chatty.length === 1, JSON.stringify(chatty));

    const topArr = parseAnalysisJSON('[{"desc":"d1","tags":"t1"},{"desc":"d2","tags":"t2"}]');
    ok('top-level array tolerated', topArr.length === 2, JSON.stringify(topArr));

    ok('empty list -> []', parseAnalysisJSON('{"images":[]}').length === 0);
    ok('garbage -> []', parseAnalysisJSON('not json at all').length === 0);
    ok('entry without desc/tags dropped', parseAnalysisJSON('{"images":[{"anchor":"x"}]}').length === 0);
    ok('capped at 6', parseAnalysisJSON(JSON.stringify({ images: new Array(9).fill({ desc: 'd', tags: 't' }) })).length === 6);

    // ── 定位 ──
    const SRC2 = '第一段没有画面。\n她站在雨夜的窗前，看着霓虹。\n第三段也是。';
    ok('anchor found verbatim', findAnchor(SRC2, '她站在雨夜的窗前，看着霓虹。') >= 0);
    ok('anchor found with collapsed whitespace', findAnchor(SRC2, '她站在雨夜的窗前，\n看着霓虹。') >= 0);
    ok('missing anchor -> -1', findAnchor(SRC2, '这句话根本不存在') === -1);

    // ── 插入 ──
    const items = [
        { desc: 'a girl by the window', tags: '1girl, night, neon', anchor: '她站在雨夜的窗前，看着霓虹。' },
        { desc: 'a cat on the roof', tags: 'cat, roof', anchor: '这句话不存在' },
    ];
    const withMarkers = applyMarkers(SRC2, items);
    const mk = findMarkers(withMarkers);
    ok('two markers produced', mk.length === 2, JSON.stringify(withMarkers));
    ok('anchored marker sits right under its paragraph',
        withMarkers.indexOf('她站在雨夜的窗前，看着霓虹。\n[ILLUST:') > 0, JSON.stringify(withMarkers));
    ok('unmatched anchor appended at the tail',
        withMarkers.trimEnd().endsWith('[ILLUST: a cat on the roof | cat, roof]'), JSON.stringify(withMarkers));
    ok('marker carries both halves', mk[0].desc === 'a girl by the window' && mk[0].tags === '1girl, night, neon', JSON.stringify(mk[0]));

    // 破坏标记语法的字符要被清掉
    const dirty = applyMarkers(SRC2, [{ desc: 'a | b ] c', tags: 'x]|y', anchor: '' }]);
    const dMarker = dirty.match(/\[ILLUST:[^\]]*\]/)?.[0] ?? '';
    ok('pipe/bracket sanitised out of marker body', findMarkers(dirty).length === 1, JSON.stringify(dirty));
    ok('marker keeps exactly one pipe as the separator', dMarker.split('|').length === 2, dMarker);
    ok('marker body free of stray brackets', !dMarker.slice(1, -1).includes(']'), dMarker);

    ok('no items -> text unchanged', applyMarkers(SRC2, []) === SRC2);
    ok('empty text -> unchanged', applyMarkers('', items) === '');
    ok('same anchor used twice inserted once', findMarkers(applyMarkers(SRC2, [items[0], items[0]])).length === 1);

    // ── 长度回归：分析模型写长描述时，标记不能被 marker.js 的 MAX_MARKER_LEN(1200) 丢掉 ──
    {
        const longDesc = '很长的描述'.repeat(200);      // 1000 字
        const longTags = 'tag,'.repeat(200);           // 800 字
        const parsed = parseAnalysisJSON(JSON.stringify({ images: [{ desc: longDesc, tags: longTags, anchor: '第三段也是。' }] }));
        ok('long desc truncated by parse', parsed.length === 1 && parsed[0].desc.length <= 700, String(parsed[0]?.desc?.length));
        // 截断须回退到上一个逗号：不切断单词，且截断点后面紧跟原文的逗号
        const tg = parsed[0].tags;
        const ti = longTags.indexOf(tg);
        ok('long tags truncated at a comma boundary', tg.length <= 400 && ti === 0 && longTags[tg.length] === ',', tg.slice(-20) + ` len=${tg.length}`);

        const out = applyMarkers(SRC2, [{ desc: longDesc, tags: longTags, anchor: '第三段也是。' }]);
        const found = findMarkers(out);
        ok('long item still yields a usable marker (not silently dropped)', found.length === 1, JSON.stringify(out).slice(0, 200));

        // 记录耦合关系：超过 MAX_MARKER_LEN 的标记确实会被丢弃，所以上游必须自己收紧长度。
        // 长度由常量推导，改动上限时本断言自动跟随。
        const tooLong = `[ILLUST: ${'x'.repeat(MAX_MARKER_LEN)} | y]`;
        ok('oversized marker IS dropped by findMarkers (why analysis.js clamps)', findMarkers(tooLong).length === 0);

        // 1000 字描述 + 400 字标签在收紧后仍必须能被解析回来
        const big = applyMarkers(SRC2, [{ desc: longDesc, tags: longTags, anchor: '' }]);
        const bigMk = findMarkers(big);
        ok('clamped long marker survives findMarkers', bigMk.length === 1 && bigMk[0].desc.length >= 500, String(bigMk[0]?.desc?.length));
    }

    // ── 作品信息 / 画风要求 要进分析请求 ──
    {
        const msgs = buildAnalysisMessages('正文', '前文', 3, { work: '角色卡：示例角色', style: '示例画风' });
        const user = msgs[1].content;
        ok('work label included in the request', user.includes('【作品信息】') && user.includes('示例角色'), user.slice(0, 80));
        ok('style hint included in the request', user.includes('【画风要求】') && user.includes('示例画风'));
        ok('max propagated into the request', user.includes('本次最多输出 3 个画面'));
        const bare = buildAnalysisMessages('正文', '', 1);
        ok('empty meta adds no empty sections', !bare[1].content.includes('【作品信息】') && !bare[1].content.includes('【画风要求】'));
        const jbm = buildAnalysisMessages('正文', '', 1, { jb: 'TEST_JB_WORDS' });
        ok('jb prompt prepended to the request', jbm[1].content.startsWith('【附加说明】\nTEST_JB_WORDS'), JSON.stringify(jbm[1].content.slice(0, 40)));
        const jbEmpty = buildAnalysisMessages('正文', '', 1, { jb: '' });
        ok('empty jb adds no section', !jbEmpty[1].content.includes('【附加说明】'));    }

    // ── 与既有链路对接：标记 → 就地替换成图片 ──
    const dt2 = buildDisplayText(withMarkers, ['/api/images/a.png', null]);
    ok('analysis result renders as an inline image under the anchor paragraph',
        !!dt2 && dt2.includes('她站在雨夜的窗前，看着霓虹。\n\n![Illustration](/api/images/a.png)'), JSON.stringify(dt2));
    ok('the failed one stays as a marker', !!dt2 && dt2.includes('[ILLUST: a cat on the roof'));
    ok('stripping leaves clean prose', !stripMarkers(withMarkers).includes('ILLUST'), JSON.stringify(stripMarkers(withMarkers)));
}

report.push('', '== 分析来源与输出预算 ==');
{
    // 两条分析路径（跟随酒馆主 API / 自定义服务）共用同一份提示词与同一个预算，
    // 这里锁住「共用」这件事，避免以后改一处忘一处导致换来源后行为不一致。
    const meta = { work: '角色卡：示例角色', style: '示例画风', quality: 'Q', negative: 'N', jb: 'JB' };
    const parts = buildAnalysisParts('正文', '前文', 3, meta);
    const msgs = buildAnalysisMessages('正文', '前文', 3, meta);
    ok('buildAnalysisParts system matches buildAnalysisMessages', parts.system === msgs[0].content);
    ok('buildAnalysisParts user matches buildAnalysisMessages', parts.user === msgs[1].content);
    ok('buildAnalysisParts role shape is system+user only', msgs.length === 2 && msgs[0].role === 'system' && msgs[1].role === 'user');

    // 输出预算：随张数放大，且封顶 —— 超出上限会让上游截断 JSON，
    // 表现为「分析成功但一张图都不出」，因此上限与放大都要锁住。
    ok('budget grows with image count', analysisTokenBudget(2) > analysisTokenBudget(1));
    ok('budget for 1 image stays usable', analysisTokenBudget(1) === 1800, String(analysisTokenBudget(1)));
    ok('budget for max 6 images = 7800', analysisTokenBudget(6) === 7800, String(analysisTokenBudget(6)));
    // 上限只是保险：允许的 1~6 张都够不到它，越界输入才会被夹住。
    ok('budget capped at 8192 for out-of-range input', analysisTokenBudget(99) === 8192, String(analysisTokenBudget(99)));
    ok('budget tolerates junk input', analysisTokenBudget(undefined) === analysisTokenBudget(1) && analysisTokenBudget('x') === analysisTokenBudget(1));

    // 来源解析：决定本轮到底发不发请求，三种结果都要锁住。
    ok('source main wins by default', resolveCtxSource('main', {}) === 'main');
    ok('source unknown value falls back to main', resolveCtxSource('whatever', {}) === 'main');
    ok('source undefined falls back to main', resolveCtxSource(undefined, {}) === 'main');
    ok('source custom with url+model -> custom',
        resolveCtxSource('custom', { url: 'http://127.0.0.1:4000/v1', model: 'qwen3.8-max' }) === 'custom');
    ok('source custom missing model -> null',
        resolveCtxSource('custom', { url: 'http://127.0.0.1:4000/v1', model: '' }) === null);
    ok('source custom missing url -> null',
        resolveCtxSource('custom', { url: '', model: 'm' }) === null);
    ok('source custom with blank-only fields -> null',
        resolveCtxSource('custom', { url: '   ', model: '  ' }) === null);
}

report.push('', '== 正文直出（文生图）==');
{
    // ── 形态门控：本模式能否成立，全靠这一个判断 ──
    // 直连官方 NAI 时送出的是标签串，喂一整段中文散文等于喂噪料，必须挡住。
    ok('direct applies to description mode', directAppliesTo('description') === true);
    ok('direct applies to both mode', directAppliesTo('both') === true);
    ok('direct never applies to tags mode (official NAI)', directAppliesTo('tags') === false);
    ok('direct unknown mode does not apply', directAppliesTo('nope') === false && directAppliesTo(undefined) === false);

    // ── 载荷组装 ──
    // 内置作画指令固定打头：它顶替分析模型原本顺带做的「挑一个瞬间 / 按正文还原人物 /
    // 别把对话画进画面」，缺了它一整段带对话的正文容易画出拼贴怪。
    ok('built-in guide always leads', buildDirectProse('她推开门。').startsWith(DIRECT_GUIDE));
    ok('body always comes last', buildDirectProse('她推开门。').endsWith('她推开门。'));
    ok('empty body yields nothing to send', buildDirectProse('') === '' && buildDirectProse('   ') === '');
    ok('empty body with style still yields nothing', buildDirectProse('', { style: '厚涂' }) === '');
    ok('style sits between guide and body', buildDirectProse('正文', { style: '厚涂' }).includes('【画风】厚涂\n\n正文'));
    ok('quality follows style', buildDirectProse('正文', { style: '厚涂', quality: 'masterpiece' })
        .indexOf('【画风】厚涂') < buildDirectProse('正文', { style: '厚涂', quality: 'masterpiece' }).indexOf('【画质】masterpiece'));
    ok('user guide is appended after the built-in one',
        buildDirectProse('正文', { guide: '用广角镜头' }).indexOf(DIRECT_GUIDE) === 0
        && buildDirectProse('正文', { guide: '用广角镜头' }).includes('用广角镜头'));
    ok('work info is included', buildDirectProse('正文', { work: '角色卡：示例' }).includes('【作品信息】\n角色卡：示例'));
    // 负面提示词照常拼：它默认是空的，填了才算使用者主动选择，
    // 副作用由他自己权衡（真遇到把这一栏清空即可），不该由插件替他决定不给。
    ok('negative is passed through when filled',
        buildDirectProse('正文', { negative: 'lowres, bad anatomy' }).includes('【负面提示词】lowres, bad anatomy'));
    ok('empty negative adds nothing', buildDirectProse('正文', { negative: '   ' }) === buildDirectProse('正文'));
    ok('negative sits after quality', buildDirectProse('正文', { quality: 'Q', negative: 'N' })
        .indexOf('【画质】Q') < buildDirectProse('正文', { quality: 'Q', negative: 'N' }).indexOf('【负面提示词】N'));

    // 总长保护：指令 + 正文整体不得超过 DIRECT_PROSE_MAX，否则包成的标记会被整条丢弃
    // （表现为请求发了、图拿到了、正文什么都不显示，且零报错）。
    const bigBody = buildDirectProse('长'.repeat(9000));
    ok('guide + body stays within the prose limit', bigBody.length <= DIRECT_PROSE_MAX, String(bigBody.length));
    ok('very long body still yields a parseable marker', findMarkers(proseToMarker(bigBody)).length === 1);

    // ── 包成标记 ──
    // 刻意不带 `|` 段：findMarkers 的正则要求 `|` 之后至少一个非 `]` 字符，
    // `[ILLUST: x | ]` 会整条匹配不上 —— 静默吞掉、零报错。
    ok('prose to marker has no pipe segment', proseToMarker('正文') === '[ILLUST: 正文]');
    ok('empty prose yields no marker', proseToMarker('') === '' && proseToMarker('   ') === '');
    ok('pipe and brackets are neutralised', proseToMarker('a|b [c]') === '[ILLUST: a/b c]');
    ok('newlines collapse to spaces', proseToMarker('甲\n\n乙') === '[ILLUST: 甲 乙]');

    // ── 长度保护 ──
    // 超过 MAX_MARKER_LEN 的标记会被 findMarkers 整条丢弃，表现为「请求发出去了、
    // 图也拿到了、但正文里什么都不显示」，且全程零报错。这条必须锁死。
    const longMarker = proseToMarker('长'.repeat(5000));
    ok('overlong prose is truncated to fit the marker guard', longMarker.length <= MAX_MARKER_LEN, String(longMarker.length));
    ok('overlong marker still parses', findMarkers(longMarker).length === 1);
    ok('exactly-at-limit marker survives', findMarkers(proseToMarker('x'.repeat(DIRECT_PROSE_MAX))).length === 1);

    // ── 追加到正文末尾，且能被既有的显示链路消费 ──
    const body = '第一段。\n\n第二段。';
    const src = applyProseMarker(body, '第二段的内容');
    ok('prose marker appended at the end', src.endsWith('[ILLUST: 第二段的内容]'));
    ok('original body is untouched', src.startsWith(body));
    const ms = findMarkers(src);
    ok('exactly one marker in direct source', ms.length === 1);
    ok('marker desc is the prose', ms[0].desc === '第二段的内容');
    // 直出固定走 description 档，但标签档也必须能取到正文（否则送空串）。
    ok('selectPrompt(description) returns the prose', selectPrompt(ms[0], 'description') === '第二段的内容');
    ok('selectPrompt(tags) falls back to the prose', selectPrompt(ms[0], 'tags') === '第二段的内容');
    ok('selectPrompt(both) returns the prose', selectPrompt(ms[0], 'both') === '第二段的内容');
    ok('display text renders one image', /!\[Illustration\]\(img\)/.test(buildDisplayText(src, ['img'], 'Illustration', 'drop')));
    ok('empty prose leaves the body alone', applyProseMarker(body, '') === body);
    ok('empty body leaves it alone', applyProseMarker('', '正文') === '');

    // ── 落点：不经分析模型时，图不该永远挂在最底下 ──
    const rep = [
        '「你终于来了。」她说。',
        '夕阳把整条街染成橘红色，晾衣绳上的白衬衫被风吹得鼓起来，远处传来收摊的吆喝声。',
        '「抱歉，路上耽搁了。」',
        '他把肩上的旧帆布包放下，抬手指了指街角那家还亮着灯的面馆。',
    ].join('\n\n');

    ok('picks a paragraph, not the end', pickProseAnchor(rep) > 0 && pickProseAnchor(rep) < rep.length);
    // 判据是「去掉对白后剩下的叙述长度」—— 对白密集的段落不该被选中
    const chosen = rep.slice(0, pickProseAnchor(rep));
    ok('never lands on a pure-dialogue paragraph', !chosen.trimEnd().endsWith('」'));
    ok('lands after the longest narrative paragraph',
        chosen.includes('晾衣绳上的白衬衫被风吹得鼓起来'));

    ok('single paragraph -> no anchor (falls back to the end)', pickProseAnchor('只有一段话，没有空行。') === -1);
    ok('all-dialogue text -> no anchor', pickProseAnchor('「甲」\n\n「乙」\n\n「丙」') === -1);
    ok('empty text -> no anchor', pickProseAnchor('') === -1 && pickProseAnchor(null) === -1);

    const placed = applyProseMarker(rep, '正文载荷', pickProseAnchor(rep));
    const pm = findMarkers(placed);
    ok('placed marker still parses to exactly one', pm.length === 1);
    ok('placed marker sits between paragraphs, not at the end',
        placed.indexOf('[ILLUST:') < placed.length - 20 && placed.trimEnd().endsWith('面馆。'));
    ok('text before and after survives intact',
        placed.includes('她说。') && placed.includes('面馆。'));
    ok('explicit end placement still appends',
        applyProseMarker(rep, '载荷', -1).trimEnd().endsWith('[ILLUST: 载荷]'));
    ok('out-of-range index falls back to the end',
        applyProseMarker(rep, '载荷', 9999).trimEnd().endsWith('[ILLUST: 载荷]'));

    // 整条链路回环：正文 → 组装载荷 → 包成标记 → 追加 → 能被既有显示链路消费
    const e2e = applyProseMarker('正文内容', buildDirectProse('正文内容', {
        guide: 'G', work: 'W', style: '厚涂', quality: 'Q',
    }));
    ok('e2e: pick + place + parse works with a real shape',
        findMarkers(applyProseMarker(rep, buildDirectProse(rep, { style: '厚涂' }), pickProseAnchor(rep))).length === 1);
    ok('end-to-end direct source parses to exactly one marker', findMarkers(e2e).length === 1);
    ok('end-to-end marker survives the rehydrate count check',
        findMarkers(e2e).length === 1 && findMarkers(e2e)[0].desc.length > 0);
}

report.push('', '== 画师串 ==');
{
    const ART = '0.8::artist:yalmyu::, artist:sh_(shinh)';
    const presets = [
        { id: 'art_1', name: '厚涂', prompt: ART },
        { id: 'art_2', name: '赛璐璐', prompt: 'artist:foo' },
        { id: 'art_3', name: '空内容', prompt: '   ' },
    ];

    // ── 形态门控：本模块存在的全部理由，必须锁死 ──
    // 送自然语言描述时（经 V.Adapter 的 OpenAI 格式上游）拼画师名会污染描述，所以不拼。
    ok('description mode never applies the artist string', artistAppliesTo('description') === false);
    ok('tags mode applies it', artistAppliesTo('tags') === true);
    ok('both mode applies it', artistAppliesTo('both') === true);
    ok('unknown mode does not apply it', artistAppliesTo('nope') === false && artistAppliesTo(undefined) === false);

    ok('description: prompt passes through byte-for-byte',
        withArtistPrompt('a knight in old chainmail', ART, 'description') === 'a knight in old chainmail');
    ok('description: no leftover comma added',
        withArtistPrompt('x', ART, 'description') === 'x');
    ok('tags: artist string goes first',
        withArtistPrompt('1boy, sword', ART, 'tags') === ART + ', 1boy, sword');
    ok('both: same assembly as tags',
        withArtistPrompt('1boy, sword', ART, 'both') === withArtistPrompt('1boy, sword', ART, 'tags'));
    ok('tags + no artist selected -> unchanged',
        withArtistPrompt('1boy, sword', '', 'tags') === '1boy, sword');
    ok('tags + empty prompt -> artist only',
        withArtistPrompt('', ART, 'tags') === ART);
    ok('tags + whitespace prompt -> artist only',
        withArtistPrompt('   ', ART, 'tags') === ART);
    ok('null prompt treated as empty', withArtistPrompt(null, ART, 'tags') === ART);

    // ── 选中项的解析：三种「不生效」都要归到空串 ──
    ok('selected id resolves to its content', artistPromptFor(presets, 'art_1') === ART);
    ok('no selection -> empty', artistPromptFor(presets, '') === '');
    ok('undefined selection -> empty', artistPromptFor(presets, undefined) === '');
    // 悬空 id（条目已被删）：不生效，但扩展侧刻意不改写存储里的 id
    ok('dangling id -> empty', artistPromptFor(presets, 'art_gone') === '');
    ok('blank-only content -> empty', artistPromptFor(presets, 'art_3') === '');
    ok('non-array presets tolerated -> empty', artistPromptFor(null, 'art_1') === '');
    ok('junk entries skipped', artistPromptFor([null, { id: 'art_x' }], 'art_x') === '');

    // ── 清洗 ──
    ok('newlines and runs of spaces collapse to single spaces',
        sanitizeArtistPrompt('a,\n  b\t\tc') === 'a, b c');
    ok('artist prompt capped', sanitizeArtistPrompt('x'.repeat(ARTIST_PROMPT_MAX + 50)).length === ARTIST_PROMPT_MAX);
    ok('artist name trimmed', sanitizeArtistName('  厚涂写实  ') === '厚涂写实');
    ok('artist name capped at 60', sanitizeArtistName('n'.repeat(100)).length === 60);
    ok('multi-line artist string survives as one line',
        !withArtistPrompt('body', 'a,\nb', 'tags').includes('\n'));
}

report.push('', '== effectiveSource ==');
{
    const ORIG = 'A\n[ILLUST: one | 1girl]\nB';
    const st = { src: ORIG, urls: ['/api/images/a.png'] };

    const n = effectiveSource(ORIG, undefined);
    ok('no state -> mode new', n.mode === 'new' && n.src === ORIG);

    const sm = effectiveSource(ORIG, st);
    ok('unchanged text -> mode same', sm.mode === 'same' && sm.src === ORIG);

    const sm2 = effectiveSource(stripMarkers(ORIG), st);
    ok('marker already stripped -> mode same', sm2.mode === 'same' && sm2.src === ORIG);

    // continue: ST does mes += newText, and our previous pass stripped the marker out
    const appended = stripMarkers(ORIG) + '\nC\n[ILLUST: two | 2girls]';
    const ap = effectiveSource(appended, st);
    ok('continue/append -> source re-joined, old marker kept', ap.mode === 'append' && ap.src === ORIG + '\nC\n[ILLUST: two | 2girls]', JSON.stringify(ap));
    ok('append keeps old marker indices aligned', findMarkers(ap.src).length === 2 && findMarkers(ap.src)[0].prompt === '1girl' && findMarkers(ap.src)[1].prompt === '2girls');

    // swipe to a different reply -> whole text replaced
    const other = 'X\n[ILLUST: three | 3girls]\nY';
    const rs = effectiveSource(other, st);
    ok('swipe to another reply -> mode reset', rs.mode === 'reset' && rs.src === other);
}

report.push('', '== nai-api.js ==');
const BASE = { baseUrl: 'http://127.0.0.1:18999', apiKey: 'test-key-0000', model: '', width: 832, height: 1216, steps: 28, scale: 6, timeoutMs: 15000, negative: 'bad hands' };
{
    mode.value = 'zip';
    const r = await generateIllustration({ ...BASE, prompt: 'test' });
    ok('zip response -> base64 decodes to fixture png', Buffer.from(r.base64, 'base64').equals(pngBytes));
    ok('zip entry extension detected as png', r.extension === 'png', r.extension);
    ok('payload.input carries the prompt', lastPayload?.input === 'test');
    ok('payload sends negative_prompt', lastPayload?.parameters?.negative_prompt === 'bad hands');
    ok('payload sends the full NAI 4.x parameter set', lastPayload?.parameters?.params_version === 3
        && lastPayload?.parameters?.sampler === 'k_euler_ancestral'
        && lastPayload?.parameters?.noise_schedule === 'karras'
        && lastPayload?.parameters?.n_samples === 1);
    ok('payload mirrors input into v4_prompt.base_caption', lastPayload?.parameters?.v4_prompt?.caption?.base_caption === 'test');
    ok('payload no longer sends the legacy uc field', lastPayload?.parameters?.uc === undefined);
    ok('payload is NAI shape (action/parameters)', lastPayload?.action === 'generate' && lastPayload?.parameters?.width === 832 && lastPayload?.parameters?.steps === 28);
    ok('model field is passed through as user string', lastPayload?.model === '');
    ok('no expand -> plain endpoint path', lastQuery === '/ai/generate-image', lastQuery);
    ok('bearer key forwarded', lastAuth === 'Bearer test-key-0000', lastAuth);
    ok('response headers absent -> meta fields stay empty', r.prompt === '' && r.expand === '' && r.via === '');

    // expand：请求上游先把 input 扩写为完整画面提示词（V.Adapter 的非标准扩展参数）
    const rx = await generateIllustration({ ...BASE, prompt: '一只橘猫趴在窗台上' , expand: true });
    ok('expand=1 appended to the query string', lastQuery === '/ai/generate-image?expand=1', lastQuery);
    ok('expand still returns the image bytes', Buffer.from(rx.base64, 'base64').equals(pngBytes));
    ok('expanded prompt read back from response header (url-decoded)', rx.prompt === '扩写后的中文提示词 long form', rx.prompt);
    ok('expansion status + upstream kind read back', rx.expand === 'ok' && rx.via === 'images', JSON.stringify({ expand: rx.expand, via: rx.via }));
    ok('client text travels as input (expansion happens upstream)', lastPayload?.input === '一只橘猫趴在窗台上');

    mode.value = 'raw';
    const rxRaw = await generateIllustration({ ...BASE, prompt: 'x', expand: true });
    ok('expand also works on the bare-image path', Buffer.from(rxRaw.base64, 'base64').equals(pngBytes) && rxRaw.expand === 'ok');

    mode.value = 'raw';
    const r2 = await generateIllustration({ ...BASE, prompt: 't' });
    ok('bare image bytes recognised', Buffer.from(r2.base64, 'base64').equals(pngBytes) && r2.extension === 'png');

    mode.value = 'b64';
    const r3 = await generateIllustration({ ...BASE, prompt: 't' });
    ok('b64_json inside JSON recognised', Buffer.from(r3.base64, 'base64').equals(pngBytes));

    mode.value = 'neko';
    const rNeko = await generateIllustration({ ...BASE, prompt: 't' });
    ok('neko-style {images:[{image}]} recognised', Buffer.from(rNeko.base64, 'base64').equals(pngBytes));

    mode.value = 'err';
    let e1 = '';
    try { await generateIllustration({ ...BASE, prompt: 't' }); } catch (e) { e1 = e.message; }
    ok('non-2xx relays upstream message verbatim', e1 === 'CONTENT_POLICY_REJECTED', e1);

    mode.value = 'json200';
    let e2 = '';
    try { await generateIllustration({ ...BASE, prompt: 't' }); } catch (e) { e2 = e.message; }
    ok('HTTP 200 with JSON error still fails', e2 === 'CIRCUIT_OPEN', e2);

    mode.value = 'empty';
    let e3 = '';
    try { await generateIllustration({ ...BASE, prompt: 't' }); } catch (e) { e3 = e.message; }
    ok('empty body -> human error', e3.length > 0, e3);

    let e4 = '';
    try { await generateIllustration({ ...BASE, baseUrl: 'http://127.0.0.1:18998', prompt: 't' }); } catch (e) { e4 = e.message; }
    ok('unreachable -> tells user to start adapter / check CORS', e4.includes('CORS'), e4);

    let e5 = '';
    try { await generateIllustration({ ...BASE, baseUrl: '   ', prompt: 't' }); } catch (e) { e5 = e.message; }
    ok('blank baseUrl -> explicit error', e5.length > 0, e5);

    const tc = await testConnection({ baseUrl: BASE.baseUrl, apiKey: 'x' });
    ok('testConnection returns human text', tc.includes('0'), tc);
}

/* ── 标记落点矫正（模型把标记全甩在末尾时的兜底）── */
{
    const body = '第一段叙述，她推开木门走了进去。\n\n第二段叙述，雨声在屋檐上连绵不断。\n\n第三段叙述，烛火把两个人的影子拉得很长。\n\n第四段叙述，天亮之前谁都没有再说话。';
    const src = `${body}\n\n[ILLUST: 画面一 | 1girl, silver hair]\n\n[ILLUST: 画面二 | 2girls, candle]`;

    ok('tail cluster is detected', isTailClustered(src));

    const moved = redistributeMarkers(src);
    ok('redistribute returns a new text', typeof moved === 'string' && moved !== src);

    const ms = findMarkers(moved ?? '');
    ok('both markers survive redistribution', ms.length === 2, JSON.stringify(ms.map(m => m.index)));
    ok('markers keep their original order', ms.length === 2 && ms[0].start < ms[1].start);
    ok('first marker is no longer in the tail', ms.length === 2 && ms[0].start < (moved?.length ?? 0) * 0.75,
        JSON.stringify({ at: ms[0]?.start, len: moved?.length }));
    ok('prose is byte-for-byte unchanged', stripMarkers(moved ?? '') === stripMarkers(src));
    ok('marker count matches the original', findMarkers(moved ?? '').length === findMarkers(src).length);

    // 落点必须落在段落之间：图后面还得有正文，否则等于没搬
    const tail = moved?.slice(ms[1]?.end ?? 0) ?? '';
    ok('text still follows the last marker', tail.replace(/\s+/g, '').length > 0, JSON.stringify(tail));

    // 渲染出来后第一张图不应贴在整条消息的末尾
    const dt = buildDisplayText(moved ?? '', ['/img/a.png', '/img/b.png'], 'Illustration', 'drop');
    ok('first image is not the last thing in the message',
        !!dt && dt.indexOf('![Illustration](/img/a.png)') < dt.length - 60, JSON.stringify(dt?.slice(-80)));

    // 标记本来就分散的，一律不动
    const spread = `${body.slice(0, 20)}\n\n[ILLUST: 早 | 1girl]\n\n${body.slice(20, 60)}\n\n${body.slice(60)}`;
    ok('already-spread markers are left alone', redistributeMarkers(spread) === null);

    // 只有一段时无处可插，也不该改
    const single = '一整段没有空行的正文，后面跟着一个标记。[ILLUST: x | y]';
    ok('single paragraph -> no redistribution', redistributeMarkers(single) === null);
    ok('single paragraph is not even flagged', isTailClustered(single) === false);

    // 没有标记
    ok('no markers -> null', redistributeMarkers(body) === null);
    ok('no markers -> not flagged', isTailClustered(body) === false);

    // 单换行分段：只认空行会把整段算作「一段」，矫正会静默失效
    const nlBody = '第一段叙述，她推开木门。\n第二段叙述，雨声连绵不断。\n第三段叙述，烛火摇曳。\n第四段叙述，天亮之前无人说话。';
    const nlSrc = `${nlBody}\n[ILLUST: 画面 | 1girl]`;
    ok('single-newline body is flagged', isTailClustered(nlSrc) === true, JSON.stringify(nlSrc.slice(-40)));
    const nlMoved = redistributeMarkers(nlSrc);
    ok('single-newline body gets redistributed', typeof nlMoved === 'string');
    const nlMs = findMarkers(nlMoved ?? '');
    ok('single-newline: marker survives', nlMs.length === 1);
    ok('single-newline: marker is not at the end',
        nlMs.length === 1 && (nlMoved ?? '').slice(nlMs[0].end).replace(/\s+/g, '').length > 0,
        JSON.stringify((nlMoved ?? '').slice(-60)));
    // 单换行正文里插入独占一行的标记，删掉标记后会多出一次换行（插图上下留白），
    // 这是排版上不可避免的；要验证的是段落本身没被动过 —— 内容与顺序都还在。
    const paras = (s) => stripMarkers(s).split(/\n+/).map(x => x.trim()).filter(Boolean);
    ok('single-newline: every paragraph kept in order',
        JSON.stringify(paras(nlMoved ?? '')) === JSON.stringify(paras(nlSrc)),
        JSON.stringify(paras(nlMoved ?? '')) + ' vs ' + JSON.stringify(paras(nlSrc)));
}

/* ── 分流判定 ── */
{
    ok('plain safe prompt does not divert', detectNsfw('1girl, silver hair, neon street, raining', '') === false);
    ok('empty text does not divert', detectNsfw('', '') === false);
    ok('blank text does not divert', detectNsfw('   \n  ', '') === false);

    ok('builtin grading word hits', detectNsfw('1girl, nude, outdoors', '') === true);
    ok('upper case hits too', detectNsfw('NSFW scene', '') === true);
    ok('chinese grading word hits', detectNsfw('两个人裸体相拥', '') === true);

    // 词边界：包含关系不算命中，否则 asexual / nonnude 之类会被误判
    ok('substring inside a longer word does not hit', detectNsfw('asexual, nonnude', '') === false);

    ok('custom word list hits', detectNsfw('她穿着泳装走在沙滩上', '泳装') === true);
    ok('custom word list is additive', detectNsfw('1girl, bikini', 'bikini') === true);
    ok('unrelated custom word does not hit', detectNsfw('1girl, dress', 'bikini') === false);

    ok('word list parsing splits on comma', parseWords('a, b，c; d').length === 4, JSON.stringify(parseWords('a, b，c; d')));
    ok('word list drops blanks', parseWords('a,, ,b').length === 2);
    ok('builtin words are always present', buildWordList('').includes('nsfw'));
    ok('custom words are appended', buildWordList('zzz').includes('zzz'));
}

server.close();
report.push('', `RESULT: ${pass} passed / ${fail} failed`);
fs.writeFileSync(path.join(here, 'report.txt'), report.join('\n'), 'utf8');
console.log(report.join('\n'));
process.exit(fail ? 1 : 0);
