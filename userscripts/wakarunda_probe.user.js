// ==UserScript==
// @name         ワカルンダ読み取りテスト（Amacari販売数）
// @namespace    amacari
// @version      0.1
// @description  Amazon商品ページでワカルンダが表示した販売数・危険度・出品者数を読み取れるか確認するだけのテスト。何も送信しない。
// @match        https://www.amazon.co.jp/*
// @run-at       document-idle
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  "use strict";
  if (!/\/(dp|gp\/product)\/[A-Z0-9]{10}/.test(location.pathname)) return;
  const asin = (location.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/) || [])[1];

  // 通常のDOMと、開いている(open)shadow DOMの中も含めてテキストを集める
  function collectRoots(root, out) {
    out.push(root);
    const all = root.querySelectorAll ? root.querySelectorAll("*") : [];
    for (const el of all) if (el.shadowRoot) collectRoots(el.shadowRoot, out);
    return out;
  }

  function findSalesBlock() {
    for (const root of collectRoots(document, [])) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let n;
      while ((n = walker.nextNode())) {
        if (n.nodeValue && n.nodeValue.includes("販売数")) {
          // 「1年間」まで含む一番近い祖先を表全体とみなす
          let el = n.parentElement;
          for (let i = 0; el && i < 8; i++, el = el.parentElement) {
            if ((el.innerText || "").includes("1年間")) return { el, inShadow: root !== document };
          }
        }
      }
    }
    return null;
  }

  function findWidget(startEl) {
    // 危険度・出品者数まで含む大きめの枠
    let el = startEl;
    for (let i = 0; el && i < 12; i++, el = el.parentElement) {
      const t = el.innerText || "";
      if (t.includes("危険度") && /新品\(\d+\)/.test(t)) return el;
    }
    return null;
  }

  function parse(salesText, widgetText) {
    const r = {};
    const m = salesText.replace(/\s+/g, " ").match(/30日間\s*90日間\s*180日間\s*1年間.*?販売数[^0-9]*?(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/);
    if (m) Object.assign(r, { d30: +m[1], d90: +m[2], d180: +m[3], d365: +m[4] });
    const w = (widgetText || "").replace(/\s+/g, " ");
    const risk = w.match(/危険度\s*([A-Z])/); if (risk) r.risk = risk[1];
    const sellers = w.match(/新品\((\d+)\)\s*\/\s*中古\((\d+)\)/); if (sellers) { r.newSellers = +sellers[1]; r.usedSellers = +sellers[2]; }
    const oos = w.match(/本体在庫切れ率\s*[:：]\s*(\d+)%/); if (oos) r.amazonOosPct = +oos[1];
    const brand = w.match(/ブランド\s*[:：]\s*([^\s>]+)/); if (brand) r.brand = brand[1];
    return r;
  }

  function show(text, ok) {
    const box = document.createElement("div");
    box.style.cssText = "position:fixed;top:8px;left:8px;z-index:2147483647;max-width:520px;padding:10px 12px;border-radius:8px;font:12px/1.5 monospace;white-space:pre-wrap;box-shadow:0 2px 10px rgba(0,0,0,.3);" +
      (ok ? "background:#ecfdf5;border:2px solid #10b981;color:#064e3b;" : "background:#fef2f2;border:2px solid #ef4444;color:#7f1d1d;");
    box.textContent = text;
    const btn = document.createElement("button");
    btn.textContent = "診断情報をコピー";
    btn.style.cssText = "display:block;margin-top:6px;font:12px sans-serif;";
    btn.onclick = () => { GM_setClipboard(window.__wakarundaProbe || text); btn.textContent = "コピーしました"; };
    box.appendChild(btn);
    const close = document.createElement("button");
    close.textContent = "閉じる";
    close.style.cssText = "display:block;margin-top:4px;font:12px sans-serif;";
    close.onclick = () => box.remove();
    box.appendChild(close);
    document.body.appendChild(box);
  }

  const started = Date.now();
  const timer = setInterval(() => {
    const found = findSalesBlock();
    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    if (found) {
      clearInterval(timer);
      const widget = findWidget(found.el);
      const result = parse(found.el.innerText || "", widget ? widget.innerText : "");
      const ok = result.d30 !== undefined;
      const diag = [
        `ASIN: ${asin}`,
        `見つかるまで: ${elapsed}秒 / shadow DOM内: ${found.inShadow}`,
        `読み取り結果: ${JSON.stringify(result)}`,
        `--- 販売数ブロックの文字 ---`,
        (found.el.innerText || "").slice(0, 400),
        `--- 販売数ブロックのHTML(先頭) ---`,
        found.el.outerHTML.slice(0, 1500),
        `--- ウィジェット全体の文字(先頭) ---`,
        widget ? (widget.innerText || "").slice(0, 800) : "(危険度を含む枠は見つからず)",
      ].join("\n");
      window.__wakarundaProbe = diag;
      console.log("[ワカルンダ読み取りテスト]\n" + diag);
      show((ok ? "✅ 読み取り成功\n" : "⚠ 表は見つかったが数字を読めず\n") +
        `30日:${result.d30 ?? "-"} 90日:${result.d90 ?? "-"} 180日:${result.d180 ?? "-"} 1年:${result.d365 ?? "-"}\n` +
        `危険度:${result.risk ?? "-"} 新品:${result.newSellers ?? "-"}人 中古:${result.usedSellers ?? "-"}人 本体在庫切れ率:${result.amazonOosPct ?? "-"}%\n` +
        `（${elapsed}秒で検出）`, ok);
    } else if (Date.now() - started > 30000) {
      clearInterval(timer);
      const iframes = [...document.querySelectorAll("iframe")].map(f => f.src).filter(s => s && !s.includes("amazon")).slice(0, 10);
      const diag = `ASIN: ${asin}\n30秒待ったが「販売数」の表をページ内で見つけられませんでした。\n` +
        `（閉じたshadow DOM や 拡張機能専用のiframe の中に表示している可能性）\n` +
        `amazon以外のiframe: ${JSON.stringify(iframes)}`;
      window.__wakarundaProbe = diag;
      console.log("[ワカルンダ読み取りテスト]\n" + diag);
      show("❌ " + diag, false);
    }
  }, 1000);
})();
