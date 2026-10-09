// ==UserScript==
// @name         Amazon Offer Sellers Scraper
// @namespace    http://tampermonkey.net/
// @version      2.0
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

    // 2026-10-09：調査の結果、1オファーごとに aod-offer-heading（コンディション）→
    // aod-offer-shipsFrom（発送元）→ aod-offer-soldBy（セラー名＋プロフィールリンク）が
    // この順でDOM上に出現することが判明。出現順に走査して1オファーずつ組み立てる。
    function scrapeOffers() {
        const nodes = document.querySelectorAll('[id="aod-offer-heading"], [id="aod-offer-shipsFrom"], [id="aod-offer-soldBy"]');
        const offers = [];
        let current = null;
        nodes.forEach(el => {
            if (el.id === 'aod-offer-heading') {
                current = { condition: el.textContent.trim(), shipsFrom: '', sellerId: null, sellerName: '' };
                offers.push(current);
            } else if (!current) {
                return;
            } else if (el.id === 'aod-offer-shipsFrom') {
                current.shipsFrom = el.textContent.replace('出荷元', '').trim();
            } else if (el.id === 'aod-offer-soldBy') {
                const a = el.querySelector('a[href*="seller="]');
                if (a) {
                    const m = a.href.match(/seller=([A-Z0-9]{10,})/);
                    current.sellerId = m ? m[1] : null;
                    current.sellerName = a.textContent.trim();
                } else {
                    current.sellerName = el.textContent.replace('販売元', '').trim();
                }
            }
        });
        return offers;
    }

    function buildReport() {
        const offers = scrapeOffers();
        const fbaNew = offers.filter(o => o.condition.includes('新品') && o.shipsFrom === 'Amazon' && o.sellerId);
        const seen = new Map();
        for (const o of fbaNew) {
            if (!seen.has(o.sellerId)) seen.set(o.sellerId, o.sellerName);
        }

        const lines = [];
        lines.push(`全オファー数: ${offers.length} / 新品・FBA(出荷元Amazon)のセラー数: ${seen.size}`);
        lines.push('');
        lines.push('sellerId\tsellerName\tストアURL');
        for (const [id, name] of seen) {
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
