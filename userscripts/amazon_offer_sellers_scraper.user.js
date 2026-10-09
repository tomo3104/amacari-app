// ==UserScript==
// @name         Amazon Offer Sellers Scraper
// @namespace    http://tampermonkey.net/
// @version      1.5
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

    // 2026-10-09：個別リンクから祖先を遡る方式では、オファー行によってセラー名がリンクに
    // なっていない（詳細を見るリンクだけがseller=を持つ）ケースがあり不確実だった。
    // id="aod-offer..."で始まる要素（オファー行自体のコンテナと見られる）を直接調査する。
    function buildReport() {
        const lines = [];
        const offerEls = document.querySelectorAll('[id^="aod-offer"]');
        lines.push(`id^="aod-offer" に一致する要素数: ${offerEls.length}`);
        lines.push('');
        [...offerEls].forEach((el, i) => {
            lines.push(`=== [${i}] id="${el.id}" tag=${el.tagName} 文字数=${el.textContent.length} ===`);
            lines.push(el.textContent.replace(/\s+/g, ' ').trim().slice(0, 300));
            lines.push('');
        });
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
            const report = buildReport();
            GM_setClipboard(report);
            updateStatus('調査結果をコピーしました（' + report.length + '文字）');
            console.log(report);
        };
    }

    if (document.body) {
        mountUI();
    } else {
        document.addEventListener('DOMContentLoaded', mountUI);
    }
})();
