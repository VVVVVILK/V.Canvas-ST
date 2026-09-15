// nai-api.js — NovelAI 协议调用 + ZIP 解包。
//
// 硬约束：本扩展只实现 NovelAI 协议，
// 不实现、也不允许添加任何「OpenAI 兼容直连」代码路径。
//
// 请求：POST ${baseUrl}/ai/generate-image，Header `Authorization: Bearer <key>`，
//       Body 是 NovelAI 格式 JSON；响应是二进制 ZIP（内含一张图）。
// 出错：非 2xx + {"message": "..."}，要把 message 原样透传给用户。

const JSZIP_URL = '/lib/jszip.min.js'; // 酒馆自带（public/lib/jszip.min.js），不要自己塞库文件

let jsZipPromise = null;

// ensureJSZip 动态加载酒馆内置 JSZip（UMD，加载后挂在 window.JSZip）。
async function ensureJSZip() {
    if (window.JSZip) return window.JSZip;
    if (!jsZipPromise) {
        jsZipPromise = import(/* @vite-ignore */ JSZIP_URL)
            .then(() => window.JSZip)
            .catch(err => {
                jsZipPromise = null;
                throw new Error(`无法加载酒馆内置 JSZip（${JSZIP_URL}）：${err?.message ?? err}`);
            });
    }
    const JSZip = await jsZipPromise;
    if (!JSZip) throw new Error(`酒馆内置 JSZip 未挂到 window.JSZip（${JSZIP_URL}）`);
    return JSZip;
}

function bytesToBase64(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < u8.length; i += CHUNK) {
        bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
    }
    return btoa(bin);
}

function truncate(s, n) {
    const str = String(s ?? '');
    return str.length > n ? `${str.slice(0, n)}…` : str;
}

// extFromName 从 ZIP 条目名推断扩展名（必须是酒馆 MEDIA_EXTENSIONS 认可的值）。
function extFromName(name) {
    const m = /\.([a-z0-9]+)$/i.exec(String(name ?? ''));
    const ext = (m?.[1] ?? 'png').toLowerCase();
    if (ext === 'jpeg' || ext === 'jfif') return 'jpg';
    return ['png', 'jpg', 'webp', 'gif', 'bmp'].includes(ext) ? ext : 'png';
}

// extFromContentType 从 Content-Type 推断扩展名（image/png → png）。
function extFromContentType(ct) {
    const m = /^image\/([a-z0-9.+-]+)/.exec(String(ct ?? '').toLowerCase());
    if (!m) return null;
    const t = m[1];
    if (t === 'jpeg' || t === 'jfif') return 'jpg';
    return ['png', 'jpg', 'webp', 'gif', 'bmp', 'avif'].includes(t) ? t : null;
}

// sniff 识别裸图字节流（有些 NAI 兼容服务直接回图片而不是 ZIP）。
function sniffImage(bytes) {
    const u8 = new Uint8Array(bytes.slice(0, 12));
    if (u8.length >= 8 && u8[0] === 0x89 && u8[1] === 0x50 && u8[2] === 0x4e && u8[3] === 0x47) return 'png';
    if (u8.length >= 3 && u8[0] === 0xff && u8[1] === 0xd8 && u8[2] === 0xff) return 'jpg';
    if (u8.length >= 12 && String.fromCharCode(u8[0], u8[1], u8[2], u8[3]) === 'RIFF'
        && String.fromCharCode(u8[8], u8[9], u8[10], u8[11]) === 'WEBP') return 'webp';
    if (u8.length >= 6 && String.fromCharCode(u8[0], u8[1], u8[2]) === 'GIF') return 'gif';
    if (u8.length >= 2 && u8[0] === 0x42 && u8[1] === 0x4d) return 'bmp';
    return null;
}

// isZip 判断是不是 ZIP（PK\x03\x04 / PK\x05\x06 空包 / PK\x07\x08 分卷）。
function isZip(bytes) {
    const u8 = new Uint8Array(bytes.slice(0, 4));
    return u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b
        && (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07) && (u8[3] === 0x04 || u8[3] === 0x06 || u8[3] === 0x08);
}

// readErrorMessage 从非 2xx 响应中提取可读错误信息（NAI 协议为 {"message": "..."}）。
async function readErrorMessage(resp) {
    let text = '';
    try {
        text = await resp.text();
    } catch {
        return `NAI 服务返回 HTTP ${resp.status}`;
    }
    if (!text) return `NAI 服务返回 HTTP ${resp.status}（无响应体）`;
    try {
        const j = JSON.parse(text);
        const msg = j?.message ?? j?.error?.message ?? j?.error ?? j?.detail ?? j?.msg;
        if (msg) return String(msg);
    } catch {
        /* 不是 JSON，走下面的兜底 */
    }
    return `${truncate(text.replace(/\s+/g, ' '), 240)}（HTTP ${resp.status}）`;
}

// decodeHeader 读取 URL 编码的响应头（头值必须是 ASCII，故提示词按 URL 编码回传）。
function decodeHeader(v) {
    if (!v) return '';
    try {
        return decodeURIComponent(v);
    } catch {
        return String(v);
    }
}

/**
 * generateIllustration 调用一次 NAI 生图，返回 base64 与扩展名。
 * 任何失败均抛出 Error，且 message 一定为可读文本（用于 toastr 展示）。
 *
 * @param {object} p
 * @param {string} p.baseUrl   NAI 协议服务地址
 * @param {string} p.apiKey    Bearer key
 * @param {string} p.model     用户手填的模型字符串（可以为空）
 * @param {string} p.prompt    正向提示词 → input
 * @param {string} p.negative  负面提示词 → parameters.negative_prompt + v4_negative_prompt
 * @param {number} p.width
 * @param {number} p.height
 * @param {number} p.steps
 * @param {number} p.scale
 * @param {number} p.timeoutMs
 * @param {boolean} p.expand   true 时请求上游先把 input 扩写为完整画面提示词（V.Adapter 的 `?expand=1`
 *                             非标准扩展参数；未实现该参数的服务会忽略它，行为等同于 false）
 * @param {AbortSignal} [p.signal] 外部取消信号（面板的「终止」按钮），与内部超时叠加
 * @returns {Promise<{base64:string, extension:string, via?:string, expand?:string, prompt?:string}>}
 */
export async function generateIllustration({
    baseUrl, apiKey, model, prompt, negative,
    width = 832, height = 1216, steps = 28, scale = 6.0, timeoutMs = 300000, expand = false, signal,
} = {}) {
    const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
    // 同页面的 V.Adapter 扩展会挂出页面内调用桥。
    // 仅在「未填写服务地址」时才使用它：填了地址就一律按填写的地址走 HTTP，
    // 因为服务端与扩展各自持有独立配置，不可互相顶替。
    const pageBridge = typeof globalThis.__V_ADAPTER_NAI__ === 'function' ? globalThis.__V_ADAPTER_NAI__ : null;
    const usePageBridge = Boolean(pageBridge) && base === '';
    if (!base && !pageBridge) {
        throw new Error('未配置 NAI 服务地址：请在扩展设置里填写 NovelAI 协议服务地址（如 V.Adapter），或安装 V.Adapter 扩展以启用页面内直连');
    }
    const input = String(prompt ?? '').trim();
    if (!input) throw new Error('提示词为空，跳过出图');

    // 注意：此处发送的是完整的 NovelAI 4.x 参数集，而非最小集。
    // 仅发送 input/model/action/parameters{width,height,scale,steps,negative_prompt}
    // 会被第三方 NAI 网关以 `400 无效的请求` 拒绝（网关会强校验参数完整性）。
    // V.Adapter 只读取 input / width / height / negative_prompt，其余字段忽略，
    // 因此同一份 payload 可同时用于「官方 NAI / NAI 网关 / V.Adapter」三类上游。
    // 采样器与噪声表使用 NAI 默认值（Euler Ancestral + Karras）。
    const neg = String(negative ?? '').trim();
    const parameters = {
        params_version: 3,
        width,
        height,
        scale,
        sampler: 'k_euler_ancestral',
        steps,
        n_samples: 1,
        ucPreset: 0,
        qualityToggle: true,
        autoSmea: false,
        dynamic_thresholding: false,
        controlnet_strength: 1.0,
        legacy: false,
        add_original_image: false,
        cfg_rescale: 0,
        noise_schedule: 'karras',
        legacy_v3_extend: false,
        seed: 0,
        negative_prompt: neg,
        // 4.x 的主输入其实是 v4_prompt 结构（官方客户端都会带），base_caption 与 input 保持一致
        v4_prompt: {
            caption: { base_caption: input, char_captions: [] },
            use_coords: false,
            use_order: true,
        },
        v4_negative_prompt: {
            caption: { base_caption: neg, char_captions: [] },
            legacy_uc: false,
        },
    };
    const body = {
        input,
        model: String(model ?? ''),
        action: 'generate',
        parameters,
    };

    const ctrl = new AbortController();
    let timedOut = false;
    let cancelled = false;
    const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
    }, Math.max(5000, timeoutMs));
    // 外部取消（面板「终止」）：与内部超时叠加到同一个 AbortController 上。
    if (signal) {
        if (signal.aborted) {
            cancelled = true;
            ctrl.abort();
        } else {
            signal.addEventListener('abort', () => { cancelled = true; ctrl.abort(); }, { once: true });
        }
    }

    let resp;
    if (usePageBridge) {
        // ── 页面内调用 ──
        // 仅在未填写服务地址时启用。V.Adapter 与本扩展同处一个酒馆页面时，
        // 二者可直接以函数调用完成协议往返：不经过网络、不占用端口，
        // 也就不需要在 <SillyTavern>/plugins/ 下部署服务端组件。
        // 由此，两个扩展在任意酒馆（本机 / 服务器 / 移动端）安装后即可使用。
        let r;
        try {
            r = await pageBridge(body, { expand });
        } catch (err) {
            clearTimeout(timer);
            throw new Error(`V.Adapter 页面内调用失败：${err?.message ?? err}`);
        }
        if (!r || typeof r !== 'object') {
            clearTimeout(timer);
            throw new Error('V.Adapter 页面内调用返回了无效结果');
        }
        // 组装成与 HTTP 响应同构的对象，后续解析逻辑完全复用。
        const payload = (r.status === 200 && r.bytes)
            ? r.bytes
            : new TextEncoder().encode(JSON.stringify({ message: r.error || '页面内调用失败' }));
        resp = new Response(payload, {
            status: r.status || 502,
            headers: { 'Content-Type': r.contentType || 'application/octet-stream' },
        });
    } else {
        try {
            // expand 为非标准扩展参数：V.Adapter 收到后先做输入扩写；其他 NAI 服务会忽略查询串。
            const qs = expand ? '?expand=1' : '';
            resp = await fetch(`${base}/ai/generate-image${qs}`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${String(apiKey ?? '')}`,
                    'Content-Type': 'application/json',
                    'Accept': 'image/avif,image/webp,image/png,image/*;q=0.9,application/json;q=0.5',
                },
                body: JSON.stringify(body),
                signal: ctrl.signal,
            });
        } catch (err) {
            clearTimeout(timer);
            if (cancelled) throw new Error('已终止');
            if (timedOut) {
                throw new Error(`请求超时（${Math.round(timeoutMs / 1000)} 秒）：上游没在时限内返回，可在扩展设置里调大「超时时间」`);
            }
            // 填写的地址连不上时，若同页面存在 V.Adapter，则回退到页面内调用：
            // 这样未部署服务端组件的酒馆（服务器 / 移动端 / 新装的实例）也能直接出图。
            if (pageBridge) {
                try {
                    const r2 = await pageBridge(body, { expand });
                    if (r2 && typeof r2 === 'object' && r2.status === 200 && r2.bytes) {
                        resp = new Response(r2.bytes, {
                            status: 200,
                            headers: { 'Content-Type': r2.contentType || 'application/octet-stream' },
                        });
                    }
                } catch {
                    /* 回退失败：保留下面的原始连接错误 */
                }
            }
            if (!resp) {
                throw new Error(`连不上 NAI 服务（${base}）：${err?.message ?? err}。请确认适配服务已启动、地址正确，且允许跨域（CORS）；或安装 V.Adapter 扩展以启用页面内直连`);
            }
        }
    }

    if (!resp.ok) {
        clearTimeout(timer);
        throw new Error(await readErrorMessage(resp));
    }

    // V.Adapter 会把「实际送入上游的提示词」与扩写状态放在响应头上回传；
    // 标准 NAI 服务不提供这些头，取不到时为空字符串。
    const meta = {
        via: resp.headers.get('x-illust-via') ?? '',
        expand: resp.headers.get('x-illust-expand') ?? '',
        prompt: decodeHeader(resp.headers.get('x-illust-prompt')),
    };

    let bytes;
    try {
        bytes = await resp.arrayBuffer();
    } catch (err) {
        clearTimeout(timer);
        throw new Error(`读取响应体失败：${err?.message ?? err}`);
    }
    clearTimeout(timer);

    if (!bytes || bytes.byteLength === 0) {
        throw new Error('NAI 服务返回了空响应');
    }

    // ── ① 二进制图片流（Content-Type: image/*）→ 直接使用字节，不做解包 ──
    //    V.Adapter 在客户端声明 `Accept: image/*` 时直出 PNG/JPEG 字节（不套 ZIP）。
    const ctype = String(resp.headers.get('content-type') ?? '').toLowerCase();
    if (ctype.startsWith('image/')) {
        const ext = extFromContentType(ctype) ?? sniffImage(bytes) ?? 'png';
        return { base64: bytesToBase64(bytes), extension: ext, ...meta };
    }

    // ── ② 裸图字节流（部分服务 Content-Type 不准确，按文件魔数识别）──
    const rawExt = sniffImage(bytes);
    if (rawExt) {
        return { base64: bytesToBase64(bytes), extension: rawExt, ...meta };
    }

    // ── ③ ZIP（NovelAI 协议的标准响应格式；官方 NAI 与其他 NAI 服务走此分支）──
    if (isZip(bytes)) {
        let JSZip;
        try {
            JSZip = await ensureJSZip();
        } catch (err) {
            throw new Error(err?.message ?? String(err));
        }

        let zip;
        try {
            zip = await JSZip.loadAsync(bytes);
        } catch (err) {
            throw new Error(`ZIP 解压失败（响应可能被截断）：${err?.message ?? err}`);
        }

        const names = Object.keys(zip.files).filter(n => !zip.files[n].dir);
        if (!names.length) throw new Error('ZIP 里没有任何文件');
        const pick = names.find(n => /\.(png|jpe?g|jfif|webp|gif|bmp)$/i.test(n)) ?? names[0];

        let b64;
        try {
            b64 = await zip.files[pick].async('base64');
        } catch (err) {
            throw new Error(`读取 ZIP 内图片失败：${err?.message ?? err}`);
        }
        if (!b64) throw new Error('ZIP 内图片为空');
        return { base64: b64, extension: extFromName(pick), ...meta };
    }

    // ── ④ 兜底：可能是以 200 状态码返回的 JSON 错误 ──
    let text = '';
    try {
        text = new TextDecoder('utf-8').decode(bytes);
    } catch {
        /* ignore */
    }
    try {
        const j = JSON.parse(text);
        const msg = j?.message ?? j?.error?.message ?? j?.error ?? j?.detail;
        if (msg) throw new Error(String(msg));
        // 兼容少数服务将 base64 置于 JSON 中的情形，一并识别：
        //   OpenAI 生图口径  → { data: [{ b64_json }] }
        //   Neko 生图塔等中转 → { images: [{ image }] }（base64 PNG）
        const b64 = j?.data?.[0]?.b64_json
            ?? j?.images?.[0]?.b64_json
            ?? j?.images?.[0]?.image
            ?? j?.image
            ?? j?.b64_json;
        if (typeof b64 === 'string' && b64.length > 64) {
            return { base64: b64.replace(/^data:image\/\w+;base64,/, ''), extension: 'png', ...meta };
        }
    } catch (err) {
        if (err instanceof Error && err.message && !/JSON/i.test(err.message)) throw err;
    }

    throw new Error(`响应既不是 ZIP、也不是图片或可识别的 JSON：${truncate(text.replace(/\s+/g, ' '), 160)}`);
}

/**
 * testConnection 测试连接（对应 NAI 协议 GET /ai/user/subscription）。
 * @returns {Promise<string>} 成功时返回可读文本（含订阅档位）
 */
export async function testConnection({ baseUrl, apiKey, timeoutMs = 15000 } = {}) {
    const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) throw new Error('请先填写 NAI 服务地址');
    const ctrl = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, Math.max(3000, timeoutMs));
    let resp;
    try {
        resp = await fetch(`${base}/ai/user/subscription`, {
            method: 'GET',
            headers: { 'Authorization': `Bearer ${String(apiKey ?? '')}`, 'Accept': 'application/json' },
            signal: ctrl.signal,
        });
    } catch (err) {
        clearTimeout(timer);
        if (timedOut) throw new Error('连接超时：服务没有响应');
        throw new Error(`连不上 ${base}：${err?.message ?? err}`);
    }
    clearTimeout(timer);
    if (!resp.ok) throw new Error(await readErrorMessage(resp));
    let tier = '';
    try {
        const j = await resp.json();
        tier = j?.tier ?? j?.subscription?.tier ?? '';
    } catch {
        /* 不解析也不影响"通了"这个结论 */
    }
    return `连接正常${tier !== '' ? `（tier ${tier}）` : ''}`;
}
