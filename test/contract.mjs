// 静态一致性检查：面板调用的动作 vs 桥接里实现的动作。
// 动作名不一致是「点击按钮无反应」最常见的成因，因此单独校验。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(path.dirname(fileURLToPath(import.meta.url))) + path.sep;
const html = fs.readFileSync(dir + 'panel.html', 'utf8');
const js = fs.readFileSync(dir + 'index.js', 'utf8');

const called = new Set();
for (const m of html.matchAll(/call\(\s*'([^']+)'/g)) called.add(m[1]);

const bridge = js.slice(js.indexOf('function installBridge'));
const cases = new Set();
for (const m of bridge.matchAll(/case\s+'([^']+)'/g)) cases.add(m[1]);

const out = [];
out.push('面板调用: ' + [...called].sort().join(', '));
out.push('桥接实现: ' + [...cases].sort().join(', '));

let bad = 0;
for (const a of called) {
    if (!cases.has(a)) { out.push(`❌ 面板调了但桥接没实现: ${a}`); bad++; }
}
for (const a of cases) {
    if (!called.has(a)) out.push(`⚠️  桥接实现了但面板没用到: ${a}`);
}

// 面板读的字段 vs 桥接给的数据
const stateBlock = bridge.slice(bridge.indexOf("case 'state'"), bridge.indexOf("case 'settings.get'"));
const panelStateFields = new Set();
for (const m of html.matchAll(/\bd\.([a-z_A-Z]+)/g)) panelStateFields.add(m[1]);
for (const m of html.matchAll(/\bs\.([a-z_]+)/g)) panelStateFields.add(m[1]);

// 设置字段清单以 lib/settings.js 的 defaultSettings 为唯一事实来源，
// 避免此处维护一份硬编码副本导致新增字段时检查项失配。
const settings = fs.readFileSync(dir + 'lib/settings.js', 'utf8');
const defBlock = settings.slice(settings.indexOf('function defaultSettings'), settings.indexOf('const BOOL_KEYS'));
// 只检查标量字段：history 是持久化的数据列表，由「生成记录」页渲染，不对应输入控件。
const defKeys = [...defBlock.matchAll(/^\s{8}([a-z_]+):\s*([^,\n]+)/gm)]
    .filter(m => !/^[[{]/.test(m[2].trim()))
    .map(m => m[1]);

const idFields = new Set();
for (const m of html.matchAll(/f-([a-z_]+)"/g)) idFields.add(m[1]);
for (const m of html.matchAll(/sw-([a-z_]+)"/g)) idFields.add(m[1]);
const missingIds = defKeys.filter(k => !idFields.has(k));
out.push(`设置里共 ${defKeys.length} 个字段；面板未覆盖: ${missingIds.length ? missingIds.join(', ') : '（无）'}`);

out.push(bad ? `RESULT: ${bad} 个动作对不上` : 'RESULT: 动作契约一致');
fs.writeFileSync(dir + 'test/contract.txt', out.join('\n'), 'utf8');
process.exit(bad ? 1 : 0);
