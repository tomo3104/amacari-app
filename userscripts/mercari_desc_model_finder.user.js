// ==UserScript==
// @name         Mercari Description Model Finder
// @namespace    http://tampermonkey.net/
// @version      2.31
// @description  タイトルに型番がない商品の説明文から型番を抽出してlist.jsonと照合（DOMアクセス方式）
// @match        https://jp.mercari.com/*
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_desc_model_finder.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_desc_model_finder.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER_URL      = 'http://localhost:8766/check-mercari';
    const PROGRESS_URL    = 'http://localhost:8766/save-progress';
    const SAVE_INTERVAL   = 30; // 何件ごとにサーバー中間送信するか
    const _SHARED_TPL_KEY = 'mercari_api_shared_tpl';
    const QUEUE_KEY       = 'desc_model_queue';
    const RESULT_KEY      = 'desc_model_results';
    const PROCESSED_KEY   = 'desc_model_processed'; // 処理済み商品IDの蓄積（重複読み込み防止）
    const _uw             = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // タイトルに型番が含まれるか判定
    // ダッシュ後は英字＋数字の両方を含む必要あり（Wi-Fi / PC-12台 などの誤検知を防ぐ）
    const HAS_MODEL_RE  = /\b(?:[A-Z]{2,}-(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{2,}|[A-Z]{1,3}[0-9]{3,}[A-Z0-9]*)\b/i;
    // 説明文から型番を抽出（ラベルあり）
    // 対応: 型番/品番/型式/型名/モデル/モデル番号/モデル名/製品番号/商品番号
    // セパレータ: ：/ : / 【】 / 空白 / 改行
    const DESC_MODEL_RE = /(?:【)?(?:型番|品番|型式|型名|モデル(?:番号|名)?|製品番号|商品番号)(?:】)?[：:\s]*([A-Za-z][A-Za-z0-9\-\/\.]{3,})/;
    // ラベルなしフォールバック: 英字2〜5文字-英数字3文字以上（例: SP-P10CUSBBK）大文字小文字不問
    const DESC_FALLBACK_RE = /\b([A-Za-z]{2,5}-[A-Za-z0-9]{3,}[A-Za-z0-9]*)\b/gi;
    // 説明文DOMセレクター（メルカリのPREタグ）
    const DESC_SEL      = 'pre[class*="merText"]';

    const MAX_PAGES = 20;

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function markProcessed(id) {
        const arr = JSON.parse(localStorage.getItem(PROCESSED_KEY) || '[]');
        if (!arr.includes(id)) {
            arr.push(id);
            if (arr.length > 10000) arr.splice(0, arr.length - 10000);
            localStorage.setItem(PROCESSED_KEY, JSON.stringify(arr));
        }
    }

    function _getSharedTpl() {
        try {
            const s = _uw.localStorage.getItem(_SHARED_TPL_KEY);
            return s ? JSON.parse(s) : null;
        } catch(e) { return null; }
    }

    function hasModelInTitle(title) { return HAS_MODEL_RE.test(title); }

    function extractModelFromDesc(text) {
        // ラベルあり優先
        const m = DESC_MODEL_RE.exec(text);
        if (m) return m[1].toUpperCase();
        // ラベルなしフォールバック（数字を含むもの・最長一致）
        const hits = [...text.matchAll(DESC_FALLBACK_RE)].filter(h => /\d/.test(h[1]));
        if (hits.length > 0) {
            return hits.reduce((a, b) => a[1].length >= b[1].length ? a : b)[1].toUpperCase();
        }
        return null;
    }

    // ===== ステータスUI（全ページ共通） =====
    const statusEl = document.createElement('div');
    statusEl.style.cssText = `
        position:fixed; bottom:20px; left:20px; z-index:99999;
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
    function hideStatus() { statusEl.style.display = 'none'; }

    // ========================================================
    //  モード判定
    // ========================================================
    const itemMatch = location.pathname.match(/^\/item\/(m[A-Za-z0-9]+)/);

    if (itemMatch) {
        // ============ 商品ページモード ============
        runItemPageMode(itemMatch[1]);
    } else {
        // キュー実行中にエラーページへリダイレクトされた場合、自動スキップして再開
        const _qStr = localStorage.getItem(QUEUE_KEY);
        if (_qStr) {
            try {
                const _q = JSON.parse(_qStr);
                if (_q.running && _q.items && _q.pendingIdx != null) {
                    const skipTo = _q.pendingIdx + 1;
                    if (skipTo < _q.items.length) {
                        // 次の遷移先も pendingIdx にセット（連続削除済み対応）
                        _q.pendingIdx = skipTo;
                        localStorage.setItem(QUEUE_KEY, JSON.stringify(_q));
                        showStatus(`削除済み商品をスキップ → [${skipTo + 1}/${_q.items.length}]`, 'rgba(160,80,0,0.88)');
                        setTimeout(() => { window.location.replace(_q.items[skipTo].url); }, 1000);
                    } else {
                        delete _q.pendingIdx;
                        localStorage.setItem(QUEUE_KEY, JSON.stringify(_q));
                        finishAndSend(null);
                    }
                    return;
                }
            } catch(e) {}
        }
        // ============ 起動ページモード ============
        runLaunchMode();
    }

    // ========================================================
    //  商品ページモード：DOMから説明文を読んで次へ進む
    // ========================================================
    function runItemPageMode(currentId) {
        const queueStr = localStorage.getItem(QUEUE_KEY);
        if (!queueStr) return; // スクリプト未起動なら何もしない

        let queue;
        try { queue = JSON.parse(queueStr); } catch(e) { return; }
        if (!queue.running) return;

        const items = queue.items;
        const idx   = items.findIndex(i => i.id === currentId);
        if (idx === -1) { localStorage.removeItem(QUEUE_KEY); return; }

        const total = items.length;

        // 正常到達：pendingIdx をクリアして currentIdx を更新
        delete queue.pendingIdx;
        queue.currentIdx = idx;
        localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));

        // この商品を処理済みとして記録（次回同じメーカーを調査する際にスキップ）
        markProcessed(currentId);

        // 照合して終了ボタン（収集停止＋即時照合）
        const stopBtn = document.createElement('button');
        stopBtn.textContent = '照合して終了';
        stopBtn.style.cssText = `
            position:fixed; bottom:110px; left:20px; z-index:99999;
            padding:8px 16px; background:#1976D2; color:#fff;
            border:none; border-radius:6px; font-size:13px; cursor:pointer;
            box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;
        stopBtn.onclick = () => {
            localStorage.removeItem(QUEUE_KEY);
            stopBtn.remove();
            finishAndSend(null);
        };
        document.body.appendChild(stopBtn);

        showStatus(`[${idx + 1}/${total}] 説明文を読み込み中...`);

        // 次ページへ進む内部関数
        function goNext() {
            if (!localStorage.getItem(QUEUE_KEY)) return; // 中止済み
            const nextIdx = idx + 1;
            if (nextIdx < total) {
                // 遷移先をQUEUEに記録（リダイレクト時に自動スキップするため）
                queue.pendingIdx = nextIdx;
                localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
                window.location.replace(items[nextIdx].url);
            } else {
                finishAndSend(stopBtn);
            }
        }

        // DOMのレンダリングを待ちながら説明文を取得
        const waitForDesc = (retries) => {
            if (!localStorage.getItem(QUEUE_KEY)) { stopBtn.remove(); return; } // 中止済み

            const el = document.querySelector(DESC_SEL);
            if (el && (el.innerText || '').trim().length > 5) {
                const desc  = el.innerText || '';
                const model = extractModelFromDesc(desc);

                // タイトルor説明文にセット・まとめ系ワードがあれば名前にフラグを付けてヒットに含める
                const SET_WORDS = ['セット', 'まとめ', 'まとめ売', 'セット売', '個セット', '台セット', '点セット', '本セット'];
                const itemName  = items[idx].name;
                const isBundle  = SET_WORDS.some(w => itemName.includes(w) || desc.includes(w));

                if (model) {
                    const results = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]');
                    const item    = items[idx];
                    const label   = isBundle ? `【セット】${item.name} ${model}` : `${item.name} ${model}`;
                    results.push({
                        name:  label,
                        model: model,
                        price: item.price,
                        url:   item.url,
                        image: item.image,
                    });
                    localStorage.setItem(RESULT_KEY, JSON.stringify(results));
                    const tag = isBundle ? '【セット】' : '';
                    showStatus(`[${idx + 1}/${total}] ${tag}型番取得: ${model}\n取得済: ${results.length}件`, 'rgba(20,110,0,0.88)');

                    // 30件ごとにサーバーへ中間保存（クラッシュ対策）
                    if (results.length % SAVE_INTERVAL === 0) {
                        sendProgress(results.slice(-SAVE_INTERVAL));
                    }
                } else {
                    const gotSoFar = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
                    showStatus(`[${idx + 1}/${total}] 型番なし → スキップ（取得済: ${gotSoFar}件）`);
                }

                setTimeout(goNext, 500);

            } else if (retries > 0) {
                setTimeout(() => waitForDesc(retries - 1), 300);
            } else {
                // タイムアウト → スキップ
                const gotSoFar = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
                showStatus(`[${idx + 1}/${total}] タイムアウト → スキップ（取得済: ${gotSoFar}件）`);
                setTimeout(goNext, 1000);
            }
        };

        // エラーページ（商品削除/売り切れ）を早期検出してスキップ
        function isErrorPage() {
            const bodyText = document.body.innerText || '';
            return bodyText.includes('このページは存在しません') ||
                   bodyText.includes('商品が見つかりません') ||
                   bodyText.includes('ページが見つかりません') ||
                   bodyText.includes('404');
        }

        // Reactのレンダリングが完了するまで待つ
        setTimeout(() => {
            if (isErrorPage()) {
                const gotSoFar = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;
                showStatus(`[${idx + 1}/${total}] 商品削除済み → スキップ（取得済: ${gotSoFar}件）`);
                setTimeout(goNext, 800);
            } else {
                window.scrollTo(0, 400); // 説明文が画面内に入るようスクロール（遅延読み込み対策）
                waitForDesc(40);
            }
        }, 1000);
    }

    // ========================================================
    //  中間保存（30件ごと）→ サーバーへ送信してシートに記録
    // ========================================================
    function sendProgress(items) {
        GM_xmlhttpRequest({
            method:  'POST',
            url:     PROGRESS_URL,
            headers: { 'Content-Type': 'application/json' },
            data:    JSON.stringify({ items, keyword: '' }),
            timeout: 30000,
            onload:  res => {
                try {
                    const r = JSON.parse(res.responseText);
                    if (r.ok) console.log(`[desc-finder] 中間保存: ${items.length}件`);
                } catch(e) {}
            },
            onerror: () => console.warn('[desc-finder] 中間保存失敗（サーバー未起動?）'),
        });
    }

    // ========================================================
    //  全件完了 → サーバーへ送信
    // ========================================================
    function finishAndSend(stopBtn) {
        const results = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]');
        localStorage.removeItem(QUEUE_KEY);
        if (stopBtn) stopBtn.remove();

        if (results.length === 0) {
            localStorage.removeItem(RESULT_KEY);
            showStatus('説明文から型番を取得できた商品はありませんでした', 'rgba(100,80,0,0.88)');
            setTimeout(hideStatus, 6000);
            return;
        }

        showStatus(`説明文型番 ${results.length}件 → list.jsonと照合中...`, 'rgba(0,70,160,0.88)');

        GM_xmlhttpRequest({
            method:  'POST',
            url:     SERVER_URL,
            headers: { 'Content-Type': 'application/json' },
            data:    JSON.stringify({ items: results, source: 'desc' }),
            timeout: 120000,
            onload: res => {
                localStorage.removeItem(RESULT_KEY);
                try {
                    const result = JSON.parse(res.responseText);
                    showResults(result.matches || []);
                } catch(e) {
                    showStatus('サーバー応答エラー', 'rgba(160,0,0,0.88)');
                }
            },
            ontimeout: () => {
                localStorage.removeItem(RESULT_KEY);
                showStatus('タイムアウト — ヒットはシートに保存済み', 'rgba(100,80,0,0.88)');
            },
            onerror: () => showStatus(
                `サーバー未起動 — ${results.length}件のデータは保持中。サーバー起動後にメルカリ検索ページを開いて「照合して送信」を押してください`,
                'rgba(160,0,0,0.88)'
            ),
        });
    }

    // ========================================================
    //  起動ページモード：ボタン表示 → 収集開始
    // ========================================================
    function runLaunchMode() {
        const btnContainer = document.createElement('div');
        btnContainer.style.cssText = `
            position:fixed; bottom:130px; left:20px; z-index:99999;
            display:flex; flex-direction:column; align-items:flex-start; gap:8px;
        `;

        const searchBtn = document.createElement('button');
        searchBtn.textContent = '説明文リサーチ（現在の検索）';
        searchBtn.style.cssText = `
            padding:12px 18px; background:#C49A00; color:#fff;
            border:none; border-radius:6px; font-size:14px;
            cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
        `;

        // 前回の途中データが残っていれば「再開」ボタンを追加
        const existingQueueStr = localStorage.getItem(QUEUE_KEY);
        if (existingQueueStr) {
            try {
                const existingQueue = JSON.parse(existingQueueStr);
                if (existingQueue.running && existingQueue.items && existingQueue.items.length > 0) {
                    const resumeIdx   = existingQueue.currentIdx || 0;
                    const totalItems  = existingQueue.items.length;
                    const savedResults = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]').length;

                    const resumeBtn = document.createElement('button');
                    resumeBtn.textContent = `途中から再開 (${resumeIdx + 1}/${totalItems}件目 取得済:${savedResults}件)`;
                    resumeBtn.style.cssText = `
                        padding:10px 16px; background:#1565C0; color:#fff;
                        border:none; border-radius:6px; font-size:13px;
                        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
                    `;
                    resumeBtn.onclick = () => {
                        existingQueue.pendingIdx = resumeIdx;
                        localStorage.setItem(QUEUE_KEY, JSON.stringify(existingQueue));
                        showStatus(`再開: ${resumeIdx + 1}件目から...`);
                        window.location.replace(existingQueue.items[resumeIdx].url);
                    };
                    btnContainer.appendChild(resumeBtn);
                }
            } catch(e) {}
        }

        // サーバー未起動で終了した場合に残った結果データを送信するボタン
        const savedResults = JSON.parse(localStorage.getItem(RESULT_KEY) || '[]');
        if (savedResults.length > 0 && !existingQueueStr) {
            const retryBtn = document.createElement('button');
            retryBtn.textContent = `照合して送信（保存済み${savedResults.length}件）`;
            retryBtn.style.cssText = `
                padding:10px 16px; background:#B71C1C; color:#fff;
                border:none; border-radius:6px; font-size:13px;
                cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
            `;
            retryBtn.onclick = () => { retryBtn.remove(); finishAndSend(null); };
            btnContainer.appendChild(retryBtn);
        }

        btnContainer.appendChild(searchBtn);
        document.body.appendChild(btnContainer);

        searchBtn.addEventListener('click', async () => {
            const tpl = _getSharedTpl();
            if (!tpl) {
                showStatus('テンプレート未取得 → 先にメルカリで1回検索してください', 'rgba(160,0,0,0.88)');
                return;
            }

            searchBtn.disabled = true;
            searchBtn.textContent = '収集中...';

            showStatus(`現在の検索条件で収集中...`);
            let allItems;
            try {
                allItems = await fetchItems(tpl);
            } catch(e) {
                showStatus(`収集エラー: ${e.message}`, 'rgba(160,0,0,0.88)');
                searchBtn.disabled = false;
                searchBtn.textContent = '説明文リサーチ（現在の検索）';
                return;
            }

            const itemList      = Object.values(allItems);
            const processedSet  = new Set(JSON.parse(localStorage.getItem(PROCESSED_KEY) || '[]'));
            const allNoModelItems = itemList.filter(item => !hasModelInTitle(item.name));
            const noModelItems  = allNoModelItems.filter(item => !processedSet.has(item.id));
            const skippedCount  = allNoModelItems.length - noModelItems.length;

            const skipMsg = skippedCount > 0 ? ` (${skippedCount}件スキップ済み)` : '';
            showStatus(`${itemList.length}件収集 → 型番なし: ${allNoModelItems.length}件${skipMsg} → 未処理: ${noModelItems.length}件`);

            if (noModelItems.length === 0) {
                let msg;
                if (itemList.length === 0) {
                    msg = '前回実行以降の新着なし（スキャン対象ゼロ）';
                } else if (allNoModelItems.length === 0) {
                    msg = `収集した${itemList.length}件 全商品のタイトルに型番あり → 説明文スキャン不要`;
                } else {
                    msg = `型番なし${allNoModelItems.length}件はすべてスキャン済み（スキップ${skippedCount}件）`;
                }
                showStatus(msg, 'rgba(100,80,0,0.88)');
                searchBtn.disabled = false;
                searchBtn.textContent = '説明文リサーチ（現在の検索）';
                return;
            }

            // キューを保存して最初の商品ページへ遷移
            localStorage.setItem(QUEUE_KEY, JSON.stringify({
                items:      noModelItems,
                running:    true,
                startedAt:  Date.now(),
                pendingIdx: 0,
            }));
            localStorage.setItem(RESULT_KEY, JSON.stringify([]));

            showStatus(`${noModelItems.length}件の説明文を順番に収集します。ページが自動的に移動します...`);
            await sleep(1500);
            window.location.replace(noModelItems[0].url);
        });
    }

    // ========================================================
    //  エレコム商品収集（Search API）
    // ========================================================
    async function fetchItems(tpl) {
        const allItems = {};

        // 日次運用：前回実行時刻（メーカー単位で記録）
        // brand_idがあればそれを、なければURL全体の簡易ハッシュを使う
        const _brandMatch = window.location.href.match(/brand_id=(\d+)/);
        const _urlHash    = window.location.href.split('').reduce((a, c) => (Math.imul(31, a) + c.charCodeAt(0)) | 0, 0);
        const runKey      = 'desc_last_run_' + (_brandMatch ? _brandMatch[1] : Math.abs(_urlHash).toString(36));
        const lastRunTime = parseInt(localStorage.getItem(runKey) || '0', 10);
        const isFirstRun  = lastRunTime === 0;

        let pageToken = '';

        for (let page = 0; page < MAX_PAGES; page++) {
            const bodyObj = JSON.parse(tpl.body);
            bodyObj.pageToken = pageToken;
            bodyObj.pageSize  = 120;

            const ctrl  = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 15000);
            let data;
            try {
                const res = await fetch(tpl.url, {
                    method:      tpl.method,
                    headers:     tpl.headers,
                    credentials: 'include',
                    body:        JSON.stringify(bodyObj),
                    signal:      ctrl.signal,
                });
                clearTimeout(timer);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                data = await res.json();
            } catch(e) {
                clearTimeout(timer);
                throw e;
            }

            const pageItems = (data.items || []).filter(item => {
                const id = item.id || item.itemId;
                return id && item.name && item.price != null && !(item.auction && item.auction.bidDeadline);
            });

            let newCount = 0;
            pageItems.forEach(item => {
                const id        = item.id || item.itemId;
                const createdAt = parseInt(item.created || '0', 10);
                // 2回目以降：前回実行より古い出品はスキップ
                if (!isFirstRun && createdAt <= lastRunTime) return;
                newCount++;
                allItems[id] = {
                    id,
                    name:  item.name,
                    price: String(item.price),
                    url:   `https://jp.mercari.com/item/${id}`,
                    image: (item.thumbnails && item.thumbnails[0]) || '',
                };
            });

            // このページに前回以降の新着がゼロ → 以降のページも不要
            if (!isFirstRun && pageItems.length > 0 && newCount === 0) {
                showStatus(`前回実行以降の新着なし（${page + 1}ページで収集終了）`);
                break;
            }

            const nextToken = (data.meta && data.meta.nextPageToken) || data.nextPageToken || '';
            if (!nextToken || pageItems.length === 0) break;
            pageToken = nextToken;
            await sleep(300);
        }

        // 収集完了：1件以上収集できた場合のみ今回の実行時刻を保存（次回のカットオフになる）
        if (Object.keys(allItems).length > 0) {
            localStorage.setItem(runKey, Math.floor(Date.now() / 1000));
        }

        return allItems;
    }

    // ========================================================
    //  結果パネル表示
    // ========================================================
    function showResults(matches) {
        hideStatus();

        if (matches.length === 0) {
            showStatus('照合完了 — ヒットなし', 'rgba(100,80,0,0.88)');
            setTimeout(hideStatus, 6000);
            return;
        }

        const old = document.getElementById('desc-model-panel');
        if (old) old.remove();

        const panel = document.createElement('div');
        panel.id = 'desc-model-panel';
        panel.style.cssText = `
            position:fixed; top:20px; right:20px; z-index:99998;
            background:#fff; border:2px solid #C49A00; border-radius:10px;
            padding:16px; width:420px; max-height:80vh; overflow-y:auto;
            box-shadow:0 4px 20px rgba(0,0,0,0.25); font-size:13px; font-family:sans-serif;
        `;

        const header = document.createElement('div');
        header.style.cssText = 'font-weight:bold; font-size:16px; margin-bottom:12px; color:#C49A00;';
        header.textContent = `★ 仕入れ候補（説明文型番） ${matches.length}件`;
        panel.appendChild(header);

        matches.forEach(m => {
            const row = document.createElement('div');
            row.style.cssText = 'border-top:1px solid #eee; padding:10px 0;';
            row.innerHTML = `
                <div style="font-weight:bold;color:#222;margin-bottom:3px;">${m.model}</div>
                <div style="color:#888;font-size:11px;margin-bottom:4px;">${(m.name||'').slice(0,65)}</div>
                <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                    <span style="color:#f44336;font-weight:bold;font-size:15px;">¥${Number(m.mercari_price).toLocaleString()}</span>
                    <span style="color:#999;">→ Amazon ¥${m.amazon_price?Number(m.amazon_price).toLocaleString():'?'}</span>
                    <span style="color:#4CAF50;font-weight:bold;">pmax ¥${Number(m.pmax).toLocaleString()}</span>
                </div>
                <div style="color:#C49A00;font-size:12px;margin-top:3px;">
                    差益 ¥${Number(m.diff).toLocaleString()} ／ ASIN: ${m.asin}
                </div>
                <a href="${m.mercari_url}" target="_blank" style="color:#FF6600;font-size:11px;">メルカリで見る →</a>
            `;
            panel.appendChild(row);
        });

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '閉じる';
        closeBtn.style.cssText = `
            margin-top:12px; padding:8px; width:100%;
            background:#f0f0f0; border:none; border-radius:6px; cursor:pointer; font-size:13px;
        `;
        closeBtn.onclick = () => panel.remove();
        panel.appendChild(closeBtn);
        document.body.appendChild(panel);

        showStatus(`照合完了 — ${matches.length}件ヒット！`, 'rgba(0,100,0,0.88)');
    }

})();
