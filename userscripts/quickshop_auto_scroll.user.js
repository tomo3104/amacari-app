// ==UserScript==
// @name         QuickShop自動スクロール
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Amazon商品ページでQuickShop拡張機能のウィジェットが表示されたら自動でそこまでスクロールする（Amacariのカードから開いた際、手でスクロールする手間を無くすため・2026-09-20新設）
// @match        https://www.amazon.co.jp/*
// @grant        none
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/quickshop_auto_scroll.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/quickshop_auto_scroll.user.js
// ==/UserScript==

(function () {
    'use strict';

    function findQuickShop() {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            if (walker.currentNode.textContent.toUpperCase().includes('QUICKSHOP')) {
                return walker.currentNode.parentElement;
            }
        }
        return null;
    }

    let done = false;
    const observer = new MutationObserver(() => {
        if (done) return;
        const el = findQuickShop();
        if (el) {
            done = true;
            observer.disconnect();
            setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 300);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // 15秒経っても見つからなければ諦めて監視を止める（無駄な負荷を防ぐ）
    setTimeout(() => observer.disconnect(), 15000);
})();
