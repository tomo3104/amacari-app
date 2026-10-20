// ==UserScript==
// @name         Mercari Item Desc Sniffer (画像ブロック実験版)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  mercari_item_desc_sniffer.user.jsのAPI横取りに加え、商品画像(<img>のsrc)の読み込みを1x1透明GIFに差し替えて止め、ページ起動が速くなるか検証する実験版。広告ドメイン遮断版(adblock_experiment)は効果が無かったため、今回は画像のみを対象に切り分けて検証する。安定版とは別ファイルで共存させ、Tampermonkey側で片方だけ有効化して切り替える想定。
// @match        https://jp.mercari.com/item/*
// @run-at       document-start
// @grant        unsafeWindow
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_item_desc_sniffer_noimg_experiment.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_item_desc_sniffer_noimg_experiment.user.js
// ==/UserScript==
(function () {
    'use strict';
    if (window === window.top) return; // 通常閲覧（トップレベル）では何もしない。iframeの中でのみ動作する

    const RESULT_KEY = 'desc_api_capture';
    const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

    // 画像読み込みを遮断（説明文取得には不要なため）。srcのsetterを差し替え、
    // 画像っぽいURLだけ1x1透明GIFに置き換える。onload/onerrorの発火自体は妨げない。
    try {
        const proto = uw.HTMLImageElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'src');
        if (desc && desc.set) {
            Object.defineProperty(proto, 'src', {
                configurable: true,
                enumerable: desc.enumerable,
                get: desc.get,
                set: function (value) {
                    if (typeof value === 'string' && /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(value)) {
                        return desc.set.call(this, BLANK_GIF);
                    }
                    return desc.set.call(this, value);
                },
            });
        }
    } catch (e) {}

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
