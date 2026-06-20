// ==UserScript==
// @name         フリマウォッチ タイムライン 利益率ハイライター
// @namespace    http://tampermonkey.net/
// @version      1.9
// @description  利益率に応じて行を色分けハイライト＆商品ページ・公式商品ページを別タブで開く＆モノトレーサーボタン追加（iOS新タブ不発対策）
// @match        https://www.furimawatch.net/*
// @grant        none
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/furimawatch_highlight.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/furimawatch_highlight.user.js
// ==/UserScript==

(function () {
    'use strict';

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

            const profitRate = (limitPrice - frimPrice) / limitPrice;

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

    window.addEventListener('load', () => {
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
    });

    window.addEventListener('hashchange', () => {
        setTimeout(run, 1500);
    });
})();
