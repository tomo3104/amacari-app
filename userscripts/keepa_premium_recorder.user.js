// ==UserScript==
// @name         Keepa プレミアム価格記録
// @namespace    http://tampermonkey.net/
// @version      3.10
// @description  KeepaページでASINの最終価格を取得・記録（2段階リダイレクト・GM_setValue使用）
// @match        https://keepa.com/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const SERVER    = 'http://localhost:8766';
    const K_QUEUE   = 'kpr_queue';
    const K_INDEX   = 'kpr_index';
    const K_RUNNING = 'kpr_running';

    const gmGet = (k, d) => GM_getValue(k, d);
    const gmSet = (k, v) => GM_setValue(k, v);
    const gmDel = (k)    => GM_deleteValue(k);

    // ===== document-start: ?r=中継URLを検知したら即クリーンURLへリダイレクト =====
    // keepa.com/?r=timestamp#!product/5-ASIN → keepa.com/#!product/5-ASIN
    // （KeepaはクリーンURL形式でないとAPIを呼ばないため）
    if (unsafeWindow.location.search.includes('r=') &&
        gmGet(K_RUNNING, 'false') === 'true' &&
        unsafeWindow.location.hash.includes('#!product/')) {
        const cleanUrl = 'https://keepa.com/' + unsafeWindow.location.hash;
        console.log('[KPR] 中継URL検知 → クリーンURLへ:', cleanUrl);
        unsafeWindow.location.replace(cleanUrl);
        // 以降の初期化はクリーンURLページで行うので終了
        return;
    }

    let autoRunning = false;
    let autoTimer   = null;
    let cdTimer     = null;
    let handled     = false;
    let resumed     = false;
    let startBtn    = null;
    let overlayEl   = null;

    // ===== EventSource (SSE) インターセプト =====
    try {
        const _ES = unsafeWindow.EventSource;
        if (typeof _ES === 'function') {
            unsafeWindow.EventSource = function(url, init) {
                console.log('[KPR] SSE接続:', url);
                const es = init ? new _ES(url, init) : new _ES(url);
                es.addEventListener('message', evt => {
                    const d = evt.data || '';
                    console.log('[KPR] SSE←:', d.slice(0, 300));
                    if (d.includes('"products"') || d.includes('"csv"') || d.includes('"asin"')) {
                        try {
                            const p = JSON.parse(d);
                            if (p.products) handleKeepaData(p);
                        } catch (e) {}
                    }
                });
                return es;
            };
            unsafeWindow.EventSource.prototype = _ES.prototype;
        }
    } catch (e) { console.log('[KPR] SSE intercept error:', e.message); }

    // ===== WebSocket インターセプト (document-startで必須) =====
    try {
        const _WS = unsafeWindow.WebSocket;
        function PatchedWS(url, protocols) {
            console.log('[KPR] WS接続:', url);
            const ws = (protocols !== undefined) ? new _WS(url, protocols) : new _WS(url);
            ws.addEventListener('message', evt => {
                if (typeof evt.data !== 'string') return;
                const d = evt.data;
                console.log('[KPR] WS←:', d.slice(0, 300));
                if (d.includes('"products"') || d.includes('"asin"') || d.includes('"csv"')) {
                    try {
                        const parsed = JSON.parse(d);
                        if (parsed.products) handleKeepaData(parsed);
                        else if (parsed.data && parsed.data.products) handleKeepaData(parsed.data);
                    } catch (e) {}
                }
            });
            return ws;
        }
        PatchedWS.prototype = _WS.prototype;
        PatchedWS.CONNECTING = 0; PatchedWS.OPEN = 1; PatchedWS.CLOSING = 2; PatchedWS.CLOSED = 3;
        unsafeWindow.WebSocket = PatchedWS;
    } catch (e) {
        console.log('[KPR] WS intercept error:', e.message);
    }

    // ===== IndexedDB open 傍受（使用DB名のデバッグ用） =====
    try {
        const _idbOpen = unsafeWindow.indexedDB.open.bind(unsafeWindow.indexedDB);
        unsafeWindow.indexedDB.open = function(name, version) {
            console.log('[KPR] IDB.open:', name, version || '');
            return _idbOpen.apply(this, arguments);
        };
    } catch (e) {}

    // ===== XHR インターセプト =====
    const XHR   = unsafeWindow.XMLHttpRequest;
    const _open = XHR.prototype.open;
    const _send = XHR.prototype.send;

    XHR.prototype.open = function (method, url) {
        this._kUrl = url;
        // hello.graphリクエストURLからKeepaトークンを捕捉
        if (url && url.includes('hello.graph')) {
            const m = url.match(/[?&]token=([a-zA-Z0-9]{20,})/);
            if (m) { gmSet('kpr_token', m[1]); console.log('[KPR] token捕捉:', m[1].slice(0,8)+'...'); }
        }
        return _open.apply(this, arguments);
    };

    XHR.prototype.send = function () {
        if (this._kUrl) {
            if (!this._kUrl.startsWith('chrome') && !this._kUrl.includes('localhost')) {
                console.log('[KPR] XHR→:', this._kUrl.slice(0, 120));
            }
            // keepa.com系は全レスポンスをログ＋解析を試みる
            if (this._kUrl.includes('keepa.com') && !this._kUrl.startsWith('chrome')) {
                this.addEventListener('load', function () {
                    const rt = this.responseText || '';
                    console.log('[KPR] XHR←:', this.status, rt.slice(0, 250));
                    if (rt.includes('"products"') || rt.includes('"csv"') || rt.includes('"asin"')) {
                        try {
                            const parsed = JSON.parse(rt);
                            if (parsed.products) handleKeepaData(parsed);
                            else if (parsed.data && parsed.data.products) handleKeepaData(parsed.data);
                        } catch (e) {}
                    }
                });
            }
        }
        return _send.apply(this, arguments);
    };

    const _fetch = unsafeWindow.fetch;
    if (typeof _fetch === 'function') {
        unsafeWindow.fetch = function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) ? input.url : '';
            if (!url.startsWith('chrome') && !url.includes('localhost') && url.startsWith('http')) {
                console.log('[KPR] fetch→:', url.slice(0, 120));
            }
            const p = _fetch.apply(this, arguments);
            if (url.includes('keepa.com')) {
                p.then(r => r.clone().text().then(rt => {
                    console.log('[KPR] fetch←:', rt.slice(0, 250));
                    if (rt.includes('"products"') || rt.includes('"csv"')) {
                        try {
                            const parsed = JSON.parse(rt);
                            if (parsed.products) handleKeepaData(parsed);
                        } catch (e) {}
                    }
                }).catch(() => {})).catch(() => {});
            }
            return p;
        };
    }

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
        console.log('[KPR] handleKeepaData 呼ばれた');
        if (gmGet(K_RUNNING, 'false') === 'true') autoRunning = true;

        const products = data.products || [];
        if (autoRunning) {
            if (!products.length) { onAutoResult(null, null); return; }
            const product = products[0];
            const asin    = product.asin;
            const csv     = product.csv || [];
            const found   = [];
            [0, 1, 2, 9].forEach(idx => {
                const p = getLastPrice(csv[idx]);
                if (p && p > 0) found.push(p);
            });
            const best = found.length ? Math.max(...found) : null;
            console.log('[KPR] ASIN:', asin, '→ 価格:', best);
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
                     found.find(f => f.label === 'BuyBox') || found[0] || null;
        showManualOverlay(asin, found, best ? best.price : null);
    }

    // ===== 自動巡回モード =====

    function startAuto() {
        gmDel(K_QUEUE); gmDel(K_INDEX);
        gmSet(K_RUNNING, 'false');
        showStatusOverlay('キューを読み込み中...');
        GM_xmlhttpRequest({
            method: 'GET', url: `${SERVER}/premium-queue`, timeout: 20000,
            onload: res => {
                try {
                    const data  = JSON.parse(res.responseText);
                    const queue = data.queue || [];
                    if (!queue.length) { showStatusOverlay('未処理の候補がありません'); return; }
                    console.log('[KPR] キュー取得:', queue.length, '件');
                    gmSet(K_QUEUE,   JSON.stringify(queue));
                    gmSet(K_INDEX,   '0');
                    gmSet(K_RUNNING, 'true');
                    goToAsin(queue[0].asin);
                } catch (e) { showStatusOverlay('⚠ サーバーへの接続失敗'); }
            },
            onerror: () => showStatusOverlay('⚠ サーバー未起動'),
        });
    }

    function stopAuto() {
        autoRunning = false;
        clearTimeout(autoTimer);
        clearInterval(cdTimer);
        gmSet(K_RUNNING, 'false');
        updateStartBtn();
        if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    }

    // 中継URL経由でフルリロードを強制（?r= → クリーンURL の2段階）
    function goToAsin(asin) {
        const url = `https://keepa.com/?r=${Date.now()}#!product/5-${asin}`;
        console.log('[KPR] goToAsin(中継):', url);
        unsafeWindow.location.href = url;
    }

    function goNext() {
        clearTimeout(autoTimer);
        clearInterval(cdTimer);
        const queue = JSON.parse(gmGet(K_QUEUE, '[]'));
        const index = parseInt(gmGet(K_INDEX, '0')) + 1;
        console.log('[KPR] goNext:', index, '/', queue.length);
        if (index >= queue.length) {
            gmSet(K_RUNNING, 'false');
            autoRunning = false;
            showCompleteOverlay(queue.length);
            return;
        }
        gmSet(K_INDEX, String(index));
        goToAsin(queue[index].asin);
    }

    function onAutoResult(asin, price) {
        if (handled) return;
        handled = true;
        clearTimeout(autoTimer);
        clearInterval(cdTimer);
        console.log('[KPR] onAutoResult: price=', price);

        const queue = JSON.parse(gmGet(K_QUEUE, '[]'));
        const index = parseInt(gmGet(K_INDEX, '0'));
        const cand  = queue[index] || {};

        if (!price) {
            showAutoOverlay(cand, index, queue.length, null, '価格データなし - スキップ');
            setTimeout(() => goNext(), 1500);
            return;
        }

        showAutoOverlay(cand, index, queue.length, price, '送信中...');
        GM_xmlhttpRequest({
            method: 'POST', url: `${SERVER}/save-premium-price`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ asin: asin || cand.asin, price }), timeout: 30000,
            onload: res => {
                try {
                    const r = JSON.parse(res.responseText);
                    if (r.ok) showAutoOverlay(cand, index, queue.length, price, `✅ 記録完了 pmax¥${r.pmax.toLocaleString()}`);
                    else      showAutoOverlay(cand, index, queue.length, price, `⚠ ${r.error || 'エラー'}`);
                } catch (e) { showAutoOverlay(cand, index, queue.length, price, '⚠ 通信エラー'); }
                setTimeout(() => goNext(), 2000);
            },
            onerror:   () => { showAutoOverlay(cand, index, queue.length, price, '⚠ サーバー未起動'); setTimeout(() => goNext(), 2000); },
            ontimeout: () => { showAutoOverlay(cand, index, queue.length, price, '⚠ 送信タイムアウト'); setTimeout(() => goNext(), 2000); },
        });
    }

    // ===== Keepa API 直接呼び出し（GM_xmlhttpRequest経由・CORS回避）=====
    function callKeepaAPI(asin) {
        const token = gmGet('kpr_token', '');
        if (!token) { console.log('[KPR] token未取得 - スキップ'); return; }
        console.log('[KPR] API直接呼び出し:', asin);
        GM_xmlhttpRequest({
            method: 'GET',
            url: `https://api.keepa.com/product?key=${token}&domain=5&asin=${asin}&stats=180&offers=20`,
            timeout: 30000,
            onload: res => {
                // ページ遷移済みチェック
                const curAsin = (unsafeWindow.location.hash.match(/product\/5-([A-Z0-9]+)/) || [])[1];
                if (curAsin !== asin || handled) return;
                try {
                    const data = JSON.parse(res.responseText);
                    console.log('[KPR] API応答 tokensLeft=', data.tokensLeft,
                        'products=', (data.products || []).length,
                        'error=', data.error || '-');
                    if (data.products && data.products.length) {
                        handleKeepaData(data);
                    } else {
                        console.log('[KPR] API データなし raw=', res.responseText.slice(0, 200));
                        onAutoResult(null, null);
                    }
                } catch (e) {
                    console.log('[KPR] API解析エラー:', e.message, res.responseText.slice(0, 150));
                    onAutoResult(null, null);
                }
            },
            onerror:   () => { if (!handled) { console.log('[KPR] API接続エラー'); onAutoResult(null, null); } },
            ontimeout: () => { if (!handled) { console.log('[KPR] APIタイムアウト'); onAutoResult(null, null); } },
        });
    }

    // ===== IndexedDB keepa2Cache 直読み（フォールバック）=====
    function tryReadIDB(asin) {
        console.log('[KPR] IDB直読み試行:', asin);
        try {
            const req = unsafeWindow.indexedDB.open('keepa2Cache');
            req.onsuccess = evt => {
                const db = evt.target.result;
                const stores = [...db.objectStoreNames];
                console.log('[KPR] keepa2Cache stores:', stores);
                if (!stores.length) { db.close(); return; }

                stores.forEach(sn => {
                    try {
                        const tx = db.transaction(sn, 'readonly');
                        const store = tx.objectStore(sn);

                        // レコード件数とサンプルキーを確認
                        const cnt = store.count();
                        cnt.onsuccess = () => {
                            console.log('[KPR] IDB store=' + sn + ' count=', cnt.result);
                            if (cnt.result > 0) {
                                // 最初の5件のキーを取得
                                const kReq = store.getAllKeys(null, 5);
                                kReq.onsuccess = () => console.log('[KPR] IDB sample keys:', kReq.result);
                            }
                        };

                        // キー形式をいくつか試す（ASIN / 5-ASIN / marketplace:ASIN）
                        ['', '5-', 'jp-', '5:'].forEach(prefix => {
                            const key = prefix + asin;
                            const getReq = store.get(key);
                            getReq.onsuccess = () => {
                                if (getReq.result) {
                                    const r = getReq.result;
                                    console.log('[KPR] IDB HIT key=' + key + ' store=' + sn + ':', JSON.stringify(r).slice(0, 500));
                                    if (!handled) {
                                        handleKeepaData(r.products ? r : { products: [r] });
                                    }
                                } else {
                                    if (prefix === '') console.log('[KPR] IDB MISS store=' + sn + ' asin=' + asin);
                                }
                            };
                        });
                    } catch (e) {
                        console.log('[KPR] IDB tx error store=' + sn + ':', e.message);
                    }
                });
                setTimeout(() => { try { db.close(); } catch(e) {} }, 2000);
            };
            req.onerror = () => console.log('[KPR] keepa2Cache open error');
        } catch (e) {
            console.log('[KPR] tryReadIDB error:', e.message);
        }
    }

    function resumeAuto() {
        if (resumed) return;
        resumed = true;
        const queue = JSON.parse(gmGet(K_QUEUE, '[]'));
        const index = parseInt(gmGet(K_INDEX, '0'));
        console.log('[KPR] resumeAuto: index=', index, 'queue.length=', queue.length);

        if (!queue.length || index >= queue.length) {
            gmSet(K_RUNNING, 'false');
            updateStartBtn();
            return;
        }

        const cand = queue[index];
        autoRunning = true;
        updateStartBtn();

        let sec = 20;
        const updateCd = () => {
            showAutoOverlay(cand, index, queue.length, null, `データ待機中... (${sec}秒)`);
            sec--;
        };
        updateCd();
        cdTimer = setInterval(updateCd, 1000);

        // 1.5秒後: トークン捕捉完了後に直接APIコール（メイン手段）
        setTimeout(() => { if (!handled) callKeepaAPI(cand.asin); }, 1500);
        // 5秒後: IDB直読みもフォールバックとして試みる
        setTimeout(() => { if (!handled) tryReadIDB(cand.asin); }, 5000);

        autoTimer = setTimeout(() => {
            clearInterval(cdTimer);
            if (!handled) {
                console.log('[KPR] タイムアウト → スキップ');
                showAutoOverlay(cand, index, queue.length, null, '⚠ タイムアウト - スキップ');
                setTimeout(() => goNext(), 1000);
            }
        }, 20000);
    }

    // ===== UI =====

    const OV_STYLE = [
        'position:fixed', 'top:80px', 'right:16px', 'z-index:2147483647',
        'width:270px', 'background:#1b2733', 'color:#e0e0e0',
        'border-radius:12px', 'padding:16px', 'font-family:sans-serif',
        'font-size:13px', 'box-shadow:0 4px 20px rgba(0,0,0,.6)', 'line-height:1.5',
    ].map(s => s + ' !important').join(';');

    function getOrCreate(id) {
        if (overlayEl) {
            if (document.body && !document.body.contains(overlayEl)) document.body.appendChild(overlayEl);
            return overlayEl;
        }
        let el = document.getElementById(id);
        if (!el) { el = document.createElement('div'); el.id = id; if (document.body) document.body.appendChild(el); }
        overlayEl = el;
        return el;
    }

    function showAutoOverlay(cand, index, total, price, status) {
        const el = getOrCreate('kpr-overlay');
        el.setAttribute('style', OV_STYLE);
        el.innerHTML = `
            <div style="font-size:11px;color:#aaa;margin-bottom:2px;">🤖 自動取得中  [${index + 1} / ${total}]</div>
            <div style="font-size:11px;color:#aaa;">型番: <b style="color:#ddd">${cand.model || '-'}</b></div>
            <div style="font-size:11px;color:#aaa;margin-bottom:8px;">ASIN: ${cand.asin || '-'}</div>
            ${price ? `<div style="color:#fff;font-weight:bold;font-size:18px;margin-bottom:6px;">¥${price.toLocaleString()}</div>` : ''}
            <div style="color:#90caf9;font-size:12px;margin-bottom:12px;">${status}</div>
            <button id="kpr-stop" style="padding:6px 14px;border:none;border-radius:6px;
                background:#c62828 !important;color:#fff !important;font-size:12px;cursor:pointer;font-weight:bold;">■ 停止</button>`;
        const s = document.getElementById('kpr-stop');
        if (s) s.onclick = stopAuto;
    }

    function showStatusOverlay(msg) {
        const el = getOrCreate('kpr-overlay');
        el.setAttribute('style', OV_STYLE);
        el.innerHTML = `<div style="color:#90caf9;font-size:13px;">${msg}</div>`;
    }

    function showCompleteOverlay(total) {
        const el = getOrCreate('kpr-overlay');
        el.setAttribute('style', OV_STYLE);
        el.innerHTML = `
            <div style="font-size:14px;font-weight:bold;color:#4caf50;margin-bottom:8px;">✅ 自動取得完了</div>
            <div style="font-size:12px;color:#aaa;">${total} 件の処理が完了しました。</div>
            <button id="kpr-close-done" style="margin-top:10px;padding:6px 12px;border:none;border-radius:6px;
                background:#37474f !important;color:#fff !important;font-size:12px;cursor:pointer;">閉じる</button>`;
        const cl = document.getElementById('kpr-close-done');
        if (cl) cl.onclick = () => { overlayEl = null; el.remove(); };
    }

    // ===== 手動モード =====

    function showManualOverlay(asin, priceList, bestPrice) {
        if (overlayEl) { overlayEl.remove(); overlayEl = null; }
        const box = document.createElement('div');
        box.id = 'kpr-overlay';
        overlayEl = box;
        box.setAttribute('style', OV_STYLE);
        const rows = priceList.map(f =>
            `<div style="display:flex;justify-content:space-between;margin:4px 0;">
                <span style="color:#aaa">${f.label}</span>
                <span style="color:#fff;font-weight:bold;">¥${f.price.toLocaleString()}</span>
            </div>`
        ).join('') || '<div style="color:#e57373">価格データなし</div>';
        box.innerHTML = `
            <button id="kpr-close" style="position:absolute;top:8px;right:10px;background:none;border:none;color:#aaa;cursor:pointer;font-size:14px;">✕</button>
            <div style="font-size:11px;color:#aaa;margin-bottom:4px;">📦 プレミアム価格記録</div>
            <div style="font-size:11px;color:#aaa;margin-bottom:10px;">ASIN: ${asin}</div>
            <div style="margin-bottom:12px;">${rows}</div>
            ${bestPrice ? `
            <div style="margin-bottom:8px;">
                <span style="color:#aaa;font-size:11px;">使用価格（編集可）</span><br>
                <input id="kpr-price" type="number" value="${bestPrice}"
                    style="width:100%;padding:6px;border-radius:6px;border:1px solid #3a4a5a;
                           background:#0d1921 !important;color:#fff !important;font-size:14px;margin-top:4px;box-sizing:border-box;">
            </div>
            <button id="kpr-save" style="width:100%;padding:9px;border:none;border-radius:8px;
                background:#2e7d32 !important;color:#fff !important;font-size:13px;cursor:pointer;font-weight:bold;">📥 記録する</button>
            <div id="kpr-status" style="margin-top:8px;font-size:11px;color:#aaa;text-align:center;min-height:16px;"></div>
            ` : ''}`;
        const attach = () => {
            document.body.appendChild(box);
            document.getElementById('kpr-close').onclick = () => { box.remove(); overlayEl = null; };
            const saveBtn = document.getElementById('kpr-save');
            if (saveBtn) {
                saveBtn.onclick = () => {
                    const price = parseInt(document.getElementById('kpr-price').value);
                    if (!price || price <= 0) { alert('価格を入力してください'); return; }
                    saveBtn.disabled = true; saveBtn.textContent = '送信中…';
                    GM_xmlhttpRequest({
                        method: 'POST', url: `${SERVER}/save-premium-price`,
                        headers: { 'Content-Type': 'application/json' },
                        data: JSON.stringify({ asin, price }), timeout: 30000,
                        onload: res => {
                            try {
                                const r = JSON.parse(res.responseText);
                                if (r.ok) {
                                    saveBtn.textContent = '✅ 記録完了'; saveBtn.style.background = '#1565c0';
                                    document.getElementById('kpr-status').textContent =
                                        `${r.model}  pmax ¥${r.pmax.toLocaleString()}  手数料 ¥${r.fee.toLocaleString()}`;
                                } else { saveBtn.textContent = '⚠ エラー'; saveBtn.disabled = false; }
                            } catch (e) { saveBtn.textContent = '⚠ 通信エラー'; saveBtn.disabled = false; }
                        },
                        onerror:   () => { saveBtn.textContent = '⚠ サーバー未起動'; saveBtn.disabled = false; },
                        ontimeout: () => { saveBtn.textContent = '⚠ タイムアウト';   saveBtn.disabled = false; },
                    });
                };
            }
        };
        if (document.body) attach(); else document.addEventListener('DOMContentLoaded', attach);
    }

    // ===== 起動ボタン =====

    function updateStartBtn() {
        if (!startBtn) return;
        const running = gmGet(K_RUNNING, 'false') === 'true';
        startBtn.textContent = running ? '■ 停止' : '🤖 自動取得';
        startBtn.style.background = running ? '#c62828' : '#1565c0';
    }

    function addStartButton() {
        if (!document.body) return;
        if (startBtn && document.body.contains(startBtn)) return;
        if (!startBtn) {
            startBtn = document.createElement('button');
            startBtn.setAttribute('style', [
                'position:fixed', 'bottom:20px', 'right:16px', 'z-index:2147483646',
                'padding:10px 18px', 'border:none', 'border-radius:10px',
                'background:#1565c0', 'color:#fff', 'font-size:13px',
                'cursor:pointer', 'font-weight:bold', 'box-shadow:0 2px 12px rgba(0,0,0,.5)',
            ].map(s => s + ' !important').join(';'));
            updateStartBtn();
            startBtn.onclick = () => {
                if (gmGet(K_RUNNING, 'false') === 'true') stopAuto(); else startAuto();
            };
        }
        document.body.appendChild(startBtn);
    }

    function keepAlive() {
        if (!document.body) return;
        addStartButton();
        if (overlayEl && !document.body.contains(overlayEl)) document.body.appendChild(overlayEl);
    }

    // ===== 初期化 =====
    document.addEventListener('DOMContentLoaded', () => {
        console.log('[KPR] DOMContentLoaded URL=', location.href, 'K_RUNNING=', gmGet(K_RUNNING, 'false'));
        addStartButton();
        setInterval(keepAlive, 800);
        if (gmGet(K_RUNNING, 'false') === 'true') {
            setTimeout(() => resumeAuto(), 2000);
        }
    });

})();
