// ==UserScript==
// @name         Mercari ASIN Checker
// @namespace    http://tampermonkey.net/
// @version      3.8
// @description  メルカリ検索結果をASINリストと照合して仕入れ候補を表示（クローラーリサーチのグループ選択をチェックボックスで複数選択可能に）
// @match        https://jp.mercari.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        unsafeWindow
// @connect      localhost
// @updateURL    https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_asin_checker.user.js
// @downloadURL  https://raw.githubusercontent.com/tomo3104/amacari-app/main/userscripts/mercari_asin_checker.user.js
// ==/UserScript==

(function () {
    'use strict';

    const SERVER_URL   = 'http://localhost:8766/check-mercari';
    // メルカリ検索条件（クローラーリサーチ用）
    const BATCH_CONDITIONS = 'status=on_sale&item_condition_id=1&shipping_payer_id=2';

    // カテゴリ検索URL一覧（1周目: CAT 1000-10000円 / 2周目: CAT2 10001-20000円）
    const BASE_CAT  = 'item_condition_id=1&shipping_payer_id=2&price_min=1000&price_max=10000&sort=created_time&order=desc';
    const BASE_CAT2 = 'item_condition_id=1&shipping_payer_id=2&price_min=10001&price_max=20000&sort=created_time&order=desc';
    const STATIC_CATEGORIES = [
        { name: 'ライト・照明',                       group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=65` },
        { name: 'テレビ・映像機器',                   group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=98` },
        { name: 'オーディオ機器',                     group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=99` },
        { name: '生活家電',                           group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=101` },
        { name: 'ノートPC',                           group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=840` },
        { name: 'PC周辺機器',                         group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=841` },
        { name: 'テレビ',                             group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=848` },
        { name: 'カーナビ',                           group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=1113` },
        { name: 'カーオーディオ',                     group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=1114` },
        { name: 'ETC車載器',                          group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=1117` },
        { name: 'PCパーツ',                           group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=1156` },
        { name: 'アウトドア',                         group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=1164` },
        { name: '美容家電',                           group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=1237` },
        { name: '冷暖房・空調',                       group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=1243` },
        { name: 'ディスプレイ・モニター',             group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=1262` },
        { name: '旅行用家電',                         group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=3117` },
        { name: 'キーボード',                         group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=3710` },
        { name: 'マウス・トラックボール',             group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=3716` },
        { name: '外付けHDD・ドライブ',               group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=3756` },
        { name: 'ルーター・ネットワーク機器',         group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=3770` },
        { name: 'プリンター・複合機',                 group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=3733` },
        { name: 'スキャナー',                         group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=3811` },
        { name: '分配器・切替器',                     group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=3820` },
        { name: 'Webカメラ',                          group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=3829` },
        { name: 'PCスピーカー',                       group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=3831` },
        { name: 'メモリーカード',                     group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=3875` },
        { name: '生活家電・空調',                     group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=4136` },
        { name: '電池・充電池アクセサリー',           group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=4290` },
        { name: '電卓',                               group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=5457` },
        { name: '防犯・セーフティ',                   group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=5497` },
        { name: '電動工具・エア工具',                 group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=5598` },
        { name: '計測・検査',                         group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=5907` },
        { name: 'ゴルフ GPSナビ',                    group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=8096` },
        { name: 'ゴルフ用距離計',                    group: 'CAT',  url: `https://jp.mercari.com/search?${BASE_CAT}&category_id=8097` },
        { name: 'ライト・照明',                       group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=65` },
        { name: 'テレビ・映像機器',                   group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=98` },
        { name: 'オーディオ機器',                     group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=99` },
        { name: '生活家電',                           group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=101` },
        { name: 'ノートPC',                           group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=840` },
        { name: 'PC周辺機器',                         group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=841` },
        { name: 'テレビ',                             group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=848` },
        { name: 'カーナビ',                           group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=1113` },
        { name: 'カーオーディオ',                     group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=1114` },
        { name: 'ETC車載器',                          group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=1117` },
        { name: 'PCパーツ',                           group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=1156` },
        { name: 'アウトドア',                         group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=1164` },
        { name: '美容家電',                           group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=1237` },
        { name: '冷暖房・空調',                       group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=1243` },
        { name: 'ディスプレイ・モニター',             group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=1262` },
        { name: '旅行用家電',                         group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=3117` },
        { name: 'キーボード',                         group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=3710` },
        { name: 'マウス・トラックボール',             group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=3716` },
        { name: '外付けHDD・ドライブ',               group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=3756` },
        { name: 'ルーター・ネットワーク機器',         group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=3770` },
        { name: 'プリンター・複合機',                 group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=3733` },
        { name: 'スキャナー',                         group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=3811` },
        { name: '分配器・切替器',                     group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=3820` },
        { name: 'Webカメラ',                          group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=3829` },
        { name: 'PCスピーカー',                       group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=3831` },
        { name: 'メモリーカード',                     group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=3875` },
        { name: '生活家電・空調',                     group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=4136` },
        { name: '電池・充電池アクセサリー',           group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=4290` },
        { name: '電卓',                               group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=5457` },
        { name: '防犯・セーフティ',                   group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=5497` },
        { name: '電動工具・エア工具',                 group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=5598` },
        { name: '計測・検査',                         group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=5907` },
        { name: 'ゴルフ GPSナビ',                    group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=8096` },
        { name: 'ゴルフ用距離計',                    group: 'CAT2', url: `https://jp.mercari.com/search?${BASE_CAT2}&category_id=8097` },
    ];

    const STATIC_MANUFACTURERS = [
        { name: 'エレコム', group: '1', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3908` },
        { name: 'アイ・オー・データ', group: '1', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=12598` },
        { name: 'サンワサプライ', group: '1', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=4132` },
        { name: 'ホリ', group: '1', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=47396` },
        { name: 'アイリスオーヤマ', group: '1', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2555` },
        { name: 'カシオ', group: '2', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&category_id=113%2C3888%2C4136&brand_id=2905&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'データシステム', group: '2', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=37498` },
        { name: '東芝', group: '2', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3289` },
        { name: 'サンエイ', group: '2', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16172` },
        { name: 'ソニー', group: '2', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3285` },
        { name: 'パナソニック', group: '3', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3291` },
        { name: 'シャープ', group: '3', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&category_id=1027%2C10712%2C1106%2C113%2C1156%2C1206%2C1262%2C1318%2C1328%2C1844%2C2634%2C3%2C3088%2C3134%2C3675%2C3694%2C3875%2C3888%2C4%2C4136%2C5%2C5597%2C6%2C6386%2C69%2C8%2C839%2C840%2C841%2C9%2C968%2C9879&brand_id=3282&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'INAX', group: '3', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16537` },
        { name: '藤井電工', group: '3', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=44586` },
        { name: 'LIXIL', group: '3', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=17518` },
        { name: 'KVK', group: '4', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16671` },
        { name: 'maxell', group: '4', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=13268` },
        { name: '日本アンテナ', group: '4', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=39915` },
        { name: 'Yupiteru', group: '4', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=4191` },
        { name: 'buffalo', group: '4', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16814` },
        { name: '象印', group: '5', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3284` },
        { name: 'MASPRO', group: '5', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=48137` },
        { name: 'PHILIPS', group: '5', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3295` },
        { name: 'GENTOS', group: '5', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3386` },
        { name: 'tanita', group: '5', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2718` },
        { name: 'TWINBIRD', group: '6', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2726` },
        { name: 'ティファール', group: '6', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&category_id=3888%2C4136%2C7&brand_id=2732&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: '三和電子', group: '6', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=31232` },
        { name: 'KOIZUMI', group: '6', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=9091` },
        { name: 'omron', group: '6', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=8945` },
        { name: '日立', group: '7', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3292` },
        { name: 'オーム電機', group: '7', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=25283` },
        { name: '朝日電器', group: '7', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=18988` },
        { name: 'TOTO', group: '7', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=7143` },
        { name: 'DXアンテナ', group: '7', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=37015` },
        { name: 'LOGITEC', group: '8', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=54092` },
        { name: 'TESCOM', group: '8', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=10520` },
        { name: 'KING JIM', group: '8', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16628` },
        { name: 'audio technica', group: '8', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3274` },
        { name: 'YAMAHA', group: '8', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3565` },
        { name: '岩谷産業', group: '9', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2578` },
        { name: 'Karcher', group: '9', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3279` },
        { name: 'エムケー精工', group: '9', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=24400` },
        { name: '三菱電機', group: '9', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8%20%E3%82%B1%E3%83%BC%E3%82%B9%20%E9%9B%BB%E6%B1%A0%20%E3%83%91%E3%83%B3%20%E3%81%B5%E3%81%9F%20%E3%83%86%E3%83%BC%E3%83%97%20%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB%20%E3%83%95%E3%83%A9%E3%82%A4%E3%83%91%E3%83%B3%20%E3%83%86%E3%83%97%E3%83%A9%E3%83%86%E3%83%BC%E3%83%97&brand_id=3302&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'Rinnai', group: '9', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8%20%E3%82%B1%E3%83%BC%E3%82%B9%20%E9%9B%BB%E6%B1%A0%20%E3%83%91%E3%83%B3%20%E3%81%B5%E3%81%9F%20%E3%83%86%E3%83%BC%E3%83%97%20%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB%20%E3%83%95%E3%83%A9%E3%82%A4%E3%83%91%E3%83%B3%20%E3%83%86%E3%83%97%E3%83%A9%E3%83%86%E3%83%BC%E3%83%97&brand_id=17134&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'Verbatim', group: '10', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8%20%E3%82%B1%E3%83%BC%E3%82%B9%20%E9%9B%BB%E6%B1%A0%20%E3%83%91%E3%83%B3%20%E3%81%B5%E3%81%9F%20%E3%83%86%E3%83%BC%E3%83%97%20%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB%20%E3%83%95%E3%83%A9%E3%82%A4%E3%83%91%E3%83%B3%20%E3%83%86%E3%83%97%E3%83%A9%E3%83%86%E3%83%BC%E3%83%97&brand_id=17443&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: '山善', group: '10', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8%20%E3%82%B1%E3%83%BC%E3%82%B9%20%E9%9B%BB%E6%B1%A0%20%E3%82%A4%E3%83%B3%E3%82%AF%20%E6%99%82%E8%A8%88&category_id=100%2C10712%2C1106%2C1156%2C1262%2C3675%2C3694%2C3710%2C3716%2C3728%2C3733%2C3756%2C3770%2C3779%2C3811%2C3820%2C3829%2C3830%2C3831%2C3832%2C3875%2C4124%2C4136%2C5457%2C839%2C840%2C968%2C98%2C99&brand_id=17484&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'エプソン', group: '10', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8%20%E3%82%B1%E3%83%BC%E3%82%B9%20%E9%9B%BB%E6%B1%A0%20%E3%82%A4%E3%83%B3%E3%82%AF%20%E6%99%82%E8%A8%88&category_id=100%2C10712%2C1106%2C1156%2C1262%2C3675%2C3694%2C3710%2C3716%2C3728%2C3733%2C3756%2C3770%2C3779%2C3811%2C3820%2C3829%2C3830%2C3831%2C3832%2C3875%2C4124%2C4136%2C5457%2C839%2C840%2C968%2C98%2C99&brand_id=10495&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'キヤノン', group: '10', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8%20%E3%82%B1%E3%83%BC%E3%82%B9%20%E9%9B%BB%E6%B1%A0%20%E3%82%A4%E3%83%B3%E3%82%AF%20%E6%99%82%E8%A8%88&category_id=100%2C10712%2C1106%2C1156%2C1262%2C3675%2C3694%2C3710%2C3716%2C3728%2C3733%2C3756%2C3770%2C3779%2C3811%2C3820%2C3829%2C3830%2C3831%2C3832%2C3875%2C4124%2C4136%2C5457%2C839%2C840%2C968%2C98%2C99&brand_id=3277&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'NORITZ', group: '10', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=7140` },
        { name: 'crucial', group: '11', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=28504` },
        { name: 'JVC', group: '11', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=31712` },
        { name: 'Vitantonio', group: '11', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2777` },
        { name: 'HATAYA', group: '11', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=41478` },
        { name: 'PIAA', group: '11', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=42426` },
        { name: 'Kalita', group: '12', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2629` },
        { name: 'CAR MATE', group: '12', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=25978` },
        { name: 'IPF', group: '12', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=18328` },
        { name: 'Pioneer', group: '12', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=4129` },
        { name: 'Microsoft', group: '12', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3300` },
        { name: 'NEC', group: '13', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3255` },
        { name: 'OLYMPUS', group: '13', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3276` },
        { name: 'ハクバ', group: '13', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=7205` },
        { name: 'エーモン', group: '13', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=23430` },
        { name: 'アオシマ', group: '13', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=18569` },
        { name: 'ボッシュ', group: '14', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=1131` },
        { name: 'ドリテック', group: '14', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2740` },
        { name: 'ダイニチ', group: '14', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2711` },
        { name: 'クレイツ', group: '15', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16203` },
        { name: 'エアテックス', group: '15', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=23040` },
        { name: 'カクダイ', group: '15', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16595` },
        { name: 'ムラテックKDS', group: '15', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=49681` },
        { name: 'マックス', group: '16', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16801` },
        { name: 'アネスト岩田', group: '16', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=19602` },
        { name: 'スズキット', group: '16', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=33850` },
        { name: 'タスカム', group: '16', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=15553` },
        { name: 'ケンコートキナー', group: '16', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=4196` },
        { name: 'ナカバヤシ', group: '17', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16921` },
        { name: 'タイガー魔法瓶', group: '17', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=35676` },
        { name: '白光', group: '17', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=41538` },
        { name: 'タカギ', group: '17', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=35895` },
        { name: 'メリタ', group: '18', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=17139` },
        { name: 'タジマ', group: '18', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=36031` },
        { name: 'ZOOM', group: '18', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2144` },
        { name: 'キャットアイ', group: '18', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3347` },
        { name: 'ブラザー', group: '18', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=15339` },
        { name: 'キャプテンスタッグ', group: '19', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2636` },
        { name: 'パイロット', group: '19', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=10505` },
        { name: '高儀', group: '19', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=35896` },
        { name: 'コクヨ', group: '19', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16649` },
        { name: '貝印', group: '20', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2620` },
        { name: 'サーモス', group: '20', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2669` },
        { name: 'ドウシシャ', group: '20', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2737` },
        { name: 'ライソン', group: '20', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16725` },
        { name: 'シマノ', group: '20', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3391` },
        { name: 'マキタ', group: '21', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=9916` },
        { name: 'タミヤ', group: '21', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=36300` },
        { name: 'バンダイ', group: '21', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=958` },
        { name: '家電カテゴリ', group: '22', url: `https://jp.mercari.com/search?category_id=1244%2C1245%2C1246%2C1248%2C1250%2C1251%2C1252%2C1253%2C4142%2C4143%2C4150%2C4158%2C4184%2C4188%2C4193%2C4198%2C4231%2C4232%2C4246%2C4290%2C4293%2C865%2C866%2C867%2C869%2C870%2C871%2C873%2C874%2C875%2C878&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&47295d80-5839-4237-bbfc-deb44b4e7999=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'カメラカテゴリ', group: '22', url: `https://jp.mercari.com/search?category_id=1255%2C4021%2C4074%2C4081%2C4096%2C4121%2C4122%2C4124%2C843%2C845%2C846%2C847%2C98%2C99&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'スマホカテゴリ', group: '22', url: `https://jp.mercari.com/search?category_id=10792%2C10793%2C1106%2C1156%2C1209%2C1262%2C1689%2C3660%2C3662%2C3663%2C3666%2C3673%2C3674%2C3690%2C3691%2C3692%2C3693%2C3703%2C3705%2C3707%2C3709%2C3710%2C3716%2C3728%2C3733%2C3756%2C3770%2C3779%2C3811%2C3820%2C3829%2C3830%2C3831%2C3832%2C3834%2C3839%2C3844%2C3848%2C3875%2C983%2C984%2C986&price_min=1000&price_max=10000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&88ddea4d-0c5e-4117-81e9-02c0848cbab4=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'エレコム', group: '1', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3908` },
        { name: 'アイ・オー・データ', group: '1', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=12598` },
        { name: 'サンワサプライ', group: '1', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=4132` },
        { name: 'ホリ', group: '1', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=47396` },
        { name: 'アイリスオーヤマ', group: '1', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2555` },
        { name: 'カシオ', group: '2', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&category_id=113%2C3888%2C4136&brand_id=2905&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'データシステム', group: '2', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3749` },
        { name: '東芝', group: '2', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3289` },
        { name: 'サンエイ', group: '2', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16172` },
        { name: 'ソニー', group: '2', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3285` },
        { name: 'パナソニック', group: '3', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3291` },
        { name: 'シャープ', group: '3', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&category_id=1027%2C10712%2C1106%2C113%2C1156%2C1206%2C1262%2C1318%2C1328%2C1844%2C2634%2C3%2C3088%2C3134%2C3675%2C3694%2C3875%2C3888%2C4%2C4136%2C5%2C5597%2C6%2C6386%2C69%2C8%2C839%2C840%2C841%2C9%2C968%2C9879&brand_id=3282&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'INAX', group: '3', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16537` },
        { name: '藤井電工', group: '3', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=44586` },
        { name: 'LIXIL', group: '3', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=17518` },
        { name: 'KVK', group: '4', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16671` },
        { name: 'maxell', group: '4', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=13268` },
        { name: '日本アンテナ', group: '4', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=39915` },
        { name: 'Yupiteru', group: '4', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=4191` },
        { name: 'buffalo', group: '4', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16814` },
        { name: '象印', group: '5', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3284` },
        { name: 'MASPRO', group: '5', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=48137` },
        { name: 'PHILIPS', group: '5', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3295` },
        { name: 'GENTOS', group: '5', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3386` },
        { name: 'tanita', group: '5', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2718` },
        { name: 'TWINBIRD', group: '6', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2726` },
        { name: 'ティファール', group: '6', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&category_id=3888%2C4136%2C7&brand_id=2732&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: '三和電子', group: '6', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=31232` },
        { name: 'KOIZUMI', group: '6', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=9091` },
        { name: 'omron', group: '6', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=8945` },
        { name: '日立', group: '7', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3292` },
        { name: 'オーム電機', group: '7', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=25283` },
        { name: '朝日電器', group: '7', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=18988` },
        { name: 'TOTO', group: '7', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=7143` },
        { name: 'DXアンテナ', group: '7', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=37015` },
        { name: 'LOGITEC', group: '8', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=54092` },
        { name: 'TESCOM', group: '8', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=10520` },
        { name: 'KING JIM', group: '8', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16628` },
        { name: 'audio technica', group: '8', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3274` },
        { name: 'YAMAHA', group: '8', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3565` },
        { name: '岩谷産業', group: '9', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2578` },
        { name: 'Karcher', group: '9', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3279` },
        { name: 'エムケー精工', group: '9', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=24400` },
        { name: '三菱電機', group: '9', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8%20%E3%82%B1%E3%83%BC%E3%82%B9%20%E9%9B%BB%E6%B1%A0%20%E3%83%91%E3%83%B3%20%E3%81%B5%E3%81%9F%20%E3%83%86%E3%83%BC%E3%83%97%20%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB%20%E3%83%95%E3%83%A9%E3%82%A4%E3%83%91%E3%83%B3%20%E3%83%86%E3%83%97%E3%83%A9%E3%83%86%E3%83%BC%E3%83%97&brand_id=3302&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'Rinnai', group: '9', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8%20%E3%82%B1%E3%83%BC%E3%82%B9%20%E9%9B%BB%E6%B1%A0%20%E3%83%91%E3%83%B3%20%E3%81%B5%E3%81%9F%20%E3%83%86%E3%83%BC%E3%83%97%20%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB%20%E3%83%95%E3%83%A9%E3%82%A4%E3%83%91%E3%83%B3%20%E3%83%86%E3%83%97%E3%83%A9%E3%83%86%E3%83%BC%E3%83%97&brand_id=17134&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'Verbatim', group: '10', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8%20%E3%82%B1%E3%83%BC%E3%82%B9%20%E9%9B%BB%E6%B1%A0%20%E3%83%91%E3%83%B3%20%E3%81%B5%E3%81%9F%20%E3%83%86%E3%83%BC%E3%83%97%20%E3%83%95%E3%82%A1%E3%82%A4%E3%83%AB%20%E3%83%95%E3%83%A9%E3%82%A4%E3%83%91%E3%83%B3%20%E3%83%86%E3%83%97%E3%83%A9%E3%83%86%E3%83%BC%E3%83%97&brand_id=17443&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: '山善', group: '10', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8%20%E3%82%B1%E3%83%BC%E3%82%B9%20%E9%9B%BB%E6%B1%A0%20%E3%82%A4%E3%83%B3%E3%82%AF%20%E6%99%82%E8%A8%88&category_id=100%2C10712%2C1106%2C1156%2C1262%2C3675%2C3694%2C3710%2C3716%2C3728%2C3733%2C3756%2C3770%2C3779%2C3811%2C3820%2C3829%2C3830%2C3831%2C3832%2C3875%2C4124%2C4136%2C5457%2C839%2C840%2C968%2C98%2C99&brand_id=17484&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'エプソン', group: '10', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8%20%E3%82%B1%E3%83%BC%E3%82%B9%20%E9%9B%BB%E6%B1%A0%20%E3%82%A4%E3%83%B3%E3%82%AF%20%E6%99%82%E8%A8%88&category_id=100%2C10712%2C1106%2C1156%2C1262%2C3675%2C3694%2C3710%2C3716%2C3728%2C3733%2C3756%2C3770%2C3779%2C3811%2C3820%2C3829%2C3830%2C3831%2C3832%2C3875%2C4124%2C4136%2C5457%2C839%2C840%2C968%2C98%2C99&brand_id=10495&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'キヤノン', group: '10', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%20%E7%A0%B4%E3%82%8C%20%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8%20%E3%82%B1%E3%83%BC%E3%82%B9%20%E9%9B%BB%E6%B1%A0%20%E3%82%A4%E3%83%B3%E3%82%AF%20%E6%99%82%E8%A8%88&category_id=100%2C10712%2C1106%2C1156%2C1262%2C3675%2C3694%2C3710%2C3716%2C3728%2C3733%2C3756%2C3770%2C3779%2C3811%2C3820%2C3829%2C3830%2C3831%2C3832%2C3875%2C4124%2C4136%2C5457%2C839%2C840%2C968%2C98%2C99&brand_id=3277&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'NORITZ', group: '10', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=7140` },
        { name: 'crucial', group: '11', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=28504` },
        { name: 'JVC', group: '11', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=31712` },
        { name: 'Vitantonio', group: '11', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2777` },
        { name: 'HATAYA', group: '11', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=41478` },
        { name: 'PIAA', group: '11', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=42426` },
        { name: 'Kalita', group: '12', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2629` },
        { name: 'CAR MATE', group: '12', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=25978` },
        { name: 'IPF', group: '12', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=18328` },
        { name: 'Pioneer', group: '12', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=4129` },
        { name: 'Microsoft', group: '12', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3300` },
        { name: 'NEC', group: '13', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3255` },
        { name: 'OLYMPUS', group: '13', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3276` },
        { name: 'ハクバ', group: '13', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=7205` },
        { name: 'エーモン', group: '13', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=23430` },
        { name: 'アオシマ', group: '13', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=18569` },
        { name: 'ボッシュ', group: '14', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=1131` },
        { name: 'ドリテック', group: '14', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2740` },
        { name: 'ダイニチ', group: '14', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2711` },
        { name: 'クレイツ', group: '15', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16203` },
        { name: 'エアテックス', group: '15', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=23040` },
        { name: 'カクダイ', group: '15', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16595` },
        { name: 'ムラテックKDS', group: '15', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=49681` },
        { name: 'マックス', group: '16', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16801` },
        { name: 'アネスト岩田', group: '16', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=19602` },
        { name: 'スズキット', group: '16', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=33850` },
        { name: 'タスカム', group: '16', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=15553` },
        { name: 'ケンコートキナー', group: '16', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=4196` },
        { name: 'ナカバヤシ', group: '17', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16921` },
        { name: 'タイガー魔法瓶', group: '17', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=35676` },
        { name: '白光', group: '17', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=41538` },
        { name: 'タカギ', group: '17', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=35895` },
        { name: 'メリタ', group: '18', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=17139` },
        { name: 'タジマ', group: '18', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=36031` },
        { name: 'ZOOM', group: '18', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2144` },
        { name: 'キャットアイ', group: '18', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3347` },
        { name: 'ブラザー', group: '18', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=15339` },
        { name: 'キャプテンスタッグ', group: '19', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2636` },
        { name: 'パイロット', group: '19', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=10505` },
        { name: '高儀', group: '19', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=35896` },
        { name: 'コクヨ', group: '19', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16649` },
        { name: '貝印', group: '20', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2620` },
        { name: 'サーモス', group: '20', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2669` },
        { name: 'ドウシシャ', group: '20', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=2737` },
        { name: 'ライソン', group: '20', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=16725` },
        { name: 'シマノ', group: '20', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=3391` },
        { name: 'マキタ', group: '21', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=9916` },
        { name: 'タミヤ', group: '21', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=36300` },
        { name: 'バンダイ', group: '21', url: `https://jp.mercari.com/search?exclude_keyword=%E9%96%8B%E5%B0%81%E6%B8%88%E3%81%BF%E3%80%80%E7%A0%B4%E3%82%8C%E3%80%80%E3%83%80%E3%83%A1%E3%83%BC%E3%82%B8&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&brand_id=958` },
        { name: '家電カテゴリ', group: '22', url: `https://jp.mercari.com/search?category_id=1244%2C1245%2C1246%2C1248%2C1250%2C1251%2C1252%2C1253%2C4142%2C4143%2C4150%2C4158%2C4184%2C4188%2C4193%2C4198%2C4231%2C4232%2C4246%2C4290%2C4293%2C865%2C866%2C867%2C869%2C870%2C871%2C873%2C874%2C875%2C878&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&47295d80-5839-4237-bbfc-deb44b4e7999=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'カメラカテゴリ', group: '22', url: `https://jp.mercari.com/search?category_id=1255%2C4021%2C4074%2C4081%2C4096%2C4121%2C4122%2C4124%2C843%2C845%2C846%2C847%2C98%2C99&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
        { name: 'スマホカテゴリ', group: '22', url: `https://jp.mercari.com/search?category_id=10792%2C10793%2C1106%2C1156%2C1209%2C1262%2C1689%2C3660%2C3662%2C3663%2C3666%2C3673%2C3674%2C3690%2C3691%2C3692%2C3693%2C3703%2C3705%2C3707%2C3709%2C3710%2C3716%2C3728%2C3733%2C3756%2C3770%2C3779%2C3811%2C3820%2C3829%2C3830%2C3831%2C3832%2C3834%2C3839%2C3844%2C3848%2C3875%2C983%2C984%2C986&price_min=10001&price_max=20000&item_condition_id=1&shipping_payer_id=2&status=on_sale&sort=created_time&order=desc&item_types=mercari&88ddea4d-0c5e-4117-81e9-02c0848cbab4=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088&d664efe3-ae5a-4824-b729-e789bf93aba9=B38F1DC9286E0B80812D9B19DB14298C1FF1116CA8332D9EE9061026635C9088` },
    ];

    const ITEM_SEL    = 'div.merItemThumbnail[itemtype="ITEM_TYPE_MERCARI"]';
    const NAME_SEL    = '[data-testid="thumbnail-item-name"]';
    const PRICE_SEL   = '.merPrice span:last-child';
    const IMAGE_SEL   = 'img';
    const NEXT_SEL    = '[data-testid="pagination-next-button"] a';
    const SCROLL_STEP = Math.floor(window.innerHeight * 0.75);
    const SCROLL_WAIT = 600;
    const MAX_SCROLL  = 90000;

    // ========== UI ==========
    const container = document.createElement('div');
    container.style.cssText = `
        position:fixed; bottom:20px; left:20px; z-index:99999;
        display:flex; flex-direction:column; align-items:flex-start; gap:8px;
    `;
    const statusEl = document.createElement('div');
    statusEl.style.cssText = `
        background:rgba(0,0,0,0.78); color:#fff; padding:6px 14px;
        border-radius:6px; font-size:13px; display:none; max-width:300px; text-align:left;
    `;
    const startBtn = document.createElement('button');
    startBtn.textContent = 'リサーチ';
    startBtn.style.cssText = `
        padding:12px 22px; background:#2196F3; color:#fff;
        border:none; border-radius:6px; font-size:16px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    `;
    const stopBtn = document.createElement('button');
    stopBtn.textContent = '中止';
    stopBtn.style.cssText = `
        padding:12px 22px; background:#f44336; color:#fff;
        border:none; border-radius:6px; font-size:16px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3); display:none;
    `;
    const batchBtn = document.createElement('button');
    batchBtn.textContent = 'クローラーリサーチ';
    batchBtn.style.cssText = `
        padding:12px 22px; background:#9C27B0; color:#fff;
        border:none; border-radius:6px; font-size:14px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    `;
    const kojimaBtn = document.createElement('button');
    kojimaBtn.textContent = 'コジマ';
    kojimaBtn.style.cssText = `
        padding:12px 22px; background:#00897B; color:#fff;
        border:none; border-radius:6px; font-size:14px;
        cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,0.3);
    `;
    container.appendChild(statusEl);
    container.appendChild(startBtn);
    container.appendChild(batchBtn);
    container.appendChild(kojimaBtn);
    container.appendChild(stopBtn);
    document.body.appendChild(container);

    // ========== 状態 ==========
    let running = false;
    let items   = {};

    function updateStatus(msg) {
        statusEl.style.display = 'block';
        statusEl.textContent   = msg;
    }
    function setRunningUI(on) {
        startBtn.style.display = on ? 'none'  : 'block';
        stopBtn.style.display  = on ? 'block' : 'none';
    }
    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ========== fetch化: 共有テンプレートから直接API呼び出し（v2.2） ==========
    const _SHARED_TPL_KEY = 'mercari_api_shared_tpl';
    const _uw = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

    function _getSharedTpl() {
        try {
            const s = _uw.localStorage.getItem(_SHARED_TPL_KEY);
            return s ? JSON.parse(s) : null;
        } catch(e) { return null; }
    }

    async function fetchCheckerItems(mfrUrl, ctx) {
        const tpl = _getSharedTpl();
        if (!tpl) throw new Error('NO_TEMPLATE');

        const sp = new URLSearchParams(new URL(mfrUrl).search);
        const keyword = sp.get('keyword') || '';
        const brandId = sp.get('brand_id');
        const statusMap = { sold_out: 'STATUS_SOLD_OUT', on_sale: 'STATUS_ON_SALE' };
        const apiStatus = statusMap[sp.get('status') || 'on_sale'] || 'STATUS_ON_SALE';

        const allItems = {};
        let pageToken = '';

        for (let page = 0; page < 20; page++) {
            const bodyObj = JSON.parse(tpl.body);
            const sc = bodyObj.searchCondition = bodyObj.searchCondition || {};
            sc.keyword = keyword;
            sc.status = [apiStatus];
            const categoryId = sp.get('category_id');
            if (categoryId) { sc.categoryId = categoryId.split(',').map(Number); } else { delete sc.categoryId; }
            const priceMin = sp.get('price_min') ? Number(sp.get('price_min')) : null;
            const priceMax = sp.get('price_max') ? Number(sp.get('price_max')) : null;
            if (priceMin != null) sc.priceMin = priceMin; else delete sc.priceMin;
            if (priceMax != null) sc.priceMax = priceMax; else delete sc.priceMax;
            if (brandId) { sc.brandId = [parseInt(brandId)]; } else { delete sc.brandId; }
            if (sp.get('item_condition_id')) sc.itemConditionId = sp.get('item_condition_id').split(',').map(Number);
            if (sp.get('shipping_payer_id')) sc.shippingPayerId = sp.get('shipping_payer_id').split(',').map(Number);
            bodyObj.pageToken = pageToken;
            bodyObj.pageSize = 120;

            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 15000);
            let data;
            try {
                const res = await fetch(tpl.url, {
                    method: tpl.method,
                    headers: tpl.headers,
                    credentials: 'include',
                    body: JSON.stringify(bodyObj),
                    signal: ctrl.signal,
                });
                clearTimeout(timer);
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                data = await res.json();
            } catch(e) {
                clearTimeout(timer);
                throw e;
            }

            (data.items || []).forEach(item => {
                const id = item.id || item.itemId;
                if (!id || !item.name || item.price == null) return;
                if (item.auction && item.auction.bidDeadline) return;
                allItems[id] = {
                    name: item.name,
                    price: String(item.price),
                    url: `https://jp.mercari.com/item/${id}`,
                    image: (item.thumbnails && item.thumbnails[0]) || '',
                };
            });

            const cnt = Object.keys(allItems).length;
            if (ctx) updateStatus('[' + ctx.idx + '/' + ctx.total + '] ' + ctx.name + ' p' + (page + 1) + ': ' + cnt + '件');

            const nextToken = (data.meta && data.meta.nextPageToken) || data.nextPageToken || '';
            if (!nextToken || (data.items || []).length === 0) break;
            pageToken = nextToken;
            await sleep(300);
        }
        return allItems;
    }

    async function runBatchFetch(mfrs, selected) {
        const targets = selected.map(s => s.toUpperCase());
        const allMfrs = [...mfrs, ...STATIC_CATEGORIES];
        const filtered = targets.includes('ALL') ? allMfrs : allMfrs.filter(m => targets.includes((m.group || '').toUpperCase()));
        if (filtered.length === 0) { updateStatus('対象なし'); return; }

        running = true;
        setRunningUI(true);

        // ===== テンプレート自動取得 =====
        if (!_getSharedTpl()) {
            updateStatus('テンプレート取得中... 10秒待機');
            GM_openInTab('https://jp.mercari.com/search?keyword=sony&status=on_sale', { active: false });
            await sleep(10000);
            if (!_getSharedTpl()) {
                updateStatus('テンプレート取得失敗 → 中断（リアルタイムリサーチを起動してから再試行）');
                running = false; setRunningUI(false); return;
            }
        }

        let errors = 0;
        const batchStart = Date.now();
        const groupLabel = selected.join(',');
        let totalCollected = 0, totalMatched = 0, totalHits = 0, totalNewCands = 0;
        postTiming({ type: 'start', group: groupLabel, total: filtered.length });

        for (let i = 0; i < filtered.length; i++) {
            if (!running) break;
            const mfr = filtered[i];
            const name = mfr.name || mfr;
            const url = mfr.url || `https://jp.mercari.com/search?keyword=${encodeURIComponent(name)}&${BATCH_CONDITIONS}`;
            updateStatus(`[${i+1}/${filtered.length}] ${name} fetch中...`);

            const mfrStart = Date.now();
            try {
                items = await fetchCheckerItems(url, { name, idx: i + 1, total: filtered.length });
                errors = 0;
                const itemList = Object.values(items);
                updateStatus(`[${i+1}/${filtered.length}] ${name} ${itemList.length}件 → 照合中`);
                totalCollected += itemList.length;
                const result = await new Promise(resolve => sendToServer(itemList, resolve));
                totalMatched  += result.n_model_match || 0;
                totalHits     += (result.matches || []).length;
                totalNewCands += result.new_candidates_count || 0;
                postTiming({ type: 'mfr', name, elapsed_ms: Date.now() - mfrStart, item_count: itemList.length, matched: result.n_model_match || 0, hits: (result.matches || []).length, new_cands: result.new_candidates_count || 0 });
                await sleep(500);
            } catch(e) {
                if (/HTTP 4/.test(e.message) || e.message === 'NO_TEMPLATE') {
                    updateStatus(`[${i+1}/${filtered.length}] ${name} テンプレート更新中...`);
                    _uw.localStorage.removeItem(_SHARED_TPL_KEY);
                    GM_openInTab('https://jp.mercari.com/search?keyword=sony&status=on_sale', { active: false });
                    await sleep(10000);
                    if (_getSharedTpl()) {
                        i--;
                        await sleep(1000);
                        continue;
                    }
                    updateStatus('テンプレート再取得失敗 → 中断');
                    await postTiming({ type: 'end', group: groupLabel, total: filtered.length, elapsed_ms: Date.now() - batchStart, collected: totalCollected, matched: totalMatched, hits: totalHits, new_candidates: totalNewCands });
                    running = false; setRunningUI(false); return;
                }
                errors++;
                updateStatus(`[${i+1}/${filtered.length}] ${name} エラー(${errors}): ${e.message}`);
                if (errors >= 3) {
                    updateStatus(`エラー連続${errors}回 → 再試行してください: ${e.message}`);
                    await postTiming({
                        type: 'end', group: groupLabel, total: filtered.length,
                        elapsed_ms: Date.now() - batchStart,
                        collected: totalCollected, matched: totalMatched,
                        hits: totalHits, new_candidates: totalNewCands,
                    });
                    await sleep(2000);
                    running = false;
                    setRunningUI(false);
                    return;
                }
                await sleep(2000);
            }
        }

        await postTiming({
            type: 'end', group: groupLabel, total: filtered.length,
            elapsed_ms: Date.now() - batchStart,
            collected: totalCollected, matched: totalMatched,
            hits: totalHits, new_candidates: totalNewCands,
        });
        await sleep(2000);
        running = false;
        setRunningUI(false);
        updateStatus(`クローラーリサーチ完了 全${filtered.length}件`);
    }

    // ========== 収集 ==========
    function collectItems() {
        document.querySelectorAll(ITEM_SEL).forEach(el => {
            const id = el.id;
            if (!id || items[id]) return;
            const name  = el.querySelector(NAME_SEL)?.textContent?.trim();
            const price = el.querySelector(PRICE_SEL)?.textContent?.trim().replace(/,/g, '');
            const url   = `https://jp.mercari.com/item/${id}`;
            const image = el.querySelector(IMAGE_SEL)?.src || '';
            if (name && price) items[id] = { name, price, url, image };
        });
    }
    function waitForItems() {
        return new Promise(resolve => {
            const t = setInterval(() => {
                if (document.querySelector(NAME_SEL)) { clearInterval(t); resolve(); }
            }, 300);
            setTimeout(() => { clearInterval(t); resolve(); }, 10000);
        });
    }
    function waitForUrlChange(oldUrl) {
        return new Promise(resolve => {
            const t = setInterval(() => {
                if (location.href !== oldUrl) { clearInterval(t); resolve(); }
            }, 300);
            setTimeout(() => { clearInterval(t); resolve(); }, 10000);
        });
    }
    async function scrollAndCollect() {
        window.scrollTo(0, 0);
        await sleep(400);
        const deadline = Date.now() + MAX_SCROLL;
        while (Date.now() < deadline) {
            if (!running) return;
            collectItems();
            const atBottom = Math.ceil(window.scrollY + window.innerHeight) >= document.body.scrollHeight - 80;
            if (atBottom) { await sleep(800); collectItems(); break; }
            window.scrollBy(0, SCROLL_STEP);
            await sleep(SCROLL_WAIT);
        }
    }

    // ========== 結果表示 ==========
    function showResults(matches) {
        const old = document.getElementById('asin-checker-panel');
        if (old) old.remove();

        if (matches.length === 0) {
            updateStatus('照合完了 — ヒットなし');
            setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
            return;
        }

        const panel = document.createElement('div');
        panel.id = 'asin-checker-panel';
        panel.style.cssText = `
            position:fixed; top:20px; right:20px; z-index:99998;
            background:#fff; border:2px solid #2196F3; border-radius:10px;
            padding:16px; width:420px; max-height:80vh; overflow-y:auto;
            box-shadow:0 4px 20px rgba(0,0,0,0.25); font-size:13px; font-family:sans-serif;
        `;

        const header = document.createElement('div');
        header.style.cssText = 'font-weight:bold; font-size:16px; margin-bottom:12px; color:#2196F3;';
        header.textContent = `★ 仕入れ候補 ${matches.length}件`;
        panel.appendChild(header);

        matches.forEach(m => {
            const row = document.createElement('div');
            row.style.cssText = 'border-top:1px solid #eee; padding:10px 0;';
            row.innerHTML = `
                <div style="font-weight:bold; color:#222; margin-bottom:3px;">${m.model}</div>
                <div style="color:#888; font-size:11px; margin-bottom:4px;">${m.name.slice(0, 65)}</div>
                <div style="display:flex; gap:10px; align-items:center; flex-wrap:wrap;">
                    <span style="color:#f44336; font-weight:bold; font-size:15px;">¥${m.mercari_price.toLocaleString()}</span>
                    <span style="color:#999;">→ Amazon ¥${m.amazon_price ? m.amazon_price.toLocaleString() : '?'}</span>
                    <span style="color:#4CAF50; font-weight:bold;">pmax ¥${m.pmax.toLocaleString()}</span>
                </div>
                <div style="color:#2196F3; font-size:12px; margin-top:3px;">
                    差益 ¥${m.diff.toLocaleString()} ／ ASIN: ${m.asin}
                </div>
                <div style="margin-top:4px;">
                    <a href="${m.mercari_url}" target="_blank" style="color:#FF6600; font-size:11px;">メルカリで見る →</a>
                </div>
            `;
            panel.appendChild(row);
        });

        const closeBtn = document.createElement('button');
        closeBtn.textContent = '閉じる';
        closeBtn.style.cssText = `
            margin-top:12px; padding:8px; width:100%;
            background:#f0f0f0; border:none; border-radius:6px; cursor:pointer; font-size:13px;
        `;
        closeBtn.onclick = () => panel.remove();
        panel.appendChild(closeBtn);
        document.body.appendChild(panel);

        updateStatus(`照合完了 — ${matches.length}件ヒット！`);
        setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
    }

    // ========== タイミングログ ==========
    function postTiming(data) {
        return new Promise(resolve => {
            GM_xmlhttpRequest({
                method:   'POST',
                url:      'http://localhost:8766/log-timing',
                headers:  { 'Content-Type': 'application/json' },
                data:     JSON.stringify(data),
                onload:   () => resolve(),
                onerror:  () => resolve(),
                ontimeout: () => resolve(),
            });
        });
    }

    // ========== サーバー送信 ==========
    function sendToServer(itemList, onDone) {
        GM_xmlhttpRequest({
            method:  'POST',
            url:     SERVER_URL,
            headers: { 'Content-Type': 'application/json' },
            data:    JSON.stringify({ items: itemList }),
            timeout: 120000,
            onload: function(res) {
                let result = {};
                try {
                    result = JSON.parse(res.responseText);
                    showResults(result.matches || []);
                } catch(e) {
                    updateStatus('サーバー応答エラー');
                }
                if (onDone) onDone(result);
            },
            ontimeout: function() {
                updateStatus('タイムアウト（60秒）— ヒットはシートに保存済み');
                if (onDone) onDone({});
            },
            onerror: function() {
                updateStatus('サーバー未起動（0_サーバー起動.batを実行してください）');
                if (onDone) onDone({});
            },
        });
    }

    function finish(message) {
        const itemList = Object.values(items);
        running = false;
        // バッチモード中は専用処理
        if (localStorage.getItem('batchMode') === 'true' && window.batchFinishOverride) {
            window.batchFinishOverride(message);
            return;
        }
        setRunningUI(false);
        updateStatus(`${message}（${itemList.length}件収集） サーバーに送信中...`);
        sendToServer(itemList);
    }

    // ========== メインループ ==========
    async function run() {
        let pageCount = 0;
        while (running) {
            pageCount++;
            updateStatus(`収集中... ${pageCount}ページ目`);
            await waitForItems();
            await scrollAndCollect();
            if (!running) { finish('中止'); return; }

            const nextBtn = document.querySelector(NEXT_SEL);
            if (!nextBtn) { finish(`${pageCount}ページ完了`); return; }

            updateStatus(`${pageCount}ページ完了（累計 ${Object.keys(items).length}件）→ 次ページ...`);
            const currentUrl = location.href;
            nextBtn.click();
            await waitForUrlChange(currentUrl);
            await sleep(500);
        }
        finish('中止');
    }

    // ========== クローラーリサーチ ==========
    function showGroupPicker(mfrs) {
        const groups = [...new Set(mfrs.map(m => m.group).filter(g => g))].sort((a, b) => a.localeCompare(b, 'ja', { numeric: true }));
        const groupCounts = {};
        mfrs.forEach(m => { if (m.group) groupCounts[m.group] = (groupCounts[m.group] || 0) + 1; });

        const overlay = document.createElement('div');
        overlay.id = 'group-picker-overlay';
        overlay.style.cssText = `
            position:fixed; inset:0; z-index:100000;
            background:rgba(0,0,0,0.45); display:flex; align-items:center; justify-content:center;
        `;

        const box = document.createElement('div');
        box.style.cssText = `
            background:#fff; border-radius:10px; padding:20px; width:280px; max-height:80vh;
            overflow-y:auto; box-shadow:0 4px 20px rgba(0,0,0,0.3); font-family:sans-serif;
        `;

        const title = document.createElement('div');
        title.textContent = 'クローラーリサーチ - グループを選択';
        title.style.cssText = 'font-weight:bold; font-size:15px; margin-bottom:14px; color:#333;';
        box.appendChild(title);

        const list = document.createElement('div');
        list.style.cssText = 'display:flex; flex-direction:column; gap:8px; margin-bottom:16px;';

        function makeOption(value, label, checked) {
            const wrap = document.createElement('label');
            wrap.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:14px; color:#333; cursor:pointer;';
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.className = 'group-picker-check';
            checkbox.value = value;
            checkbox.checked = !!checked;
            wrap.appendChild(checkbox);
            const span = document.createElement('span');
            span.textContent = label;
            wrap.appendChild(span);
            return wrap;
        }

        const allCheckEl = makeOption('ALL', `ALL（全件・${mfrs.length}件）`, true);
        list.appendChild(allCheckEl);
        const groupEls = groups.map(g => {
            const el = makeOption(g, `${g}（${groupCounts[g]}件）`, false);
            list.appendChild(el);
            return el;
        });
        box.appendChild(list);

        // ALLを選んだら個別グループは自動解除、個別グループを選んだらALLは自動解除
        const allCheckbox = allCheckEl.querySelector('input');
        const groupCheckboxes = groupEls.map(el => el.querySelector('input'));
        allCheckbox.addEventListener('change', () => {
            if (allCheckbox.checked) groupCheckboxes.forEach(c => { c.checked = false; });
        });
        groupCheckboxes.forEach(c => {
            c.addEventListener('change', () => {
                if (c.checked) allCheckbox.checked = false;
            });
        });

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; gap:8px;';

        const okBtn = document.createElement('button');
        okBtn.textContent = '開始';
        okBtn.style.cssText = `
            flex:1; padding:10px; background:#9C27B0; color:#fff; border:none;
            border-radius:6px; font-size:14px; cursor:pointer;
        `;
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'キャンセル';
        cancelBtn.style.cssText = `
            flex:1; padding:10px; background:#f0f0f0; color:#333; border:none;
            border-radius:6px; font-size:14px; cursor:pointer;
        `;
        btnRow.appendChild(okBtn);
        btnRow.appendChild(cancelBtn);
        box.appendChild(btnRow);

        overlay.appendChild(box);
        document.body.appendChild(overlay);

        cancelBtn.onclick = () => overlay.remove();
        okBtn.onclick = () => {
            const checked = Array.from(list.querySelectorAll('.group-picker-check:checked')).map(c => c.value);
            const selected = checked.length > 0 ? checked : ['ALL'];
            overlay.remove();
            runBatchFetch(mfrs, selected);
        };
    }

    function runBatchWithGroups(mfrs, selected) {
        const targets = selected.map(s => s.toUpperCase());
        const allMfrs = [...mfrs, ...STATIC_CATEGORIES];
        const filtered = targets.includes('ALL') ? allMfrs : allMfrs.filter(m => targets.includes((m.group || '').toUpperCase()));
        const label = targets.includes('ALL') ? 'ALL' : selected.join(',');

        if (filtered.length === 0) {
            updateStatus(`グループ「${label}」は見つかりません`);
            return;
        }

        localStorage.setItem('batchMode',  'true');
        localStorage.setItem('batchList',  JSON.stringify(filtered.map(m => ({name: m.name, url: m.url}))));
        localStorage.setItem('batchIndex', '0');
        updateStatus(`クローラーリサーチ開始 ${filtered.length}件（グループ:${label}）`);
        setTimeout(goNextBatch, 1000);
    }

    function startBatch() {
        showGroupPicker(STATIC_MANUFACTURERS);
    }

    // ========== コジマShopsウォッチ ==========
    const KOJIMA_URL    = 'https://jp.mercari.com/shops/profile/WBGoQB8mMBB5VTEpM6PKZK';
    const KOJIMA_SERVER = 'http://localhost:8766/check-shops';
    const KOJIMA_EXCL   = ['タイヤ', 'ホイール', 'バイク', 'オートバイ', '自動車'];
    const KOJIMA_CONC   = 3;

    function gmGet(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET', url,
                timeout: 15000,
                onload:    r => resolve(r.responseText),
                onerror:   () => reject(new Error('fetch error')),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    function parseProductLd(html, url) {
        try {
            const doc = new DOMParser().parseFromString(html, 'text/html');
            let product = null, breadcrumb = null;
            doc.querySelectorAll('script[type="application/ld+json"]').forEach(s => {
                try {
                    const obj = JSON.parse(s.textContent);
                    if (obj['@type'] === 'Product') product = obj;
                    if (obj['@type'] === 'BreadcrumbList') breadcrumb = obj;
                } catch (_) {}
            });
            if (!product) return null;
            const avail = product.offers?.availability || '';
            if (!avail.includes('InStock') && !avail.includes('OnlineOnly')) return null;
            let jan = product.gtin13 || product.gtin || null;
            if (!jan) {
                const m = (product.description || '').match(/JANコード[：:]\s*(\d{13})/);
                if (m) jan = m[1];
            }
            let category = '';
            const blist = breadcrumb?.itemListElement || [];
            if (blist.length >= 3) category = blist[2].name || '';
            else if (blist.length >= 2) category = blist[1].name || '';
            const price = parseInt(product.offers?.price || '0', 10);
            const title = product.name || '';
            const image = (Array.isArray(product.image) ? product.image[0] : product.image) || '';
            return { jan, category, price, title, url, image };
        } catch (_) { return null; }
    }

    async function runKojimaWatch() {
        kojimaBtn.disabled = true;
        kojimaBtn.textContent = '実行中...';
        try {
            updateStatus('コジマShops一覧取得中...');
            const listHtml = await gmGet(KOJIMA_URL);
            const listDoc  = new DOMParser().parseFromString(listHtml, 'text/html');
            const links    = new Set();
            listDoc.querySelectorAll('a').forEach(a => {
                const attr = a.getAttribute('href') || '';
                if (attr.includes('/shops/product/')) {
                    links.add('https://jp.mercari.com' + attr.split('?')[0]);
                }
            });
            const urls = [...links];
            updateStatus(`${urls.length}件のURL取得 → 詳細取得中...`);
            if (urls.length === 0) { updateStatus('商品URLが取得できませんでした'); return; }

            const products = [];
            let done = 0, skipped = 0;

            async function processChunk(chunk) {
                for (const purl of chunk) {
                    try {
                        const html = await gmGet(purl);
                        const prod = parseProductLd(html, purl);
                        done++;
                        if (!prod || !prod.jan || prod.price <= 0) { skipped++; }
                        else if (KOJIMA_EXCL.some(c => prod.category.includes(c))) { skipped++; }
                        else { products.push(prod); }
                        updateStatus(`詳細取得: ${done}/${urls.length}  有効:${products.length}件  除外:${skipped}件`);
                    } catch (_) { done++; skipped++; }
                }
            }

            const chunkSize = Math.ceil(urls.length / KOJIMA_CONC);
            const chunks = [];
            for (let i = 0; i < urls.length; i += chunkSize) chunks.push(urls.slice(i, i + chunkSize));
            await Promise.all(chunks.map(processChunk));

            if (products.length === 0) { updateStatus('有効な商品なし（JAN無し/カテゴリ除外）'); return; }

            updateStatus(`${products.length}件をサーバーへ送信中...`);
            await new Promise(resolve => {
                GM_xmlhttpRequest({
                    method: 'POST', url: KOJIMA_SERVER,
                    headers: { 'Content-Type': 'application/json' },
                    data: JSON.stringify({ products }),
                    timeout: 180000,
                    onload:    res => {
                        try {
                            const r = JSON.parse(res.responseText);
                            updateStatus(`コジマウォッチ完了 — ${r.hits || 0}件ヒット`);
                        } catch (_) { updateStatus('コジマウォッチ完了（レスポンス解析失敗）'); }
                        resolve();
                    },
                    onerror:   () => { updateStatus('サーバー未起動'); resolve(); },
                    ontimeout: () => { updateStatus('タイムアウト'); resolve(); },
                });
            });
        } catch (e) {
            updateStatus(`コジマエラー: ${e.message}`);
        } finally {
            kojimaBtn.disabled = false;
            kojimaBtn.textContent = 'コジマ';
        }
    }

    function goNextBatch() {
        const list  = JSON.parse(localStorage.getItem('batchList') || '[]');
        const index = parseInt(localStorage.getItem('batchIndex') || '0');
        if (index >= list.length) {
            localStorage.removeItem('batchMode');
            localStorage.removeItem('batchList');
            localStorage.removeItem('batchIndex');
            updateStatus(`クローラーリサーチ完了！ 全${list.length}件`);
            setRunningUI(false);
            if (localStorage.getItem('autoResearch') === 'true') {
                localStorage.removeItem('autoResearch');
                setTimeout(() => window.close(), 5000);
            }
            return;
        }
        const item = list[index];
        const name = item.name || item;
        const url  = item.url  || `https://jp.mercari.com/search?keyword=${encodeURIComponent(name)}&${BATCH_CONDITIONS}`;
        updateStatus(`[${index+1}/${list.length}] ${name} へ移動中...`);
        location.href = url;
    }

    // バッチモード中のページロード時に自動リサーチ開始
    if (localStorage.getItem('batchMode') === 'true') {
        window.addEventListener('load', () => {
            setTimeout(() => {
                const list  = JSON.parse(localStorage.getItem('batchList') || '[]');
                const index = parseInt(localStorage.getItem('batchIndex') || '0');
                const mfr   = list[index] || '';
                updateStatus(`[${index+1}/${list.length}] ${mfr} リサーチ中...`);
                running = true;
                items   = {};
                setRunningUI(true);
                run();
                // run()完了後に次へ（finishをオーバーライド）
                const origFinish = finish;
                window.batchFinishOverride = function(msg) {
                    running = false;
                    const itemList = Object.values(items);
                    updateStatus(`${msg}（${itemList.length}件）→ サーバーに送信中...`);
                    sendToServer(itemList, () => {
                        localStorage.setItem('batchIndex', String(index + 1));
                        setTimeout(goNextBatch, 500);
                    });
                };
            }, 2000);
        });
    }

    // ========== 自動起動（タスクスケジューラ用） ==========
    // URLに ?auto_research=ALL をつけてChromeを起動するとクローラーリサーチが自動開始する
    if (localStorage.getItem('batchMode') !== 'true') {
        const autoGroup = new URLSearchParams(location.search).get('auto_research');
        if (autoGroup) {
            localStorage.setItem('autoResearch', 'true');
            window.addEventListener('load', () => {
                setTimeout(() => {
                    const groups = autoGroup.toUpperCase() === 'ALL' ? ['ALL'] : autoGroup.split(',');
                    runBatchFetch(STATIC_MANUFACTURERS, groups);
                }, 3000);
            });
        }
    }

    startBtn.addEventListener('click', () => { running = true; items = {}; setRunningUI(true); run(); });
    batchBtn.addEventListener('click', startBatch);
    kojimaBtn.addEventListener('click', runKojimaWatch);
    stopBtn.addEventListener('click',  () => {
        running = false;
        localStorage.removeItem('batchMode');
        localStorage.removeItem('batchList');
        localStorage.removeItem('batchIndex');
    });

})();
