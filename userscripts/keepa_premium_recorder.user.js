// ==UserScript==
// @name         Keepa プレミアム価格記録
// @namespace    http://tampermonkey.net/
// @version      3.1
// @description  KeepaページでASINの最終価格を取得・記録（フルリロード方式・自動巡回対応）
// @match        https://keepa.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const SERVER     = 'http://localhost:8766';
    const LS_QUEUE   = 'kpr_queue';
    const LS_INDEX   = 'kpr_index';
    const LS_RUNNING = 'kpr_running';

    let autoRunning = false;
    let autoTimer   = null;
    let handled     = false;
    let resumed     = false;   // resumeAuto を1回だけ実行するフラグ
    let startBtn    = null;
    let overlayEl   = null;

    // ===== XHR インターセプト（document-start で設定）=====
    const XHR   = unsafeWindow.XMLHttpRequest;
    const _open = XHR.prototype.open;
    const _send = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
        this._kUrl = url;
        return _open.apply(this, arguments);
    };

    XHR.prototype.send = function () {
        if (this._kUrl && this._kUrl.includes('api.keepa.com/product')) {
            this.addEventListener('load', function () {
                try { handleKeepaData(JSON.parse(this.responseText)); } catch (e) {}
            });
        }
        return _send.apply(this, arguments);
    };

    // fetch インターセプト
    const _fetch = unsafeWindow.fetch;
    unsafeWindow.fetch = function (input, init) {
        const p = _fetch.apply(this, arguments);
        const url = typeof input === 'string' ? input
                  : (input && input.url) ? input.url : '';
        if (url.includes('api.keepa.com/product')) {
            p.then(r => r.clone().json().then(handleKeepaData).catch(() => {}));
        }
        return p;
    };

    // ===== 価格抽出 =====
    function getLastPrice(arr) {
        if (!arr || arr.length < 2) return null;
        for (let i = arr.length - 1; i >= 1; i -= 2) {
            if (arr[i] > 0) return arr[i];
        }
        return null;
    }

    function handleKeepaData(data) {
        if (handled) return;

        // XHR受信時点でlocalStorageを確認してautoモードを補完
        if (localStorage.getItem(LS_RUNNING) === 'true') autoRunning = true;

        const products = data.products || [];

        if (autoRunning) {
            if (!products.length) {
                onAutoResult(null, null);
                return;
            }
            const product = products[0];
            const asin    = product.asin;
            const csv     = product.csv || [];
            const found   = [];
            [0, 1, 2, 9].forEach(idx => {
                const p = getLastPrice(csv[idx]);
                if (p && p > 0) found.push(p);
            });
            const best = found.length ? Math.max(...found) : null;
            onAutoResult(asin, best);
            return;
        }

        // 手動モード
        if (!products.length) return;
        const product = products[0];
        const asin    = product.asin;
        const csv     = product.csv || [];
        const labels  = { 0: 'Amazon', 1: '新品（第三者）', 2: '中古', 9: 'BuyBox' };
        const found   = [];
        [0, 1, 2, 9].forEach(idx => {
            const p = getLastPrice(csv[idx]);
            if (p && p > 0) found.push({ label: labels[idx], price: p });
        });
        const best = found.find(f => f.label === '新品（第三者）') ||
                     found.find(f => f.label === 'BuyBox') ||
                     found[0] || null;
        showManualOverlay(asin, found, best ? best.price : null);
    }

    // ===== 自動巡回モード =====

    function startAuto() {
        localStorage.removeItem(LS_QUEUE);
        localStorage.removeItem(LS_INDEX);
        localStorage.setItem(LS_RUNNING, 'false');
        showStatusOverlay('キューを読み込み中...');
        GM_xmlhttpRequest({
            method: 'GET',
            url: `${SERVER}/premium-queue`,
            timeout: 20000,
            onload: res => {
                try {
                    const data  = JSON.parse(res.responseText);
                    const queue = data.queue || [];
                    if (!queue.length) { showStatusOverlay('未処理の候補がありません'); return; }
                    localStorage.setItem(LS_QUEUE,   JSON.stringify(queue));
                    localStorage.setItem(LS_INDEX,   '0');
                    localStorage.setItem(LS_RUNNING, 'true');
                    goToAsin(queue[0].asin);
                } catch (e) { showStatusOverlay('⚠ サーバーへの接続失敗'); }
            },
            onerror: () => showStatusOverlay('⚠ サーバー未起動'),
        });
    }

    function stopAuto() {
        autoRunning = false;
        clearTimeout(autoTimer);
        localStorage.setItem(LS_RUNNING, 'false');
        updateStartBtn();
        if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    }

    // ハッシュを設定してからreload（?r=パラメータ不要）
    function goToAsin(asin) {
        location.hash = `#!product/5-${asin}`;
        setTimeout(() => location.reload(), 50);
    }

    function goNext() {
        clearTimeout(autoTimer);
        const queue = JSON.parse(localStorage.getItem(LS_QUEUE) || '[]');
        const index = parseInt(localStorage.getItem(LS_INDEX) || '0') + 1;
        if (index >= queue.length) {
            localStorage.setItem(LS_RUNNING, 'false');
            autoRunning = false;
            showCompleteOverlay(queue.length);
            return;
        }
        localStorage.setItem(LS_INDEX, String(index));
        goToAsin(queue[index].asin);
    }

    function onAutoResult(asin, price) {
        if (handled) return;
        handled = true;
        clearTimeout(autoTimer);

        const queue = JSON.parse(localStorage.getItem(LS_QUEUE) || '[]');
        const index = parseInt(localStorage.getItem(LS_INDEX) || '0');
        const cand  = queue[index] || {};

        if (!price) {
            showAutoOverlay(cand, index, queue.length, null, '価格データなし - スキップ');
            setTimeout(() => goNext(), 1500);
            return;
        }

        showAutoOverlay(cand, index, queue.length, price, '送信中...');
        GM_xmlhttpRequest({
            method:  'POST',
            url:     `${SERVER}/save-premium-price`,
            headers: { 'Content-Type': 'application/json' },
            data:    JSON.stringify({ asin: asin || cand.asin, price }),
            timeout: 30000,
            onload: res => {
                try {
                    const r = JSON.parse(res.responseText);
                    if (r.ok) showAutoOverlay(cand, index, queue.length, price, `✅ 記録完了  pmax ¥${r.pmax.toLocaleString()}`);
                    else      showAutoOverlay(cand, index, queue.length, price, `⚠ ${r.error || 'エラー'}`);
                } catch (e) {
                    showAutoOverlay(cand, index, queue.length, price, '⚠ 通信エラー');
                }
                setTimeout(() => goNext(), 2000);
            },
            onerror:   () => { showAutoOverlay(cand, index, queue.length, price, '⚠ サーバー未起動'); setTimeout(() => goNext(), 2000); },
            ontimeout: () => { showAutoOverlay(cand, index, queue.length, price, '⚠ 送信タイムアウト'); setTimeout(() => goNext(), 2000); },
        });
    }

    // ページリロード後に自動モードを再開
    function resumeAuto() {
        if (resumed) return;
        resumed = true;
        const queue = JSON.parse(localStorage.getItem(LS_QUEUE) || '[]');
        const index = parseInt(localStorage.getItem(LS_INDEX) || '0');
        if (!queue.length || index >= queue.length) {
            localStorage.setItem(LS_RUNNING, 'false');
            return;
        }
        const cand = queue[index];
        autoRunning = true;
        updateStartBtn();
        showAutoOverlay(cand, index, queue.length, null, 'ページ読み込み中...');

        // 12秒以内にAPIレスポンスが来なければスキップ
        autoTimer = setTimeout(() => {
            if (!handled) {
                showAutoOverlay(cand, index, queue.length, null, '⚠ タイムアウト - スキップ');
                setTimeout(() => goNext(), 1000);
            }
        }, 12000);
    }

    // ===== UI =====

    function getOrCreate(id) {
        // 既存の参照があれば再利用（DOMから外れていても再アタッチ）
        if (overlayEl) {
            if (document.body && !document.body.contains(overlayEl)) {
                document.body.appendChild(overlayEl);
            }
            return overlayEl;
        }
        let el = document.getElementById(id);
        if (!el) {
            el = document.createElement('div');
            el.id = id;
            if (document.body) document.body.appendChild(el);
        }
        overlayEl = el;
        return el;
    }

    function showAutoOverlay(cand, index, total, price, status) {
        const el = getOrCreate('kpr-overlay');
        el.innerHTML = `
            <div style="position:fixed;top:80px;right:16px;z-index:99999;
                background:#1b2733;color:#fff;border-radius:12px;padding:16px;width:260px;
                font-family:sans-serif;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,.5);">
                <div style="font-size:11px;color:#aaa;margin-bottom:2px;">🤖 自動取得中  [${index + 1} / ${total}]</div>
                <div style="font-size:11px;color:#aaa;">型番: <b style="color:#ccc">${cand.model || '-'}</b></div>
                <div style="font-size:11px;color:#aaa;margin-bottom:10px;">ASIN: ${cand.asin || '-'}</div>
                ${price ? `<div style="color:#fff;font-weight:bold;font-size:18px;margin-bottom:8px;">¥${price.toLocaleString()}</div>` : ''}
                <div style="color:#90caf9;font-size:12px;margin-bottom:12px;">${status}</div>
                <button id="kpr-stop" style="padding:6px 14px;border:none;border-radius:6px;
                    background:#c62828;color:#fff;font-size:12px;cursor:pointer;font-weight:bold;">■ 停止</button>
            </div>`;
        const s = document.getElementById('kpr-stop');
        if (s) s.onclick = stopAuto;
    }

    function showStatusOverlay(msg) {
        const el = getOrCreate('kpr-overlay');
        el.innerHTML = `
            <div style="position:fixed;top:80px;right:16px;z-index:99999;
                background:#1b2733;color:#fff;border-radius:12px;padding:16px;width:240px;
                font-family:sans-serif;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,.5);">
                <div style="color:#90caf9;font-size:13px;">${msg}</div>
            </div>`;
    }

    function showCompleteOverlay(total) {
        const el = getOrCreate('kpr-overlay');
        el.innerHTML = `
            <div style="position:fixed;top:80px;right:16px;z-index:99999;
                background:#1b2733;color:#fff;border-radius:12px;padding:16px;width:260px;
                font-family:sans-serif;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,.5);">
                <div style="font-size:14px;font-weight:bold;color:#4caf50;margin-bottom:8px;">✅ 自動取得完了</div>
                <div style="font-size:12px;color:#aaa;">${total} 件の処理が完了しました。</div>
                <button id="kpr-close-done" style="margin-top:10px;padding:6px 12px;border:none;border-radius:6px;
                    background:#37474f;color:#fff;font-size:12px;cursor:pointer;">閉じる</button>
            </div>`;
        const cl = document.getElementById('kpr-close-done');
        if (cl) cl.onclick = () => { overlayEl = null; el.remove(); };
    }

    // ===== 手動モード =====

    function showManualOverlay(asin, priceList, bestPrice) {
        if (overlayEl) { overlayEl.remove(); overlayEl = null; }
        const box = document.createElement('div');
        box.id = 'kpr-overlay';
        overlayEl = box;
        const rows = priceList.map(f =>
            `<div style="display:flex;justify-content:space-between;margin:4px 0;">
                <span style="color:#aaa">${f.label}</span>
                <span style="color:#fff;font-weight:bold;">¥${f.price.toLocaleString()}</span>
            </div>`
        ).join('') || '<div style="color:#e57373">価格データなし</div>';
        box.innerHTML = `
            <div style="position:fixed;top:80px;right:16px;z-index:99999;
                background:#1b2733;color:#fff;border-radius:12px;padding:16px;width:240px;
                font-family:sans-serif;font-size:13px;box-shadow:0 4px 20px rgba(0,0,0,.5);">
                <button id="kpr-close" style="position:absolute;top:8px;right:10px;background:none;border:none;color:#aaa;cursor:pointer;font-size:14px;">✕</button>
                <div style="font-size:11px;color:#aaa;margin-bottom:4px;">📦 プレミアム価格記録</div>
                <div style="font-size:11px;color:#aaa;margin-bottom:10px;">ASIN: ${asin}</div>
                <div style="margin-bottom:12px;">${rows}</div>
                ${bestPrice ? `
                <div style="margin-bottom:8px;">
                    <span style="color:#aaa;font-size:11px;">使用価格（編集可）</span><br>
                    <input id="kpr-price" type="number" value="${bestPrice}"
                        style="width:100%;padding:6px;border-radius:6px;border:1px solid #3a4a5a;
                               background:#0d1921;color:#fff;font-size:14px;margin-top:4px;box-sizing:border-box;">
                </div>
                <button id="kpr-save" style="width:100%;padding:9px;border:none;border-radius:8px;
                    background:#2e7d32;color:#fff;font-size:13px;cursor:pointer;font-weight:bold;">📥 記録する</button>
                <div id="kpr-status" style="margin-top:8px;font-size:11px;color:#aaa;text-align:center;min-height:16px;"></div>
                ` : ''}
            </div>`;
        const attach = () => {
            document.body.appendChild(box);
            document.getElementById('kpr-close').onclick = () => { box.remove(); overlayEl = null; };
            const saveBtn = document.getElementById('kpr-save');
            if (saveBtn) {
                saveBtn.onclick = () => {
                    const price = parseInt(document.getElementById('kpr-price').value);
                    if (!price || price <= 0) { alert('価格を入力してください'); return; }
                    saveBtn.disabled = true;
                    saveBtn.textContent = '送信中…';
                    GM_xmlhttpRequest({
                        method: 'POST', url: `${SERVER}/save-premium-price`,
                        headers: { 'Content-Type': 'application/json' },
                        data: JSON.stringify({ asin, price }), timeout: 30000,
                        onload: res => {
                            try {
                                const r = JSON.parse(res.responseText);
                                if (r.ok) {
                                    saveBtn.textContent = '✅ 記録完了';
                                    saveBtn.style.background = '#1565c0';
                                    document.getElementById('kpr-status').textContent =
                                        `${r.model}  pmax ¥${r.pmax.toLocaleString()}  手数料 ¥${r.fee.toLocaleString()}`;
                                } else {
                                    saveBtn.textContent = '⚠ エラー'; saveBtn.disabled = false;
                                    document.getElementById('kpr-status').textContent = r.error || '';
                                }
                            } catch (e) { saveBtn.textContent = '⚠ 通信エラー'; saveBtn.disabled = false; }
                        },
                        onerror:   () => { saveBtn.textContent = '⚠ サーバー未起動'; saveBtn.disabled = false; },
                        ontimeout: () => { saveBtn.textContent = '⚠ タイムアウト';   saveBtn.disabled = false; },
                    });
                };
            }
        };
        if (document.body) attach();
        else document.addEventListener('DOMContentLoaded', attach);
    }

    // ===== 起動ボタン =====

    function updateStartBtn() {
        if (!startBtn) return;
        const running = localStorage.getItem(LS_RUNNING) === 'true';
        startBtn.textContent = running ? '■ 停止' : '🤖 自動取得';
        startBtn.style.background = running ? '#c62828' : '#1565c0';
    }

    function addStartButton() {
        if (!document.body) return;
        // 既にDOMにあれば何もしない
        if (startBtn && document.body.contains(startBtn)) return;

        if (!startBtn) {
            startBtn = document.createElement('button');
            Object.assign(startBtn.style, {
                position: 'fixed', bottom: '20px', right: '16px', zIndex: '99998',
                padding: '10px 18px', border: 'none', borderRadius: '10px',
                background: '#1565c0', color: '#fff', fontSize: '13px',
                cursor: 'pointer', fontWeight: 'bold', boxShadow: '0 2px 12px rgba(0,0,0,.5)',
            });
            updateStartBtn();
            startBtn.onclick = () => {
                if (localStorage.getItem(LS_RUNNING) === 'true') stopAuto();
                else startAuto();
            };
        }
        document.body.appendChild(startBtn);
    }

    // ===== Keep-alive: Keepa SPAがDOMを再構築してもボタン・オーバーレイを維持 =====
    function keepAlive() {
        if (!document.body) return;
        addStartButton();
        if (overlayEl && !document.body.contains(overlayEl)) {
            document.body.appendChild(overlayEl);
        }
    }

    // ===== 初期化 =====
    document.addEventListener('DOMContentLoaded', () => {
        addStartButton();
        setInterval(keepAlive, 800);

        if (localStorage.getItem(LS_RUNNING) === 'true') {
            // Keepa SPAの初期化完了後に再開（2秒待機）
            setTimeout(() => resumeAuto(), 2000);
        }
    });

})();
