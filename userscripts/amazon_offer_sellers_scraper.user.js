// ==UserScript==
// @name         Amazon Offer Sellers Scraper
// @namespace    http://tampermonkey.net/
// @version      1.4
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

    // 2026-10-09：祖先を60文字しきい値で遡る方式だと「配送詳細」リンクと「セラー情報」
    // リンクが別々に拾われ、コンディション/FBA表記まで届かなかった。offer行の正確な境界を
    // 見つけるため、まず最初の2件分だけ祖先チェーン（タグ・id・class・文字数）を出力して調査する。
    function dumpAncestorChain(a) {
        const chain = [];
        let el = a;
        for (let i = 0; i < 10 && el; i++) {
            chain.push(`${el.tagName}#${el.id || ''}.${(el.className || '').toString().slice(0, 40)} len=${(el.textContent || '').length}`);
            el = el.parentElement;
        }
        return chain.join('\n  ');
    }

    function scrapeSellers() {
        const found = new Map();
        document.querySelectorAll('a[href*="seller="]').forEach(a => {
            const m = a.href.match(/seller=([A-Z0-9]{10,})/);
            if (!m) return;
            const sellerId = m[1];
            if (!found.has(sellerId)) {
                found.set(sellerId, { name: a.textContent.trim(), chain: dumpAncestorChain(a) });
            }
        });
        return found;
    }

    function buildReport(asin, sellers) {
        const lines = [];
        lines.push(`ASIN: ${asin} / 見つかったリンク数: ${sellers.size}`);
        lines.push('（最初の2件の祖先チェーンを調査）');
        lines.push('');
        let n = 0;
        for (const [id, info] of sellers) {
            if (n++ >= 2) break;
            lines.push(`=== sellerId=${id} name="${info.name}" ===`);
            lines.push('  ' + info.chain);
            lines.push('');
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
