// ==UserScript==
// @name         フリマウォッチ タイムライン 検知ロガー
// @namespace    http://tampermonkey.net/
// @version      3.0
// @description  商品ページ・公式商品ページを別タブで開く＆モノトレーサーボタン追加＆マッチした行をASIN・型番付きでローカルサーバーに無条件でログ記録＆1時間ごとに自動リロード
// @match        https://www.furimawatch.net/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/furimawatch_highlight.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/furimawatch_highlight.user.js
// ==/UserScript==

// 2026-11-04：v2.7まではここで実利益率を再計算し15%以上・差益500円以上だけを
// ログ・ハイライトする「追加フィルター」として動いていた。その前提は「登録pmaxが
// 純粋な損益分岐点で、利益率はこのスクリプト側だけでチェックする」ことだった。
// 今はフリマウォッチへの登録pmax自体にランク帯別必要利益率を先引きしてある
// （export_frima.py・サルベージ登録CSV共通）ため、フリマウォッチ本体のpmin〜pmax
// マッチに引っかかった時点で既に必要利益率はクリア済みになっている。この状態で
// 旧式のまま「limitPrice(=登録pmax)との差額」で利益率を再計算すると、先引き済みの
// 分だけ実際より低く出てしまい、本来ログすべき行が漏れる（二重要求になる）。
// そのため実利益率の計算・フィルター自体を廃止し、マッチした行を無条件でログする
// 「ロガー」専用に簡略化した。
(function () {
    'use strict';

    const SERVER_URL = 'http://localhost:8768/furima-hit';
    const LS_KEY = 'furimaNotifiedCache';
    const LS_ACCOUNT_KEY = 'frimaAccount';

    function getAccount() {
        return localStorage.getItem(LS_ACCOUNT_KEY) || null;
    }

    function promptAccount() {
        let account = '';
        while (!['A', 'B', 'C'].includes(account)) {
            const input = prompt('フリマウォッチアカウントを設定してください (A, B or C):');
            if (input === null) { account = 'unknown'; break; }
            account = input.trim().toUpperCase();
        }
        localStorage.setItem(LS_ACCOUNT_KEY, account);
        return account;
    }

    function addAccountButton() {
        const btn = document.createElement('button');
        const update = () => { btn.textContent = 'アカウント: ' + (getAccount() || '未設定'); };
        update();
        btn.style.cssText = 'position:fixed;bottom:50px;right:10px;z-index:9999;padding:6px 12px;background:#1976d2;color:white;border:none;border-radius:4px;cursor:pointer;font-size:12px;';
        btn.onclick = () => { localStorage.removeItem(LS_ACCOUNT_KEY); promptAccount(); update(); };
        document.body.appendChild(btn);
    }

    function getNotifiedCache() {
        try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
    }
    function setNotifiedCache(cache) {
        try { localStorage.setItem(LS_KEY, JSON.stringify(cache)); } catch (e) { /* noop */ }
    }

    // ========== マッチした行を無条件でローカルサーバーへログ記録 ==========
    function sendHit(row, frimPrice, limitPrice) {
        try {
            const scope = angular.element(row).scope();
            const tr = scope && scope.timelineRow;
            if (!tr || !tr.item) return;

            const itemid = tr.watchid || tr.item.iid;
            if (!itemid) return;

            const cache = getNotifiedCache();
            if (cache[itemid] === frimPrice) return; // このブラウザでは価格変化なし→送信スキップ（サーバー側でも最終判定する）

            const querySource = (tr.query && (tr.query.name || tr.query.memo)) || '';
            const asinMatch = querySource.match(/\bB0[A-Z0-9]{8}\b/) || querySource.match(/\b[A-Z0-9]{10}\b/);
            // 2026-09-16追加：登録時のアラート名は「型番 ASIN pmax」の空白区切り形式
            // （export_frima.pyのmake_premium_row参照）のため、先頭トークンが型番になる。
            const model = (querySource.trim().split(/\s+/)[0]) || '';

            const payload = {
                itemid:     itemid,
                name:       tr.item.name,
                price:      frimPrice,
                limitPrice: limitPrice,
                // 2026-11-04：利益率の再計算自体を廃止した（登録pmaxに必要利益率が
                // 先引きされているため、このスクリプト側で算出する数字は参考にならない）。
                // furima_hitsシートのスキーマ互換のため0を送るだけにする。
                profitRate: 0,
                itemUrl:    tr.item.itemUrl,
                imageUrl:   (tr.item.imageUrls && tr.item.imageUrls[0]) || '',
                service:    tr.item.service || '',
                asin:       asinMatch ? asinMatch[0] : '',
                account:    getAccount() || 'unknown',
                model:      model,
            };

            fetch(SERVER_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }).then(() => {
                cache[itemid] = frimPrice;
                setNotifiedCache(cache);
            }).catch(() => { /* ローカルサーバー未起動時は無視 */ });
        } catch (err) {
            console.error('フリマ通知送信エラー:', err);
        }
    }

    // ========== タイムラインのマッチ行を走査してログ送信 ==========
    function scanAndLog() {
        const rows = document.querySelectorAll('table tr');

        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length < 4) return;

            const productCell = cells[2];
            const alertCell = cells[3];
            if (!productCell || !alertCell) return;

            const productText = productCell.innerText;
            const priceMatch = productText.match(/^([\d,]+)\s*円/);
            if (!priceMatch) return;
            const frimPrice = parseInt(priceMatch[1].replace(/,/g, ''), 10);

            const alertText = alertCell.innerText.trim();
            const cleaned = alertText.replace(/編集|削除|商品ページ|公式商品ページ/g, '').trim();
            const limitMatch = cleaned.match(/(\d+)\s*$/);
            if (!limitMatch) return;
            const limitPrice = parseInt(limitMatch[1], 10);

            if (limitPrice <= 0) return;

            sendHit(row, frimPrice, limitPrice);
        });
    }

    // ========== 商品ページ・公式商品ページを別タブで開く ==========
    function fixButtons() {
        document.querySelectorAll('button').forEach(btn => {
            const text = btn.innerText.trim();
            if (!['商品ページ', '公式商品ページ'].includes(text)) return;
            if (btn.dataset.newTabFixed) return;

            btn.dataset.newTabFixed = 'true';
            btn.addEventListener('click', function (e) {
                e.stopImmediatePropagation();
                e.preventDefault();

                try {
                    const scope = angular.element(btn).scope();
                    const url = scope.timelineRow.item.itemUrl;
                    if (url) {
                        window.open(url, '_blank', 'noopener,noreferrer');
                    } else {
                        alert('URLが取得できませんでした');
                    }
                } catch (err) {
                    console.error('別タブ展開エラー:', err);
                }
            }, true);
        });
    }

    // ========== モノトレーサーボタン追加 ==========
    function addMonoTracerButtons() {
        document.querySelectorAll('button').forEach(btn => {
            const text = btn.innerText.trim();
            if (text !== '商品ページ') return;
            if (btn.dataset.monoTracerAdded) return;

            try {
                const scope = angular.element(btn).scope();
                const query = scope.timelineRow.query;
                const source = (query && (query.name || query.memo)) || '';
                const asinMatch = source.match(/\bB0[A-Z0-9]{8}\b/) || source.match(/\b[A-Z0-9]{10}\b/);
                if (!asinMatch) {
                    btn.dataset.monoTracerAdded = 'true'; // ASINなしは以後スキップ
                    return;
                }
                const asin = asinMatch[0];

                btn.dataset.monoTracerAdded = 'true';

                const monoBtn = document.createElement('a');
                monoBtn.innerText = 'モノトレ';
                monoBtn.href = 'https://mono-tracer.com/#/product/' + asin;
                monoBtn.target = '_blank';
                monoBtn.rel = 'noreferrer';
                monoBtn.style.cssText = btn.style.cssText || '';
                monoBtn.style.marginLeft = '4px';
                monoBtn.style.display = 'inline-block';
                monoBtn.style.textDecoration = 'none';

                btn.insertAdjacentElement('afterend', monoBtn);
            } catch (err) {
                console.error('モノトレボタン追加エラー:', err);
            }
        });
    }

    function run() {
        scanAndLog();
        fixButtons();
        addMonoTracerButtons();
    }

    // フリマウォッチは手動更新（メニューの更新ボタン／ブラウザの再読込）でしか
    // タイムラインが更新されないため、無人運用時は定期的にページ自体をリロードする
    const AUTO_RELOAD_INTERVAL_MS = 60 * 60 * 1000; // 1時間

    function init() {
        if (!getAccount()) promptAccount();
        addAccountButton();
        setTimeout(run, 1500);

        document.addEventListener('click', (e) => {
            if (e.target && e.target.tagName === 'BUTTON') {
                setTimeout(run, 1500);
            }
        });

        const observer = new MutationObserver(() => {
            setTimeout(run, 500);
        });
        observer.observe(document.body, { childList: true, subtree: true });

        setTimeout(() => location.reload(), AUTO_RELOAD_INTERVAL_MS);
    }

    // Firefoxではloadイベントがスクリプト注入より先に発火する場合があるため
    // readyStateで判定して即時実行にフォールバックする
    if (document.readyState === 'complete') {
        init();
    } else {
        window.addEventListener('load', init);
    }

    window.addEventListener('hashchange', () => {
        setTimeout(run, 1500);
    });
})();
