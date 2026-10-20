// ==UserScript==
// @name         Mercari Item Desc Sniffer
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  mercari_desc_model_finder.user.jsが説明文取得のために作る非表示iframeの中でのみ動作し、商品ページ内部のitems/get API通信を横取りして説明文をlocalStorage(desc_api_capture)へ渡す。トップレベル（通常のメルカリ閲覧）では何もしない。DOM描画完了を待つ必要がなくなるため発掘リサーチを高速化する目的（2026-10-20新設）。
// @match        https://jp.mercari.com/item/*
// @run-at       document-start
// @grant        unsafeWindow
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_item_desc_sniffer.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_item_desc_sniffer.user.js
// ==/UserScript==
(function () {
    'use strict';
    if (window === window.top) return; // 通常閲覧（トップレベル）では何もしない。iframeの中でのみ動作する

    const RESULT_KEY = 'desc_api_capture';
    const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    function handle(url, text) {
        if (!url.includes('/items/get?')) return;
        try {
            const json = JSON.parse(text);
            const data = json && json.data;
            if (!data || !data.id) return;
            localStorage.setItem(RESULT_KEY, JSON.stringify({
                itemId: data.id,
                desc: data.description || '',
                ts: Date.now(),
            }));
        } catch (e) {}
    }

    const origFetch = uw.fetch;
    uw.fetch = async function (...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        const res = await origFetch.apply(this, args);
        try { res.clone().text().then(text => handle(url, text)).catch(() => {}); } catch (e) {}
        return res;
    };

    const OrigXHR = uw.XMLHttpRequest;
    function PatchedXHR() {
        const xhr = new OrigXHR();
        let _url = '';
        const origOpen = xhr.open;
        xhr.open = function (method, url, ...rest) {
            _url = url;
            return origOpen.call(xhr, method, url, ...rest);
        };
        xhr.addEventListener('loadend', function () {
            try { handle(_url, xhr.responseText); } catch (e) {}
        });
        return xhr;
    }
    uw.XMLHttpRequest = PatchedXHR;
})();
