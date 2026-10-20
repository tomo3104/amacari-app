// ==UserScript==
// @name         Mercari Item Desc Sniffer (並列テスト版)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  mercari_item_desc_sniffer.user.jsと同じAPI横取りだが、複数iframeを同時に動かすテストのため結果を商品ID別のキー(desc_api_capture_<itemId>)に書き込む。安定版とは別ファイルで共存させ、並列化の検証専用。
// @match        https://jp.mercari.com/item/*
// @run-at       document-start
// @grant        unsafeWindow
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_item_desc_sniffer_parallel_experiment.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_item_desc_sniffer_parallel_experiment.user.js
// ==/UserScript==
(function () {
    'use strict';
    if (window === window.top) return; // 通常閲覧（トップレベル）では何もしない。iframeの中でのみ動作する

    const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    function handle(url, text) {
        if (!url.includes('/items/get?')) return;
        try {
            const json = JSON.parse(text);
            const data = json && json.data;
            if (!data || !data.id) return;
            localStorage.setItem('desc_api_capture_' + data.id, JSON.stringify({
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
