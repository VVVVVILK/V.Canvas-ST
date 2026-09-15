// progress.js — 出图进度悬浮卡片。
//
// 只操作 DOM：卡片不写入聊天记录，也不进入上下文。
// 分析 / 绘制期间常驻一个实例，显示当前阶段并附带「终止」按钮；
// 结束或失败后自动隐藏（失败停留更久，便于看清原因）。
//
// 卡片跟随酒馆主题（使用 SmartTheme 变量），不引入固定配色。

const CARD_ID = 'v_canvas_progress';

// 结束后的自动隐藏时长（毫秒）
const HIDE_DELAY_OK = 3500;
const HIDE_DELAY_ERR = 12000;

let hideTimer = null;
let cancelHandler = null;

// setCancelHandler 注册「终止」按钮的回调；传 null 清除。
export function setCancelHandler(fn) {
    cancelHandler = fn;
}

function clearTimer() {
    if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
    }
}

function card() {
    let el = document.getElementById(CARD_ID);
    if (el) return el;

    el = document.createElement('div');
    el.id = CARD_ID;
    el.innerHTML = `
        <div class="v_canvas_pg_mark">Vi</div>
        <div class="v_canvas_pg_body">
            <div class="v_canvas_pg_title">V.Canvas</div>
            <div class="v_canvas_pg_text"></div>
        </div>
        <button type="button" class="v_canvas_pg_btn menu_button">终止</button>`;

    el.querySelector('.v_canvas_pg_btn').addEventListener('click', () => {
        const stop = el.querySelector('.v_canvas_pg_btn');
        if (stop.dataset.mode === 'close') {
            hideProgress();
            return;
        }
        // 终止：先给出反馈，再让调用方 abort 当前请求
        stop.dataset.mode = 'close';
        stop.textContent = '关闭';
        el.classList.add('v_canvas_pg_finishing');
        text('正在终止…');
        try {
            cancelHandler?.();
        } catch { /* 忽略 */ }
    });

    document.body.appendChild(el);
    return el;
}

function text(s) {
    const el = document.getElementById(CARD_ID);
    if (el) el.querySelector('.v_canvas_pg_text').textContent = String(s ?? '');
}

// showProgress 显示 / 更新进行中的状态。
export function showProgress(s) {
    clearTimer();
    const el = card();
    el.classList.remove('v_canvas_pg_done', 'v_canvas_pg_err', 'v_canvas_pg_finishing');
    const btn = el.querySelector('.v_canvas_pg_btn');
    btn.dataset.mode = 'stop';
    btn.textContent = '终止';
    el.classList.add('show');
    text(s);
}

// updateProgress 只改文字（阶段推进时用，不重置按钮状态）。
export function updateProgress(s) {
    text(s);
}

// finishProgress 结束：区分成功与失败，按钮变为「关闭」并自动隐藏。
export function finishProgress(s, isError = false) {
    clearTimer();
    const el = card();
    el.classList.remove('v_canvas_pg_finishing');
    el.classList.add('show', isError ? 'v_canvas_pg_err' : 'v_canvas_pg_done');
    const btn = el.querySelector('.v_canvas_pg_btn');
    btn.dataset.mode = 'close';
    btn.textContent = '关闭';
    text(s);
    hideTimer = setTimeout(() => hideProgress(), isError ? HIDE_DELAY_ERR : HIDE_DELAY_OK);
}

// hideProgress 立即隐藏（退出扩展时也调用）。
export function hideProgress() {
    clearTimer();
    const el = document.getElementById(CARD_ID);
    if (el) el.remove();
}
