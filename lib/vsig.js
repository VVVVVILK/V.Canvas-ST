// vsig.js — V站「专属密钥」签名（纯逻辑，不依赖酒馆，可脱离浏览器单测）。
//
// 背景：V站 发放两种密钥
//   · 通用密钥（40 位随机串，无前缀）：本站不验签，任何 NAI 客户端都可用，按通用额度扣减。
//   · 专属密钥（vcs_ 前缀）：必须携带签名，否则 V站 直接 403 且不降级到通用额度。
//     签名为 md5(密钥 + UTC 日期 + 共享盐)，服务端容忍 ±1 天（时区/时钟差异）。
//
// 本扩展的适配范围（方案第六节「最小侵入」）：
//   仅当密钥以 vcs_ 开头时，才在 NAI 请求里附加签名头 X-V-Sig。
//   其余情况（NovelAI 官方、任意第三方 A 实例 / 中转站）**行为完全不变**，不多发任何字段。
//
// 共享盐必须与目标 V站 config.json 的 exclusiveSalt 一致。
// 默认值对齐线上正式站点；自部署实例若改过盐，在扩展设置里填「专属签名盐」覆盖即可
// （盐轮换同理：改服务端 + 改这里，用户的密钥本身不受影响）。

/**
 * 兜底共享盐：仅在**取不到站点当前盐**时使用（离线、站点为旧版本尚未返回 salt 等）。
 *
 * ⚠️ 不要把盐当作固定常量依赖：站点一旦轮换 `exclusiveSalt`，写死在客户端里的旧值
 * 就会永远签不对。正常路径是运行时向站点拉取当前盐（见 fetchSalt），这里只作兜底。
 * 自部署实例可在扩展设置「专属签名盐」里强制指定，优先级最高。
 */
export const DEFAULT_EXCLUSIVE_SALT = '';

/* ---------------- 站点当前盐（运行时拉取，支持站点换盐） ---------------- */

const saltCache = new Map(); // base → 该站点当前盐

/**
 * fetchSalt 向站点查询它当前使用的共享盐（GET /ai/user/subscription 的 v.salt）。
 * 结果按站点地址缓存，一次会话内只问一次；失败返回 ''（调用方回退到兜底值）。
 *
 * 只有 vcs_ 专属密钥才会走到这里 —— 官方 NAI 与第三方中转不会多出任何请求。
 *
 * @param {string} baseUrl 站点 NAI 地址
 * @param {string} apiKey  Bearer key（该接口不验签，通用/专属均可查询）
 * @param {number} [timeoutMs]
 * @returns {Promise<string>} 站点当前盐；取不到时为空串
 */
export async function fetchSalt(baseUrl, apiKey, timeoutMs = 8000) {
    const base = String(baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!base) return '';
    if (saltCache.has(base)) return saltCache.get(base);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Math.max(2000, timeoutMs));
    try {
        const r = await fetch(`${base}/ai/user/subscription`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${String(apiKey ?? '')}`,
                'Accept': 'application/json',
            },
            signal: ctrl.signal,
        });
        if (r.ok) {
            const j = await r.json();
            const s = String(j?.v?.salt ?? j?.salt ?? '').trim();
            if (s) {
                saltCache.set(base, s);
                return s;
            }
        }
    } catch {
        /* 取不到就回退兜底值，不影响出图流程 */
    } finally {
        clearTimeout(timer);
    }
    return '';
}

/** 清空盐缓存（切换站点地址、或站点刚换过盐需要立即重取时调用） */
export function clearSaltCache(baseUrl) {
    if (baseUrl === undefined) saltCache.clear();
    else saltCache.delete(String(baseUrl).trim().replace(/\/+$/, ''));
}

/** 专属密钥前缀 */
export const EXCLUSIVE_PREFIX = 'vcs_';

/** 是否为 V站 专属密钥（只有它才需要签名） */
export function isExclusiveKey(key) {
    return String(key ?? '').trim().toLowerCase().startsWith(EXCLUSIVE_PREFIX);
}

/** UTC 日期字符串 YYYY-MM-DD（与服务端 utcDateStr 口径一致） */
export function utcDateStr(offsetDays = 0) {
    const d = new Date(Date.now() + Number(offsetDays || 0) * 86400000);
    return d.toISOString().slice(0, 10);
}

/* ---------------- MD5（浏览器端无 node:crypto，自带一份精简实现） ---------------- */

const S = [
    7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
];

// K[i] = floor(abs(sin(i+1)) * 2^32)，运行时算一次即可，避免硬编码抄错。
const K = new Array(64);
for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;

// MD5 的摘要按**小端**字节序输出：把 32 位状态字的低字节写在前面。
// （直接 toString(16) 会按大端输出，得到的字符串每组 4 字节是反的。）
function hex32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n >>> 0, true);
    let s = '';
    for (let i = 0; i < 4; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
}

/** md5Hex 计算字符串的 MD5（输入按 UTF-8 编码），返回 32 位小写十六进制。 */
export function md5Hex(text) {
    const msg = new TextEncoder().encode(String(text ?? ''));
    const len = msg.length;
    const bitLen = len * 8;
    // 填充：0x80 + 若干个 0x00，使长度 ≡ 56 (mod 64)，末 8 字节放原始位长（小端）
    const padLen = ((56 - ((len + 1) % 64)) + 64) % 64;
    const total = len + 1 + padLen + 8;
    const buf = new Uint8Array(total);
    buf.set(msg, 0);
    buf[len] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(total - 8, bitLen >>> 0, true);
    dv.setUint32(total - 4, Math.floor(bitLen / 4294967296), true);

    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    const M = new Int32Array(16);
    for (let off = 0; off < total; off += 64) {
        for (let i = 0; i < 16; i++) M[i] = dv.getInt32(off + i * 4, true);
        let A = a0, B = b0, C = c0, D = d0;
        for (let i = 0; i < 64; i++) {
            let F, g;
            if (i < 16) { F = (B & C) | (~B & D); g = i; }
            else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
            else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
            else { F = C ^ (B | ~D); g = (7 * i) % 16; }
            const t = (A + F + K[i] + (M[g] >>> 0)) >>> 0;
            A = D; D = C; C = B;
            B = (B + (((t << S[i]) | (t >>> (32 - S[i]))) >>> 0)) >>> 0;
        }
        a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    return hex32(a0) + hex32(b0) + hex32(c0) + hex32(d0);
}

/**
 * exclusiveSig 计算专属密钥的当日签名：md5(密钥 + UTC 日期 + 盐)。
 * @param {string} key  专属密钥（vcs_ 前缀）
 * @param {string} [salt] 共享盐；留空用内置默认值
 * @param {number} [offsetDays] 日期偏移（服务端容忍 ±1 天，正常调用不需要传）
 */
export function exclusiveSig(key, salt, offsetDays = 0) {
    return md5Hex(String(key ?? '') + utcDateStr(offsetDays) + String(salt || DEFAULT_EXCLUSIVE_SALT));
}

/* ---------------- 什么时候发签名 ---------------- */

/**
 * sigHeaders 需要附加到 NAI 请求上的签名头。
 *
 * 触发条件只有一个：密钥是 V站 专属密钥（vcs_ 前缀，见方案第六节）。
 * 其余情况 —— NovelAI 官方、任意第三方中转、V站 通用密钥 —— 一律返回空对象，
 * 请求头与本次改动之前**完全相同**，不新增任何字段。
 * （自定义头会触发 CORS 预检，绝不能无差别加给所有上游。）
 *
 * @param {string} key  Bearer key
 * @param {string} [salt] 共享盐覆盖值（自部署实例 / 盐轮换时用）
 * @param {{baseUrl?:string, mode?:'auto'|'off'}} [opt]
 *        mode='off' 为总闸：即便填了 vcs_ 密钥也不发签名（排障 / 回滚用）
 * @returns {Record<string,string>} 请求头片段（可直接展开进 fetch 的 headers）
 */
let warnedNoSalt = false;

export function sigHeaders(key, salt, opt = {}) {
    if (opt.mode === 'off') return {};
    const k = String(key ?? '').trim();
    if (!isExclusiveKey(k)) return {};

    const s = String(salt ?? '').trim() || DEFAULT_EXCLUSIVE_SALT;
    if (!s) {
        // 没盐就算不出正确签名，与其发一个必定被拒的错误值，不如干脆不发，
        // 并提示一次去填盐（V站 会回 403「需配合 V.Canvas」，与未开启时一致）。
        if (!warnedNoSalt) {
            warnedNoSalt = true;
            console.warn('[V.Canvas] 检测到 V站 专属密钥，但未配置「专属签名盐」：' +
                '请在扩展设置里填入该站点的盐，否则专属密钥会被 V站 拒绝（通用密钥不受影响）。');
        }
        return {};
    }
    return { 'X-V-Sig': exclusiveSig(k, s) };
}
