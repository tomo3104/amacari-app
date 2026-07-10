// ==UserScript==
// @name         フリマウォッチ タイムライン 利益率ハイライター
// @namespace    http://tampermonkey.net/
// @version      2.5
// @description  実利益率（Amazon価格基準）に応じて行を色分けハイライト＆商品ページ・公式商品ページを別タブで開く＆モノトレーサーボタン追加＆実利益率15%以上をASIN付きでローカルサーバーに通知＆1時間ごとに自動リロード
// @match        https://www.furimawatch.net/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/furimawatch_highlight.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/furimawatch_highlight.user.js
// ==/UserScript==

(function () {
    'use strict';

    const MIN_PROFIT_RATE = 0.15;
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

    // 登録時のmemo（例："Amazon:10000円 ランク:12345 FBA:2000円 pmax:6500円"）からAmazon価格を取得
    function getAmazonPriceFromRow(row) {
        try {
            const scope = angular.element(row).scope();
            const tr = scope && scope.timelineRow;
            const source = (tr && tr.query && (tr.query.memo || tr.query.name)) || '';
            const m = source.match(/Amazon:(\d+)円/);
            return m ? parseInt(m[1], 10) : null;
        } catch (e) {
            return null;
        }
    }

    // pmax = Amazon価格×0.85 - FBA手数料 で計算されているため、
    // pmax地点での実利益は常にAmazon価格×0.15（FBA手数料は計算上相殺される）
    // → 実利益率 = (差額 + Amazon価格×0.15) ÷ Amazon価格
    // memoからAmazon価格が取れない場合（登録形式が古い等）は旧式（差額÷上限価格）にフォールバック
    function calcRealMargin(diff, limitPrice, amazonPrice) {
        if (amazonPrice) {
            return (diff + amazonPrice * 0.15) / amazonPrice;
        }
        return diff / limitPrice;
    }

    function getNotifiedCache() {
        try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { return {}; }
    }
    function setNotifiedCache(cache) {
        try { localStorage.setItem(LS_KEY, JSON.stringify(cache)); } catch (e) { /* noop */ }
    }

    // ========== 利益率15%以上をローカルサーバーへ通知 ==========
    function sendHit(row, profitRate, frimPrice, limitPrice) {
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

            const payload = {
                itemid:     itemid,
                name:       tr.item.name,
                price:      frimPrice,
                limitPrice: limitPrice,
                profitRate: Math.round(profitRate * 1000) / 10,
                itemUrl:    tr.item.itemUrl,
                imageUrl:   (tr.item.imageUrls && tr.item.imageUrls[0]) || '',
                service:    tr.item.service || '',
                asin:       asinMatch ? asinMatch[0] : '',
                account:    getAccount() || 'unknown',
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

    function getProfitStyle(rate) {
        if (rate >= 0.51) return { bg: 'linear-gradient(90deg, #e3f2fd, #bbdefb)', border: '#1565c0', badge: '#1565c0' }; // 青：51%以上
        if (rate >= 0.21) return { bg: 'linear-gradient(90deg, #e8f5e9, #c8e6c9)', border: '#2e7d32', badge: '#2e7d32' }; // 緑：21〜50%
        if (rate >= 0.06) return { bg: 'linear-gradient(90deg, #fffde7, #fff9c4)', border: '#f9a825', badge: '#f9a825' }; // 黄：6〜20%
        return { bg: 'linear-gradient(90deg, #ffebee, #ffcdd2)', border: '#c62828', badge: '#c62828' };                   // 赤：0〜5%
    }

    // ========== 利益率ハイライト ==========
    function highlight() {
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

            const diff = limitPrice - frimPrice;
            const amazonPrice = getAmazonPriceFromRow(row);
            const profitRate = calcRealMargin(diff, limitPrice, amazonPrice);

            if (profitRate >= MIN_PROFIT_RATE) {
                sendHit(row, profitRate, frimPrice, limitPrice);
            }

            const existingBadge = row.querySelector('.profit-badge');
            if (existingBadge) existingBadge.remove();
            row.style.background = '';
            row.style.borderLeft = '';

            const s = getProfitStyle(profitRate);
            row.style.background = s.bg;
            row.style.borderLeft = '4px solid ' + s.border;

            const badge = document.createElement('span');
            badge.className = 'profit-badge';
            badge.textContent = `▲ ${(profitRate * 100).toFixed(1)}% お得`;
            badge.style.cssText = [
                'display: inline-block',
                'margin-left: 8px',
                'padding: 2px 8px',
                'background: ' + s.badge,
                'color: white',
                'border-radius: 12px',
                'font-size: 12px',
                'font-weight: bold',
                'vertical-align: middle'
            ].join(';');
            alertCell.appendChild(badge);
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
        highlight();
        fixButtons();
        addMonoTracerButtons();
    }

    // フリマウォッチは手動更新（メニューの更新ボタン／ブラウザの再読込）でしか
    // タイムラインが更新されないため、無人運用時は定期的にページ自体をリロードする
    const AUTO_RELOAD_INTERVAL_MS = 60 * 60 * 1000; // 1時間

    window.addEventListener('load', () => {
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
    });

    window.addEventListener('hashchange', () => {
        setTimeout(run, 1500);
    });
})();
