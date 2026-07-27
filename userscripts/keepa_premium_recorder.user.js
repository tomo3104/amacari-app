// ==UserScript==
// @name         Keepa プレミアム価格記録
// @namespace    http://tampermonkey.net/
// @version      3.18
// @description  KeepaページでASINの価格をFlotチャートから直接取得・記録（XHR書き換えなし）
// @match        https://keepa.com/*
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/keepa_premium_recorder.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/keepa_premium_recorder.user.js
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
    'use strict';

    const SERVER    = 'http://localhost:8766';
    const K_QUEUE   = 'kpr_queue';
    const K_INDEX     = 'kpr_index';
    const K_RUNNING   = 'kpr_running';
    const K_HEARTBEAT = 'kpr_heartbeat';

    const gmGet = (k, d) => GM_getValue(k, d);
    const gmSet = (k, v) => GM_setValue(k, v);
    const gmDel = (k)    => GM_deleteValue(k);

    // ===== document-start: ?r=中継URLを検知したら即クリーンURLへリダイレクト =====
    if (unsafeWindow.location.search.includes('r=') &&
        gmGet(K_RUNNING, 'false') === 'true' &&
        unsafeWindow.location.hash.includes('#!product/')) {
        const cleanUrl = 'https://keepa.com/' + unsafeWindow.location.hash;
        console.log('[KPR] 中継URL検知 → クリーンURLへ:', cleanUrl);
        unsafeWindow.location.replace(cleanUrl);
        return;
    }

    // NOTE: XHR/fetch/WebSocket/SSE/IDB の書き換えは一切行わない
    //       KeepaがXHRプロトタイプ改変を検知してAPIコールを止めるため

    let autoRunning = false;
    let autoTimer   = null;
    let cdTimer     = null;
    let pollTimer   = null;
    let handled     = false;
    let resumed     = false;
    let startBtn    = null;
    let overlayEl   = null;

    // ===== Flotチャートから価格を読み取る =====
    function keepaTsToDateStr(ts) {
        // Flot X軸はUnix ms。1e10より小さければKeepaミリ分換算
        const ms = ts > 1e10 ? ts : (ts + 21564000) * 60000;
        const d = new Date(ms);
        return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')}`;
    }

    function readFlotPrice() {
        try {
            const $ = unsafeWindow.jQuery || unsafeWindow.$;
            if (!$) return null;
            const canvas = document.querySelector('.flot-base');
            if (!canvas) return null;
            const plot = $(canvas.parentElement).data('plot');
            if (!plot) return null;
            const allSeries = plot.getData();
            if (!allSeries || !allSeries.length) return null;

            const candidates = [];
            allSeries.forEach(series => {
                if (!series.data || !series.data.length) return;
                // ランク系列（Y軸2本目 or 値が極端に大きい）をスキップ
                if (series.yaxis && series.yaxis.n === 2) return;
                for (let j = series.data.length - 1; j >= 0; j--) {
                    if (!series.data[j]) continue;
                    const p = series.data[j][1];
                    const ts = series.data[j][0];
                    if (p > 0 && p < 5000000) { candidates.push({ price: p, ts }); break; }
                }
            });
            if (!candidates.length) return null;
            console.log('[KPR] Flot価格候補:', candidates);
            candidates.sort((a, b) => b.price - a.price);
            const best = candidates[0];
            return { price: best.price, date: keepaTsToDateStr(best.ts) };
        } catch (e) {
            console.log('[KPR] readFlotPrice例外:', e);
            return null;
        }
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
        clearInterval(pollTimer);
        gmSet(K_RUNNING, 'false');
        updateStartBtn();
        if (overlayEl) { overlayEl.remove(); overlayEl = null; }
    }

    function goToAsin(asin) {
        gmSet(K_HEARTBEAT, String(Date.now()));
        const url = `https://keepa.com/?r=${Date.now()}#!product/5-${asin}`;
        console.log('[KPR] goToAsin(中継):', url);
        unsafeWindow.location.href = url;
    }

    function goNext() {
        clearTimeout(autoTimer);
        clearInterval(cdTimer);
        clearInterval(pollTimer);
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

    function onAutoResult(asin, priceObj) {
        if (handled) return;
        handled = true;
        clearTimeout(autoTimer);
        clearInterval(cdTimer);
        clearInterval(pollTimer);

        const price   = priceObj ? priceObj.price : null;
        const dateStr = priceObj ? priceObj.date  : null;
        console.log('[KPR] onAutoResult: price=', price, 'date=', dateStr);

        const queue = JSON.parse(gmGet(K_QUEUE, '[]'));
        const index = parseInt(gmGet(K_INDEX, '0'));
        const cand  = queue[index] || {};

        if (!price) {
            showAutoOverlay(cand, index, queue.length, null, null, '価格データなし - スキップ');
            setTimeout(() => goNext(), 1500);
            return;
        }

        showAutoOverlay(cand, index, queue.length, price, dateStr, '送信中...');
        GM_xmlhttpRequest({
            method: 'POST', url: `${SERVER}/save-premium-price`,
            headers: { 'Content-Type': 'application/json' },
            data: JSON.stringify({ asin: asin || cand.asin, price }), timeout: 30000,
            onload: res => {
                try {
                    const r = JSON.parse(res.responseText);
                    if (r.ok) showAutoOverlay(cand, index, queue.length, price, dateStr, `✅ 記録完了 pmax¥${r.pmax.toLocaleString()}`);
                    else      showAutoOverlay(cand, index, queue.length, price, dateStr, `⚠ ${r.error || 'エラー'}`);
                } catch (e) { showAutoOverlay(cand, index, queue.length, price, dateStr, '⚠ 通信エラー'); }
                setTimeout(() => goNext(), 2000);
            },
            onerror:   () => { showAutoOverlay(cand, index, queue.length, price, dateStr, '⚠ サーバー未起動'); setTimeout(() => goNext(), 2000); },
            ontimeout: () => { showAutoOverlay(cand, index, queue.length, price, dateStr, '⚠ 送信タイムアウト'); setTimeout(() => goNext(), 2000); },
        });
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

        let sec = 25;
        const updateCd = () => {
            showAutoOverlay(cand, index, queue.length, null, `チャート読み込み待機中... (${sec}秒)`);
            sec--;
        };
        updateCd();
        cdTimer = setInterval(updateCd, 1000);

        // 毎秒Flotチャートをポーリングして価格を取得
        pollTimer = setInterval(() => {
            if (handled) { clearInterval(pollTimer); return; }
            const result = readFlotPrice();
            if (result !== null) {
                const asin = (unsafeWindow.location.hash.match(/product\/5-([A-Z0-9]+)/) || [])[1];
                console.log('[KPR] チャート価格取得:', asin, '→', result.price, result.date);
                onAutoResult(asin, result);
            }
        }, 1000);

        autoTimer = setTimeout(() => {
            clearInterval(cdTimer);
            clearInterval(pollTimer);
            if (!handled) {
                console.log('[KPR] タイムアウト → スキップ');
                showAutoOverlay(cand, index, queue.length, null, '⚠ タイムアウト - スキップ');
                setTimeout(() => goNext(), 1000);
            }
        }, 25000);
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

    function showAutoOverlay(cand, index, total, price, dateStr, status) {
        const el = getOrCreate('kpr-overlay');
        el.setAttribute('style', OV_STYLE);
        el.innerHTML = `
            <div style="font-size:11px;color:#aaa;margin-bottom:2px;">🤖 自動取得中  [${index + 1} / ${total}]</div>
            <div style="font-size:11px;color:#aaa;">型番: <b style="color:#ddd">${cand.model || '-'}</b></div>
            <div style="font-size:11px;color:#aaa;margin-bottom:8px;">ASIN: ${cand.asin || '-'}</div>
            ${price ? `<div style="color:#fff;font-weight:bold;font-size:18px;margin-bottom:2px;">¥${price.toLocaleString()}</div>` : ''}
            ${dateStr ? `<div style="color:#80cbc4;font-size:10px;margin-bottom:6px;">${dateStr}時点</div>` : ''}
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

    function showManualOverlay(asin, price, dateStr) {
        if (overlayEl) { overlayEl.remove(); overlayEl = null; }
        const box = document.createElement('div');
        box.id = 'kpr-overlay';
        overlayEl = box;
        box.setAttribute('style', OV_STYLE);
        box.innerHTML = `
            <button id="kpr-close" style="position:absolute;top:8px;right:10px;background:none;border:none;color:#aaa;cursor:pointer;font-size:14px;">✕</button>
            <div style="font-size:11px;color:#aaa;margin-bottom:4px;">📦 プレミアム価格記録</div>
            <div style="font-size:11px;color:#aaa;margin-bottom:10px;">ASIN: ${asin}</div>
            <div style="margin-bottom:8px;">
                <span style="color:#aaa;font-size:11px;">チャート取得価格（編集可）${dateStr ? `<span style="color:#80cbc4;margin-left:6px;">${dateStr}時点</span>` : ''}</span><br>
                <input id="kpr-price" type="number" value="${price}"
                    style="width:100%;padding:6px;border-radius:6px;border:1px solid #3a4a5a;
                           background:#0d1921 !important;color:#fff !important;font-size:14px;margin-top:4px;box-sizing:border-box;">
            </div>
            <button id="kpr-save" style="width:100%;padding:9px;border:none;border-radius:8px;
                background:#2e7d32 !important;color:#fff !important;font-size:13px;cursor:pointer;font-weight:bold;">📥 記録する</button>
            <div id="kpr-status" style="margin-top:8px;font-size:11px;color:#aaa;text-align:center;min-height:16px;"></div>`;
        const attach = () => {
            document.body.appendChild(box);
            document.getElementById('kpr-close').onclick = () => { box.remove(); overlayEl = null; };
            const saveBtn = document.getElementById('kpr-save');
            if (saveBtn) {
                saveBtn.onclick = () => {
                    const p = parseInt(document.getElementById('kpr-price').value);
                    if (!p || p <= 0) { alert('価格を入力してください'); return; }
                    saveBtn.disabled = true; saveBtn.textContent = '送信中…';
                    GM_xmlhttpRequest({
                        method: 'POST', url: `${SERVER}/save-premium-price`,
                        headers: { 'Content-Type': 'application/json' },
                        data: JSON.stringify({ asin, price: p }), timeout: 30000,
                        onload: res => {
                            try {
                                const r = JSON.parse(res.responseText);
                                if (r.ok) {
                                    saveBtn.textContent = '✅ 記録完了'; saveBtn.style.background = '#1565c0';
                                    document.getElementById('kpr-status').textContent =
                                        `pmax ¥${r.pmax.toLocaleString()}  手数料 ¥${r.fee.toLocaleString()}`;
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

        // タブ復帰時の停止検知: 自動実行中なのにautoRunningがfalseなら再起動
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible' &&
                gmGet(K_RUNNING, 'false') === 'true' && !autoRunning) {
                console.log('[KPR] タブ復帰 → 再起動');
                location.reload();
            }
        });

        // 起動時チェック: ハートビートが120秒以上古ければ何らかの理由で止まった
        if (gmGet(K_RUNNING, 'false') === 'true') {
            const hb = parseInt(gmGet(K_HEARTBEAT, '0'));
            if (hb > 0 && Date.now() - hb > 120000 && !unsafeWindow.location.search.includes('r=')) {
                console.log('[KPR] ハートビート古い → 再起動');
                const queue = JSON.parse(gmGet(K_QUEUE, '[]'));
                const index = parseInt(gmGet(K_INDEX, '0'));
                if (queue.length && index < queue.length) {
                    goToAsin(queue[index].asin);
                    return;
                }
            }
        }

        if (gmGet(K_RUNNING, 'false') === 'true') {
            // 自動モード: Keepaのチャート描画を待ってから開始
            setTimeout(() => resumeAuto(), 3000);
        } else if (unsafeWindow.location.hash.includes('#!product/')) {
            // 手動モード: チャートが描画されたら価格オーバーレイを表示
            let manualAttempts = 0;
            const manualPoll = setInterval(() => {
                manualAttempts++;
                const result = readFlotPrice();
                if (result !== null) {
                    clearInterval(manualPoll);
                    const asin = (unsafeWindow.location.hash.match(/product\/5-([A-Z0-9]+)/) || [])[1];
                    if (asin) showManualOverlay(asin, result.price, result.date);
                } else if (manualAttempts > 30) {
                    clearInterval(manualPoll);
                    console.log('[KPR] 手動モード: 30秒でタイムアウト');
                }
            }, 1000);
        }
    });

})();
