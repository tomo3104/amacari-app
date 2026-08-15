// ==UserScript==
// @name         Mercari Purchase Extract
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  購入履歴（/mypage/purchases）から追跡番号・日付・出品者名・商品代金を抽出し「メルカリ抽出」シートに追記する（実ページ遷移方式・取引画面はiframe埋め込み不可のため・ボタンを右上に集約・中止ボタン追加・待ち時間延長(約24秒)＋診断ログ追加）
// @match        https://jp.mercari.com/*
// @noframes
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_purchase_extract.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_purchase_extract.user.js
// ==/UserScript==

(function () {
    'use strict';

    // ========================================================
    //  定数（早期returnより必ず前に置く。TDZバグ再発防止のため一箇所にまとめる）
    // ========================================================
    const SERVER_URL     = 'http://localhost:8769/purchase-extract';
    const PROCESSED_KEY  = 'sales_purchase_processed'; // 処理済み取引IDの蓄積（重複抽出防止）
    const PROCESSED_MAX  = 2000;
    const QUEUE_KEY       = 'sales_purchase_queue';     // 巡回中の状態（実ページ遷移で使う）
    const RESULT_KEY      = 'sales_purchase_results';   // 巡回中に貯める抽出結果

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function getProcessedSet() {
        try {
            return new Set(JSON.parse(localStorage.getItem(PROCESSED_KEY) || '[]'));
        } catch (e) {
            return new Set();
        }
    }

    function addProcessed(id) {
        const set = getProcessedSet();
        set.add(id);
        let arr = Array.from(set);
        if (arr.length > PROCESSED_MAX) arr = arr.slice(-PROCESSED_MAX);
        localStorage.setItem(PROCESSED_KEY, JSON.stringify(arr));
    }

    const statusEl = document.createElement('div');
    statusEl.style.cssText = `
        position:fixed; top:70px; right:20px; z-index:99999;
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

    // 取引ページのdocumentから必要な4項目を抽出
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

    // ========================================================
    //  購入履歴ページモード：ボタン表示 → キュー作成 → 1件目へ遷移
    // ========================================================
    function startExtract(forceAll) {
        showStatus('購入履歴を読み込み中...');
        const allIds = collectTransactionIds();
        const processedSet = forceAll ? new Set() : getProcessedSet();
        const targetIds = allIds.filter(id => !processedSet.has(id));

        if (targetIds.length === 0) {
            showStatus(`新規の購入はありませんでした（表示中${allIds.length}件、すべて処理済み）`, 'rgba(0,70,120,0.88)');
            return;
        }

        const queue = { ids: targetIds, currentIdx: 0, running: true };
        localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
        localStorage.setItem(RESULT_KEY, JSON.stringify([]));

        showStatus(`対象: ${targetIds.length}件 → 巡回開始...`);
        setTimeout(() => {
            window.location.href = `https://jp.mercari.com/transaction/${targetIds[0]}`;
        }, 800);
    }

    function runPurchasesPageMode() {
        const btn = document.createElement('button');
        btn.textContent = '購入履歴を抽出';
        btn.style.cssText = `
            position:fixed; top:110px; right:20px; z-index:99999;
            padding:12px 18px; background:#00A968; color:#fff;
            border:none; border-radius:6px; font-size:14px;
            cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        btn.onclick = () => { startExtract(false); };
        document.body.appendChild(btn);

        const forceBtn = document.createElement('button');
        forceBtn.textContent = '強制再抽出（表示中の全件）';
        forceBtn.style.cssText = `
            position:fixed; top:155px; right:20px; z-index:99999;
            padding:12px 18px; background:#E65100; color:#fff;
            border:none; border-radius:6px; font-size:14px;
            cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        forceBtn.onclick = () => {
            if (confirm('表示中の購入履歴を全件、処理済みかどうかに関わらず再抽出します（重複が増える可能性があります）。よろしいですか？')) {
                startExtract(true);
            }
        };
        document.body.appendChild(forceBtn);

        // 巡回が中断されて戻ってきた場合の再開・破棄ボタン
        const queueStr = localStorage.getItem(QUEUE_KEY);
        if (queueStr) {
            try {
                const q = JSON.parse(queueStr);
                if (q.running) {
                    const resumeBtn = document.createElement('button');
                    resumeBtn.textContent = `巡回を再開 (${q.currentIdx + 1}/${q.ids.length}件目から)`;
                    resumeBtn.style.cssText = `
                        position:fixed; top:200px; right:20px; z-index:99999;
                        padding:10px 16px; background:#1565C0; color:#fff;
                        border:none; border-radius:6px; font-size:13px;
                        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
                    `;
                    resumeBtn.onclick = () => {
                        window.location.href = `https://jp.mercari.com/transaction/${q.ids[q.currentIdx]}`;
                    };
                    document.body.appendChild(resumeBtn);

                    const discardBtn = document.createElement('button');
                    discardBtn.textContent = '中断した巡回を破棄';
                    discardBtn.style.cssText = `
                        position:fixed; top:245px; right:20px; z-index:99999;
                        padding:8px 14px; background:#B71C1C; color:#fff;
                        border:none; border-radius:6px; font-size:12px;
                        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
                    `;
                    discardBtn.onclick = () => {
                        localStorage.removeItem(QUEUE_KEY);
                        localStorage.removeItem(RESULT_KEY);
                        resumeBtn.remove();
                        discardBtn.remove();
                        showStatus('中断していた巡回を破棄しました', 'rgba(160,80,0,0.88)');
                    };
                    document.body.appendChild(discardBtn);
                }
            } catch (e) {}
        }
    }

    // ========================================================
    //  取引ページモード：抽出 → 処理済み記録 → 次へ遷移 or 完了送信
    // ========================================================
    function runTransactionPageMode(currentId) {
        const queueStr = localStorage.getItem(QUEUE_KEY);
        if (!queueStr) return; // 巡回中でなければ何もしない

        let queue;
        try { queue = JSON.parse(queueStr); } catch (e) { return; }
        if (!queue.running) return;

        const idx = queue.ids.indexOf(currentId);
        if (idx === -1) return; // このタブは巡回対象外の取引ページ（手動で見ているだけ）

        const total = queue.ids.length;
        showStatus(`[${idx + 1}/${total}] 抽出中...`);

        const abortBtn = document.createElement('button');
        abortBtn.textContent = '中止';
        abortBtn.style.cssText = `
            position:fixed; top:110px; right:20px; z-index:99999;
            padding:10px 16px; background:#B71C1C; color:#fff;
            border:none; border-radius:6px; font-size:13px;
            cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        abortBtn.onclick = async () => {
            abortBtn.disabled = true;
            abortBtn.textContent = '中止処理中...';
            localStorage.removeItem(QUEUE_KEY);
            const results = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]');
            if (results.length > 0) {
                showStatus(`中止: それまでの${results.length}件をシートへ送信中...`, 'rgba(160,80,0,0.88)');
                const ok = await sendToServer(results);
                localStorage.removeItem(RESULT_KEY);
                showStatus(ok ? `中止しました（${results.length}件は送信済み）` : '中止（送信失敗）', 'rgba(160,80,0,0.88)');
            } else {
                showStatus('中止しました（送信対象なし）', 'rgba(160,80,0,0.88)');
            }
            await sleep(1500);
            window.location.href = 'https://jp.mercari.com/mypage/purchases';
        };
        document.body.appendChild(abortBtn);

        const doExtract = (retries) => {
            const bodyText = document.body.innerText || '';
            const hasHeading = bodyText.includes('取引情報');
            const info = hasHeading ? extractFromDoc(document) : { price: '', day: '', seller: '', tracking: '' };
            console.log(`[purchase-extract] retries=${retries} hasHeading=${hasHeading} info=`, JSON.stringify(info));
            if (hasHeading) {
                if (info.price && info.day && info.seller) {
                    const results = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]');
                    results.push(info);
                    localStorage.setItem(RESULT_KEY, JSON.stringify(results));
                    addProcessed(currentId);
                    showStatus(`[${idx + 1}/${total}] 抽出成功: ${info.seller} / ¥${info.price}`, 'rgba(0,110,0,0.88)');
                    goNext();
                    return;
                }
            }
            if (retries > 0) {
                setTimeout(() => doExtract(retries - 1), 400);
            } else {
                console.log(`[purchase-extract] 抽出失敗 id=${currentId} 最終info=`, JSON.stringify(info));
                showStatus(`[${idx + 1}/${total}] ${currentId} 抽出失敗（未発送等）→ スキップ`, 'rgba(160,80,0,0.88)');
                setTimeout(goNext, 1000);
            }
        };

        async function goNext() {
            const nextIdx = idx + 1;
            if (nextIdx < total) {
                queue.currentIdx = nextIdx;
                localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
                await sleep(800);
                window.location.href = `https://jp.mercari.com/transaction/${queue.ids[nextIdx]}`;
            } else {
                localStorage.removeItem(QUEUE_KEY);
                const results = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]');
                if (results.length > 0) {
                    showStatus(`${results.length}件をシートへ送信中...`);
                    const ok = await sendToServer(results);
                    localStorage.removeItem(RESULT_KEY);
                    if (ok) {
                        showStatus(`完了: ${results.length}件をメルカリ抽出シートに追記しました`, 'rgba(0,110,0,0.88)');
                    } else {
                        showStatus('送信失敗（サーバー起動確認: localhost:8769）', 'rgba(160,0,0,0.88)');
                    }
                } else {
                    showStatus('抽出できた件数が0件でした', 'rgba(160,80,0,0.88)');
                }
                await sleep(1500);
                window.location.href = 'https://jp.mercari.com/mypage/purchases';
            }
        }

        // DOMのレンダリングを待ちながら抽出（最大8秒 = 40 x 200ms）
        // 最大 500ms + 60 x 400ms = 約24.5秒待つ（フルページ読み込み+データ取得の余裕を持たせる）
        setTimeout(() => doExtract(60), 500);
    }

    // ========================================================
    //  モード判定
    // ========================================================
    const transactionMatch = location.pathname.match(/^\/transaction\/(m[A-Za-z0-9]+)/);

    if (transactionMatch) {
        runTransactionPageMode(transactionMatch[1]);
    } else if (location.pathname === '/mypage/purchases') {
        runPurchasesPageMode();
    }
})();
