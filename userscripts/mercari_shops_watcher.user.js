// ==UserScript==
// @name         コジマShopsウォッチャー
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  コジマメルカリ店の全商品を監視・list.jsonと照合してDiscord通知
// @match        https://jp.mercari.com/shops/profile/WBGoQB8mMBB5VTEpM6PKZK
// @grant        GM_xmlhttpRequest
// @connect      localhost
// @noframes
// ==/UserScript==

(async () => {
    'use strict';

    const SERVER_URL    = 'http://localhost:8766/check-shops';
    const INTERVAL_MS   = 30 * 60 * 1000;  // 30分ごとに繰り返し
    const IFRAME_TIMEOUT = 8000;            // iframeタイムアウト（ms）
    const CONCURRENCY   = 3;               // 並列iframe数

    // タイヤ・車・バイク系カテゴリを除外
    const EXCLUDE_CATEGORIES = ['タイヤ', 'ホイール', 'バイク', 'オートバイ', '自動車'];

    // ──────────────── UI ────────────────
    let _ui = null;
    function showStatus(msg, bg = 'rgba(0,0,0,0.85)') {
        if (!_ui) {
            _ui = document.createElement('div');
            Object.assign(_ui.style, {
                position: 'fixed', bottom: '20px', left: '20px',
                background: bg, color: '#fff', padding: '10px 16px',
                borderRadius: '10px', fontSize: '13px', zIndex: '2147483647',
                maxWidth: '320px', whiteSpace: 'pre-wrap', lineHeight: '1.5',
                boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
            });
            document.body.appendChild(_ui);
        }
        _ui.style.background = bg;
        _ui.textContent = msg;
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ──────────────── 全件URL収集（自動スクロール） ────────────────
    async function collectProductUrls() {
        showStatus('スクロール中...', 'rgba(0,80,160,0.9)');
        window.scrollTo(0, 0);
        await sleep(1000);

        let prev = -1;
        while (true) {
            window.scrollTo(0, document.body.scrollHeight);
            await sleep(1800);
            const current = document.querySelectorAll('a[href*="/shops/product/"]').length;
            if (current === prev) break;
            prev = current;
            showStatus(`スクロール中... ${current}件`, 'rgba(0,80,160,0.9)');
        }

        const links = new Set();
        document.querySelectorAll('a[href*="/shops/product/"]').forEach(a => {
            links.add(a.href.split('?')[0]);
        });
        return [...links];
    }

    // ──────────────── 1件の商品ページからJSON-LDを取得 ────────────────
    function fetchProductData(url) {
        return new Promise(resolve => {
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
            document.body.appendChild(iframe);

            let done = false;
            const timer = setTimeout(() => {
                if (!done) { done = true; iframe.remove(); resolve(null); }
            }, IFRAME_TIMEOUT);

            iframe.onload = () => {
                if (done) return;
                try {
                    const scripts = iframe.contentDocument.querySelectorAll('script[type="application/ld+json"]');
                    let product = null, breadcrumb = null;
                    for (const s of scripts) {
                        try {
                            const obj = JSON.parse(s.textContent);
                            if (obj['@type'] === 'Product') product = obj;
                            if (obj['@type'] === 'BreadcrumbList') breadcrumb = obj;
                        } catch (_) {}
                    }
                    if (!product) { done = true; clearTimeout(timer); iframe.remove(); resolve(null); return; }

                    // 在庫チェック
                    const avail = (product.offers?.availability || '');
                    if (!avail.includes('InStock') && !avail.includes('OnlineOnly')) {
                        done = true; clearTimeout(timer); iframe.remove(); resolve(null); return;
                    }

                    // JANコード：gtin13優先、なければdescriptionから正規表現
                    let jan = product.gtin13 || product.gtin || null;
                    if (!jan) {
                        const desc = product.description || '';
                        const m = desc.match(/JANコード[：:]\s*(\d{13})/);
                        if (m) jan = m[1];
                    }

                    // カテゴリ：BreadcrumbListの3番目（index 2）
                    let category = '';
                    if (breadcrumb?.itemListElement?.length >= 3) {
                        category = breadcrumb.itemListElement[2].name || '';
                    } else if (breadcrumb?.itemListElement?.length >= 2) {
                        category = breadcrumb.itemListElement[1].name || '';
                    }

                    const price = parseInt(product.offers?.price || '0', 10);
                    const title = product.name || '';
                    const image = product.image?.[0] || product.image || '';

                    done = true; clearTimeout(timer); iframe.remove();
                    resolve({ jan, category, price, title, url, image });
                } catch (_) {
                    done = true; clearTimeout(timer); iframe.remove(); resolve(null);
                }
            };

            iframe.src = url;
        });
    }

    // ──────────────── 並列でiframeを処理 ────────────────
    async function processUrls(urls) {
        const results = [];
        let done = 0, skipped = 0;

        async function worker(chunk) {
            for (const url of chunk) {
                const prod = await fetchProductData(url);
                done++;

                if (!prod || !prod.jan || prod.price <= 0) {
                    skipped++;
                    showStatus(`読み込み中: ${done}/${urls.length}\nJAN無し/売切れ: ${skipped}件`, 'rgba(0,80,160,0.9)');
                    continue;
                }
                if (EXCLUDE_CATEGORIES.some(c => prod.category.includes(c))) {
                    skipped++;
                    showStatus(`読み込み中: ${done}/${urls.length}\nカテゴリ除外: ${skipped}件`, 'rgba(0,80,160,0.9)');
                    continue;
                }

                results.push(prod);
                showStatus(`読み込み中: ${done}/${urls.length}\n有効: ${results.length}件 除外: ${skipped}件`, 'rgba(0,80,160,0.9)');
            }
        }

        // URLをCONCURRENCY個のチャンクに分割して並列実行
        const chunkSize = Math.ceil(urls.length / CONCURRENCY);
        const chunks = [];
        for (let i = 0; i < urls.length; i += chunkSize) {
            chunks.push(urls.slice(i, i + chunkSize));
        }
        await Promise.all(chunks.map(worker));

        return results;
    }

    // ──────────────── サーバーへ送信 ────────────────
    function postToServer(products) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method:  'POST',
                url:     SERVER_URL,
                headers: { 'Content-Type': 'application/json' },
                data:    JSON.stringify({ products }),
                timeout: 180000,
                onload: res => {
                    try {
                        const r = JSON.parse(res.responseText);
                        resolve(r.hits || 0);
                    } catch (_) { resolve(0); }
                },
                onerror:   () => { resolve(-1); },
                ontimeout: () => { resolve(-2); },
            });
        });
    }

    // ──────────────── メインループ ────────────────
    async function runWatcher() {
        while (true) {
            showStatus('コジマShops監視開始...', 'rgba(0,80,160,0.9)');
            await sleep(2000);

            // 1. 全件URL収集
            const urls = await collectProductUrls();
            showStatus(`${urls.length}件のURL取得\n商品詳細読み込み中...`, 'rgba(0,80,160,0.9)');

            // 2. iframeで商品データ取得
            const products = await processUrls(urls);
            showStatus(`有効${products.length}件をサーバーへ送信中...`, 'rgba(80,0,160,0.9)');

            // 3. サーバーへ送信・照合
            const hits = await postToServer(products);

            if (hits === -1) {
                showStatus(`サーバー未起動\n次回: 30分後`, 'rgba(160,0,0,0.9)');
            } else if (hits === -2) {
                showStatus(`タイムアウト（照合中）\n次回: 30分後`, 'rgba(160,80,0,0.9)');
            } else {
                showStatus(`完了！ ${hits}件ヒット\n次回: 30分後（自動リロード）`, 'rgba(0,100,0,0.9)');
            }

            // 4. 30分待機→リロードで最新データを取得
            await sleep(INTERVAL_MS);
            window.location.reload();
        }
    }

    // ページ読み込み完了後に起動
    await sleep(2500);
    runWatcher();
})();
