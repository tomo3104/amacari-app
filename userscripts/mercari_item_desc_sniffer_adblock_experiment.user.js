// ==UserScript==
// @name         Mercari Item Desc Sniffer (AdBlock実験版)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  mercari_item_desc_sniffer.user.jsのAPI横取りに加え、メルカリ以外の第三者ドメイン(広告・分析・計測タグ等)への通信を遮断し、ページ起動そのものを速くできるか検証する実験版。安定版(mercari_item_desc_sniffer.user.js)とは別ファイル・別名で共存させ、Tampermonkey側で片方だけを有効化して切り替える想定。不正検知系(forter.com)は誤検知リスクがあるため意図的にブロック対象から除外している。
// @match        https://jp.mercari.com/item/*
// @run-at       document-start
// @grant        unsafeWindow
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_item_desc_sniffer_adblock_experiment.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_item_desc_sniffer_adblock_experiment.user.js
// ==/UserScript==
(function () {
    'use strict';
    if (window === window.top) return; // 通常閲覧（トップレベル）では何もしない。iframeの中でのみ動作する

    const RESULT_KEY = 'desc_api_capture';
    const uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    // メルカリ本体・関連の第一party的ドメインのみ許可。それ以外(広告・分析・計測タグ等)は遮断する。
    // forter.com(不正検知)は誤検知でアカウントに影響するリスクがあるため意図的に許可リストに含めない＝
    // 遮断対象にせず素通りさせる（ブロック対象から除外）。
    const ALLOW_HOST_SUFFIXES = ['mercari.com', 'mercari.jp', 'mercdn.net', 'merpay.com', 'forter.com'];

    function isAllowed(url) {
        try {
            const h = new URL(url, location.href).hostname;
            return ALLOW_HOST_SUFFIXES.some(suf => h === suf || h.endsWith('.' + suf));
        } catch (e) {
            return true; // 判定できない場合は安全側（遮断しない）に倒す
        }
    }

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
        if (!isAllowed(url)) {
            return Promise.reject(new DOMException('blocked by adblock experiment', 'AbortError'));
        }
        const res = await origFetch.apply(this, args);
        try { res.clone().text().then(text => handle(url, text)).catch(() => {}); } catch (e) {}
        return res;
    };

    const OrigXHR = uw.XMLHttpRequest;
    function PatchedXHR() {
        const xhr = new OrigXHR();
        let _url = '';
        let _blocked = false;
        const origOpen = xhr.open;
        xhr.open = function (method, url, ...rest) {
            _url = url;
            _blocked = !isAllowed(url);
            if (_blocked) return; // openを本当には呼ばない（通信を発生させない）
            return origOpen.call(xhr, method, url, ...rest);
        };
        const origSend = xhr.send;
        xhr.send = function (...rest) {
            if (_blocked) {
                // 呼び出し元のonerror/catchが拾えるよう、非同期でエラーを発火させる
                setTimeout(() => {
                    try { xhr.dispatchEvent(new Event('error')); } catch (e) {}
                    try { xhr.dispatchEvent(new Event('loadend')); } catch (e) {}
                }, 0);
                return;
            }
            return origSend.apply(xhr, rest);
        };
        xhr.addEventListener('loadend', function () {
            if (_blocked) return;
            try { handle(_url, xhr.responseText); } catch (e) {}
        });
        return xhr;
    }
    uw.XMLHttpRequest = PatchedXHR;
})();
