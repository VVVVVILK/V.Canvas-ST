// bridge_direct.mjs — 「A 插件页面直连」的离线测试。
//
// 用桩模拟 A 插件挂在页面上的函数桥（window.__V_ADAPTER_NAI__），断言四件事：
//   1. 服务地址留空时，「测试连接」报告直连已接上（不再报「请先填写 NAI 服务地址」）；
//   2. 服务地址留空时，出图**确实经过 A 插件的桥**（调用计数=1、expand 透传、返回图字节）；
//   3. 没装 A 插件（无桥）时，给出明确指引而不是含糊报错；
//   4. 填了服务地址时**绝不过桥**（地址优先，桥计数=0）。
// 全程无网络：桥直接返回内存里的 PNG 字节。

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
const ok = (name, cond, extra) => {
    if (cond) { pass++; console.log(`[OK]   ${name}`); }
    else { fail++; console.log(`[FAIL] ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
};

// ── 桩：模拟 A 插件的页面桥 ──
const calls = [];
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
function installBridge() {
    globalThis.__V_ADAPTER_NAI__ = async (body, opts) => {
        calls.push({ expand: !!opts?.expand, input: String(body?.input ?? '') });
        return { status: 200, contentType: 'image/png', bytes: new Uint8Array(PNG), via: 'chat' };
    };
}
function removeBridge() { delete globalThis.__V_ADAPTER_NAI__; }

const { generateIllustration, testConnection } = await import(pathToFileURL(path.join(here, '../lib/nai-api.js')).href);

// 1. 有桥：测试连接 = 直连已接上（本次修复的行为）
installBridge();
{
    const msg = await testConnection({ baseUrl: '' });
    ok('直连·测试连接返回「已接上」而不是报错', msg.includes('A 插件页面直连已接上'), msg);
}

// 2. 有桥：出图确实走桥
{
    calls.length = 0;
    const gen = await generateIllustration({
        baseUrl: '', apiKey: '', model: 'x', prompt: '一只猫', negative: '',
        width: 512, height: 512, steps: 4, scale: 1, expand: true, allowBridge: true,
    });
    ok('直连·出图确实经过 A 插件的桥（而不是其他路径）', calls.length === 1, calls);
    ok('直连·expand 透传给桥', calls[0]?.expand === true, calls[0]);
    ok('直连·返回图片字节', !!gen.base64 && gen.base64.length > 50);
    ok('直连·via 来自桥', gen.via === 'chat', gen.via);
}

// 3. 没桥：给出明确指引
removeBridge();
{
    let err = '';
    try { await testConnection({ baseUrl: '' }); } catch (e) { err = String(e?.message ?? e); }
    ok('无桥·测试连接明确报「未检测到 A 插件」', err.includes('检测到 A 插件'), err);
}

// 4. 有桥但填了地址：地址优先，成功时绝不过桥（桥计数必须是 0）
installBridge();
{
    const http = await import('node:http');
    const PNG2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(32, 3)]);
    const srv = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'image/png' }); res.end(PNG2); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}`;
    calls.length = 0;
    const gen = await generateIllustration({
        baseUrl: url, apiKey: '', model: 'x', prompt: '猫', negative: '',
        width: 64, height: 64, steps: 1, scale: 1, allowBridge: true,
    });
    ok('填了地址·直接走该地址成功', !!gen.base64);
    ok('填了地址·绝不过桥（桥计数=0）', calls.length === 0, calls);
    srv.close();
}

// 5. 地址不可达 + 有桥：按设计自动回退到桥（面板 hint 写明的行为：「填了但连不上时，会自动回退」）
{
    calls.length = 0;
    const gen = await generateIllustration({
        baseUrl: 'http://127.0.0.1:9', apiKey: '', model: 'x', prompt: '猫', negative: '',
        width: 64, height: 64, steps: 1, scale: 1, allowBridge: true,
    });
    ok('地址不可达·自动回退到桥（设计行为）', calls.length === 1 && !!gen.base64, { calls: calls.length });
}
removeBridge();

console.log(`\nRESULT: ${pass} passed / ${fail} failed`);
if (fail) process.exit(1);
