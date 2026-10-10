// ==UserScript==
// @name         Amazon Seller ASIN Scraper
// @namespace    http://tampermonkey.net/
// @version      2.2
// @description  Amazonセラーストアページ(/s?me=...)の出品ASIN一覧を全ページ抜き出し、asin-toolsサーバー(8766)の/check-asinsへ直接送信してlist.json未登録分を自動処理する（seller-chase発想の転換：競合セラーの出品ASINを仕入れ候補の種にする、2026-10-09新設）。新規追加分の型番・価格・pmaxを画面に一覧表示する（2026-10-10追加）
// @match        https://www.amazon.co.jp/s?me=*
// @grant        GM_setClipboard
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/amazon_seller_scraper.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/amazon_seller_scraper.user.js
// ==/UserScript==

(function () {
    'use strict';

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    function scrapeDoc(doc) {
        const items = [];
        doc.querySelectorAll('div[data-asin]').forEach(el => {
            const asin = el.getAttribute('data-asin');
            if (!asin) return;
            const titleEl = el.querySelector('h2 span, h2');
            const priceEl = el.querySelector('.a-price .a-offscreen');
            items.push({
                asin,
                title: titleEl ? titleEl.textContent.trim() : '',
                price: priceEl ? priceEl.textContent.trim() : '',
            });
        });
        return items;
    }

    async function scrapeAllPages() {
        const seen = new Map();
        const url = new URL(location.href);
        let page = 1;
        let emptyStreak = 0;
        while (page <= 50 && emptyStreak < 2) {
            url.searchParams.set('page', String(page));
            const res = await fetch(url.toString(), { credentials: 'include' });
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');
            const items = scrapeDoc(doc);
            if (items.length === 0) {
                emptyStreak++;
            } else {
                emptyStreak = 0;
                items.forEach(it => seen.set(it.asin, it));
            }
            updateStatus(page + 'ページ目まで取得 (' + seen.size + '件)');
            page++;
            await sleep(1500);
        }
        return [...seen.values()];
    }

    const btn = document.createElement('button');
    btn.textContent = 'ASIN一覧を抜き出す';
    btn.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;padding:12px 20px;background:#FF9900;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,0.3);';
    document.body.appendChild(btn);

    const statusEl = document.createElement('div');
    statusEl.style.cssText = 'position:fixed;bottom:70px;right:20px;z-index:99999;background:rgba(0,0,0,0.78);color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;display:none;max-width:280px;';
    document.body.appendChild(statusEl);

    const resultsEl = document.createElement('div');
    resultsEl.style.cssText = 'position:fixed;bottom:115px;right:20px;z-index:99999;background:rgba(0,0,0,0.9);color:#fff;padding:10px 12px;border-radius:6px;font-size:12px;display:none;max-width:340px;max-height:320px;overflow-y:auto;line-height:1.5;';
    document.body.appendChild(resultsEl);

    function updateStatus(msg) {
        statusEl.style.display = 'block';
        statusEl.textContent = msg;
    }

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function showResults(newItems) {
        if (!newItems || newItems.length === 0) {
            resultsEl.style.display = 'none';
            return;
        }
        const sorted = [...newItems].sort((a, b) => (b.pmax || 0) - (a.pmax || 0));
        resultsEl.innerHTML = '<div style="font-weight:600;margin-bottom:6px;">新規登録 ' + sorted.length + '件</div>' +
            sorted.map(it => {
                const model = escapeHtml(it.model || '(型番不明)');
                const title = escapeHtml((it.title || '').slice(0, 28));
                const pmax = it.pmax != null ? it.pmax + '円' : '-';
                const price = it.price != null ? it.price + '円' : '-';
                const flag = it.brand_restricted ? ' 🚫規制' : '';
                return '<div style="border-top:1px solid rgba(255,255,255,0.15);padding:4px 0;">' +
                    '<b>' + model + '</b> ' + flag + '<br>' + title + '<br>価格' + price + ' / pmax' + pmax +
                    '</div>';
            }).join('');
        resultsEl.style.display = 'block';
    }

    function getSellerIdFromUrl() {
        return new URL(location.href).searchParams.get('me');
    }

    function sendToCheckAsins(asins, source) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method: 'POST', url: 'http://localhost:8766/check-asins',
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify({ asins, source }),
                timeout: 300000, // ASIN数次第で時間がかかるため長めに取る
                onload: res => { try { resolve(JSON.parse(res.responseText)); } catch (e) { resolve(null); } },
                onerror: () => resolve(null),
                ontimeout: () => resolve(null),
            });
        });
    }

    btn.onclick = async () => {
        btn.disabled = true;
        updateStatus('取得中...');
        const items = await scrapeAllPages();
        const asinList = items.map(it => it.asin);
        GM_setClipboard(asinList.join('\n'));
        updateStatus(items.length + '件のASINを取得。list.jsonと照合して新規分を処理中...（時間がかかります）');
        const sellerId = getSellerIdFromUrl();
        const source = 'Amazon出品者追跡:' + (sellerId || '不明');
        const result = await sendToCheckAsins(asinList, source);
        if (result && result.ok) {
            updateStatus(
                '完了！ 取得' + items.length + '件 / 新規' + result.new + '件を処理 / 既知' + result.already_known + '件はスキップ' +
                '\n（ASIN一覧はクリップボードにもコピー済み）'
            );
            showResults(result.results);
        } else {
            updateStatus('完了: ' + items.length + '件のASINをコピーしました。ただしサーバーへの送信に失敗しました（asin-toolsのserver.pyが起動しているか確認してください）');
            showResults(null);
        }
        btn.disabled = false;
    };
})();
