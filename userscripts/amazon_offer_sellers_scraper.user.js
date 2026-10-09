// ==UserScript==
// @name         Amazon Offer Sellers Scraper
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Amazonの「他の出品者から購入」ページ(/gp/offer-listing/ASIN)から、そのASINを現在販売している他セラーの一覧を抜き出す（競合発見ループの輪を広げる用、2026-10-09新設）。
// @match        https://www.amazon.co.jp/gp/offer-listing/*
// @match        https://www.amazon.co.jp/*/gp/offer-listing/*
// @match        https://www.amazon.co.jp/dp/*
// @match        https://www.amazon.co.jp/*/dp/*
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
    'use strict';

    function getAsinFromUrl() {
        const m = location.pathname.match(/\/(?:gp\/offer-listing|dp)\/([A-Z0-9]{10})/);
        return m ? m[1] : null;
    }

    function scrapeSellers() {
        // 2026-10-09：ページのデザイン変更に強くするため、具体的なクラス名ではなく
        // 「href に seller=ID を含むリンク」というパターンでセラーへの導線を広く探す。
        const found = new Map(); // sellerId -> name
        document.querySelectorAll('a[href*="seller="]').forEach(a => {
            const m = a.href.match(/seller=([A-Z0-9]{10,})/);
            if (!m) return;
            const sellerId = m[1];
            const text = a.textContent.trim();
            if (!found.has(sellerId) || (!found.get(sellerId) && text)) {
                found.set(sellerId, text || found.get(sellerId) || '');
            }
        });
        return found;
    }

    function buildReport(asin, sellers) {
        const lines = [];
        lines.push(`ASIN: ${asin}`);
        lines.push(`見つかったセラー数: ${sellers.size}`);
        lines.push('');
        lines.push('sellerId\tsellerName\tストアURL');
        for (const [id, name] of sellers) {
            lines.push(`${id}\t${name}\thttps://www.amazon.co.jp/s?me=${id}`);
        }
        return lines.join('\n');
    }

    function mountUI() {
        const btn = document.createElement('button');
        btn.textContent = '他セラー一覧を抽出';
        btn.style.cssText = 'position:fixed;top:20px;right:20px;z-index:2147483647;padding:12px 20px;background:#FF6F00;color:#fff;border:none;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,0.6);';
        document.body.appendChild(btn);

        const statusEl = document.createElement('div');
        statusEl.style.cssText = 'position:fixed;top:70px;right:20px;z-index:2147483647;background:rgba(0,0,0,0.9);color:#fff;padding:6px 14px;border-radius:6px;font-size:13px;display:none;max-width:400px;white-space:pre-wrap;';
        document.body.appendChild(statusEl);

        function updateStatus(msg) {
            statusEl.style.display = 'block';
            statusEl.textContent = msg;
        }

        btn.onclick = () => {
            const asin = getAsinFromUrl();
            const sellers = scrapeSellers();
            if (sellers.size === 0) {
                updateStatus('セラーへのリンクが見つかりませんでした（ページ構造が想定と違う可能性）');
                return;
            }
            const report = buildReport(asin, sellers);
            GM_setClipboard(report);
            updateStatus('完了！' + sellers.size + '件のセラーをコピーしました');
            console.log(report);
        };
    }

    if (document.body) {
        mountUI();
    } else {
        document.addEventListener('DOMContentLoaded', mountUI);
    }
})();
