// ==UserScript==
// @name         Mercari Purchase Extract
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  購入履歴（/mypage/purchases）から追跡番号・日付・出品者名・商品代金を抽出し「メルカリ抽出」シートに追記する
// @match        https://jp.mercari.com/*
// @noframes
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_purchase_extract.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_purchase_extract.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER_URL     = 'http://localhost:8769/purchase-extract';
    const PROCESSED_KEY  = 'sales_purchase_processed'; // 処理済み取引IDの蓄積（重複抽出防止）
    const PROCESSED_MAX  = 2000;

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function getProcessedSet() {
        try {
            return new Set(JSON.parse(localStorage.getItem(PROCESSED_KEY) || '[]'));
        } catch (e) {
            return new Set();
        }
    }

    function saveProcessedSet(set) {
        let arr = Array.from(set);
        if (arr.length > PROCESSED_MAX) arr = arr.slice(-PROCESSED_MAX);
        localStorage.setItem(PROCESSED_KEY, JSON.stringify(arr));
    }

    const statusEl = document.createElement('div');
    statusEl.style.cssText = `
        position:fixed; bottom:20px; right:20px; z-index:99999;
        background:rgba(0,0,0,0.80); color:#fff; padding:8px 16px;
        border-radius:8px; font-size:13px; display:none;
        max-width:360px; font-family:sans-serif; line-height:1.5;
    `;
    document.body.appendChild(statusEl);
    function showStatus(msg, bg) {
        statusEl.style.display = 'block';
        statusEl.style.background = bg || 'rgba(0,0,0,0.80)';
        statusEl.textContent = msg;
    }

    // 取引ページ（同一オリジンiframe）から必要な4項目を抽出
    function extractFromDoc(doc) {
        const result = { tracking: '', day: '', seller: '', price: '' };

        const trackingEl = doc.querySelector('[data-partner-id="tracking-number"] a[data-testid="tracking-url"]');
        if (trackingEl) result.tracking = trackingEl.textContent.trim();

        const sellerEl = doc.querySelector('a[data-testid="seller-link"] p');
        if (sellerEl) result.seller = sellerEl.textContent.trim();

        function findRowValue(labelText) {
            const spans = doc.querySelectorAll('span');
            for (const span of spans) {
                if (span.children.length === 0 && span.textContent.trim() === labelText) {
                    const row = span.closest('[class*="merDisplayRow"]');
                    if (!row) continue;
                    const body = row.querySelector('[class*="body__"]');
                    if (body) return body.textContent.trim();
                }
            }
            return '';
        }

        const priceText = findRowValue('商品代金');
        if (priceText) {
            const digits = priceText.replace(/[^\d]/g, '');
            if (digits) result.price = digits;
        }

        const dateText = findRowValue('購入日時'); // 例: "2026年8月13日 11:39"
        if (dateText) {
            const m = dateText.match(/(\d+)日/);
            if (m) result.day = m[1];
        }

        return result;
    }

    // 同一オリジンiframeで取引ページを読み込み、必要な4項目が揃うまでポーリング
    function fetchTransaction(transactionId) {
        const url = `https://jp.mercari.com/transaction/${transactionId}`;
        return new Promise(resolve => {
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:390px;height:844px;border:none;visibility:hidden;pointer-events:none;';
            document.body.appendChild(iframe);

            let done = false;
            const finish = result => {
                if (done) return;
                done = true;
                try { iframe.remove(); } catch (e) {}
                resolve(result);
            };

            const hardTimer = setTimeout(() => finish(null), 8000);

            iframe.onload = () => {
                let tries = 0;
                const poll = setInterval(() => {
                    try {
                        const doc = iframe.contentDocument;
                        if (!doc || !doc.body) return;

                        const bodyText = doc.body.innerText || '';
                        if (bodyText.includes('このページは存在しません') || bodyText.includes('取引情報')) {
                            const info = extractFromDoc(doc);
                            // 価格・日付・出品者が全部揃うまで待つ（追跡番号は未発送だと無いこともある）
                            if (info.price && info.day && info.seller) {
                                clearInterval(poll);
                                clearTimeout(hardTimer);
                                finish(info);
                                return;
                            }
                        }
                    } catch (e) {
                        clearInterval(poll);
                        clearTimeout(hardTimer);
                        finish(null);
                        return;
                    }
                    if (++tries > 40) { // 40 x 200ms = 8秒
                        clearInterval(poll);
                        clearTimeout(hardTimer);
                        finish(null);
                    }
                }, 200);
            };

            iframe.onerror = () => { clearTimeout(hardTimer); finish(null); };
            iframe.src = url;
        });
    }

    function sendToServer(items) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST',
                url: SERVER_URL,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ items }),
                timeout: 30000,
                onload: () => resolve(true),
                onerror: () => resolve(false),
                ontimeout: () => resolve(false),
            });
        });
    }

    function collectTransactionIds() {
        const links = Array.from(document.querySelectorAll('a[href*="/transaction/"]'));
        const ids = [];
        const seen = new Set();
        for (const a of links) {
            const m = a.getAttribute('href').match(/\/transaction\/(m[A-Za-z0-9]+)/);
            if (m && !seen.has(m[1])) {
                seen.add(m[1]);
                ids.push(m[1]);
            }
        }
        return ids;
    }

    async function runExtract(forceAll) {
        showStatus('購入履歴を読み込み中...');
        const allIds = collectTransactionIds();
        const processedSet = forceAll ? new Set() : getProcessedSet();
        const targetIds = allIds.filter(id => !processedSet.has(id));

        if (targetIds.length === 0) {
            showStatus(`新規の購入はありませんでした（表示中${allIds.length}件、すべて処理済み）`, 'rgba(0,70,120,0.88)');
            await sleep(3000);
            statusEl.style.display = 'none';
            return;
        }

        showStatus(`対象: ${targetIds.length}件 / 抽出中...`);
        const results = [];
        for (let i = 0; i < targetIds.length; i++) {
            const id = targetIds[i];
            showStatus(`[${i + 1}/${targetIds.length}] ${id} 抽出中...`);
            const info = await fetchTransaction(id);
            if (info) {
                results.push(info);
                processedSet.add(id);
            } else {
                showStatus(`[${i + 1}/${targetIds.length}] ${id} 抽出失敗（未発送等でスキップ、次回再試行）`);
                await sleep(1500);
            }
            await sleep(500);
        }

        if (results.length > 0) {
            showStatus(`${results.length}件をシートへ送信中...`);
            const ok = await sendToServer(results);
            if (ok) {
                saveProcessedSet(processedSet);
                showStatus(`完了: ${results.length}件をメルカリ抽出シートに追記しました`, 'rgba(0,110,0,0.88)');
            } else {
                showStatus('送信失敗（サーバー起動確認: localhost:8769）', 'rgba(160,0,0,0.88)');
            }
        } else {
            showStatus('抽出できた件数が0件でした', 'rgba(160,80,0,0.88)');
        }
        await sleep(4000);
        statusEl.style.display = 'none';
    }

    function runPurchasesPageMode() {
        const btn = document.createElement('button');
        btn.textContent = '購入履歴を抽出';
        btn.style.cssText = `
            position:fixed; bottom:20px; left:20px; z-index:99999;
            padding:12px 18px; background:#00A968; color:#fff;
            border:none; border-radius:6px; font-size:14px;
            cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        btn.onclick = () => { runExtract(false); };
        document.body.appendChild(btn);

        const forceBtn = document.createElement('button');
        forceBtn.textContent = '強制再抽出（表示中の全件）';
        forceBtn.style.cssText = `
            position:fixed; bottom:20px; left:170px; z-index:99999;
            padding:12px 18px; background:#E65100; color:#fff;
            border:none; border-radius:6px; font-size:14px;
            cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        forceBtn.onclick = () => {
            if (confirm('表示中の購入履歴を全件、処理済みかどうかに関わらず再抽出します（重複が増える可能性があります）。よろしいですか？')) {
                runExtract(true);
            }
        };
        document.body.appendChild(forceBtn);
    }

    // ========================================================
    //  モード判定（購入履歴ページでのみボタン表示）
    // ========================================================
    if (location.pathname === '/mypage/purchases') {
        runPurchasesPageMode();
    }
})();
