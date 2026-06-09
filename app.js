// GAS Web AppのデプロイURL（/exec で終わるもの）に置き換えてください
const GAS_URL = "https://script.google.com/macros/s/AKfycbz6W83NlKgz8ieDfRrXL2AfaPWo4xFqv_8vr5NT1-NQglc1tuOC50uT-CWEHrG95c64/exec";

function gasUrl(action, params) {
  const usp = new URLSearchParams(Object.assign({ action }, params || {}));
  return `${GAS_URL}?${usp.toString()}`;
}

// GASはCORSプリフライト(OPTIONS)を処理できないため、
// POSTは text/plain で送ってブラウザに preflight を発生させない
function gasPost(action, body) {
  return fetch(gasUrl(action), {
    method: "POST",
    body: JSON.stringify(body),
  });
}

const state = {
  cards: [],
  sort: "new",
  lastRejected: null,   // 巻き戻し用：直前に却下したカード
  pendingReject: null,  // 理由選択待ちのカード
  skipStack: [],        // 後回し（上スワイプ）したカードのスタック：下スワイプで呼び戻す
};

const els = {
  stack: document.getElementById("card-stack"),
  empty: document.getElementById("empty-message"),
  sortSelect: document.getElementById("sort-select"),
  undoBtn: document.getElementById("undo-btn"),
  tabs: document.querySelectorAll(".tab"),
  reviewView: document.getElementById("review-view"),
  archiveView: document.getElementById("archive-view"),
  archiveList: document.getElementById("archive-list"),
  archiveEmpty: document.getElementById("archive-empty"),
  modal: document.getElementById("reason-modal"),
  reasonGrid: document.querySelector(".reason-grid"),
  otherInput: document.getElementById("reason-other-input"),
  otherText: document.getElementById("reason-other-text"),
  otherSubmit: document.getElementById("reason-other-submit"),
};

// ---------- データ取得 ----------

async function loadCards() {
  els.empty.textContent = "読み込み中…";
  els.empty.style.display = "block";
  try {
    const res = await fetch(gasUrl("cards", { sort: state.sort }));
    const data = await res.json();
    state.cards = data.cards || [];
    state.skipStack = [];
    renderStack();
  } catch (e) {
    els.empty.textContent = "読み込みに失敗しました。GAS_URLの設定を確認してください。";
  }
}

async function loadArchive() {
  els.archiveEmpty.textContent = "読み込み中…";
  els.archiveEmpty.style.display = "block";
  els.archiveList.innerHTML = "";
  try {
    const res = await fetch(gasUrl("archive"));
    const data = await res.json();
    renderArchive(data.items || []);
  } catch (e) {
    els.archiveEmpty.textContent = "読み込みに失敗しました。";
  }
}

// ---------- カードのレンダリング ----------

function renderStack() {
  els.stack.querySelectorAll(".card").forEach(c => c.remove());

  if (state.cards.length === 0) {
    els.empty.textContent = "判定待ちの商品はありません。お疲れさまでした。";
    els.empty.style.display = "block";
    return;
  }
  els.empty.style.display = "none";

  // 上位3枚だけDOMに積む（下にいくほど後ろ）
  const visible = state.cards.slice(0, 3).reverse();
  visible.forEach((card, i) => {
    const el = buildCardEl(card);
    const depthFromTop = visible.length - 1 - i;
    el.style.zIndex = String(100 - depthFromTop);
    el.style.transform = `scale(${1 - depthFromTop * 0.04}) translateY(${depthFromTop * 10}px)`;
    if (depthFromTop === 0) attachSwipe(el, card);
    els.stack.appendChild(el);
  });
}

function buildCardEl(card) {
  const el = document.createElement("div");
  el.className = "card";

  const thumb = card.image_url
    ? `<img class="card-thumb" src="${escapeAttr(card.image_url)}" alt="">`
    : `<div class="card-thumb"></div>`;

  el.innerHTML = `
    <div class="swipe-flag flag-like">仕入れ対象</div>
    <div class="swipe-flag flag-nope">却下</div>
    <div class="swipe-flag flag-skip">あとで</div>
    <div class="swipe-flag flag-back">戻る</div>
    ${thumb}
    <div class="card-body">
      <p class="card-name">${escapeHtml(card.name)}</p>
      <p class="card-sub">
        型番：${escapeHtml(card.model)}<button class="copy-btn" data-copy="${escapeAttr(card.model)}" aria-label="型番をコピー"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
        ／ ASIN：${escapeHtml(card.asin)}<button class="copy-btn" data-copy="${escapeAttr(card.asin)}" aria-label="ASINをコピー"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg></button>
      </p>
      <div class="card-highlight">
        <div class="highlight-box highlight-margin">
          <span class="label">利益率</span>
          <span class="value">${formatPercent(card.margin)}</span>
        </div>
        <div class="highlight-box highlight-roi">
          <span class="label">ROI</span>
          <span class="value">${formatPercent(card.roi)}</span>
        </div>
      </div>
      <div class="card-grid">
        <div><span>Amazon価格</span>${formatYen(card.amazon_price)}</div>
        <div><span>メルカリ価格</span>${formatYen(card.mercari_price)}</div>
        <div><span>差額</span>${formatYen(card.diff)}</div>
        <div><span>仕入上限</span>${formatYen(card.pmax)}</div>
      </div>
      <div class="card-keepa">
        <p class="keepa-label">Keepa（90日）</p>
        <img class="keepa-graph" src="https://graph.keepa.com/pricehistory.png?asin=${encodeURIComponent(card.asin)}&domain=5&range=90&amazon=1&new=1" alt="Keepaグラフ" loading="lazy">
      </div>
      <div class="card-links">
        <a class="link-btn link-amazon" href="https://www.amazon.co.jp/dp/${encodeURIComponent(card.asin)}" target="_blank" rel="noopener">Amazon</a>
        <a class="link-btn link-mercari" href="${escapeAttr(card.mercari_url)}" target="_blank" rel="noopener">メルカリ</a>
      </div>
    </div>
  `;
  return el;
}

// ---------- コピー操作 ----------

els.stack.addEventListener("click", async e => {
  const btn = e.target.closest(".copy-btn");
  if (!btn) return;
  e.stopPropagation();
  const text = btn.dataset.copy || "";
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#2e7d32" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>';
    btn.disabled = true;
    setTimeout(() => { btn.innerHTML = original; btn.disabled = false; }, 1200);
  } catch (e) {
    alert("コピーに失敗しました。");
  }
});

// ---------- スワイプ操作 ----------

function attachSwipe(el, card) {
  let startX = 0, startY = 0, dx = 0, dy = 0, dragging = false;

  const likeFlag = el.querySelector(".flag-like");
  const nopeFlag = el.querySelector(".flag-nope");
  const skipFlag = el.querySelector(".flag-skip");
  const backFlag = el.querySelector(".flag-back");
  const flags = [likeFlag, nopeFlag, skipFlag, backFlag];

  function onStart(x, y) {
    dragging = true;
    startX = x; startY = y;
    el.classList.add("dragging");
  }

  function onMove(x, y) {
    if (!dragging) return;
    dx = x - startX;
    dy = y - startY;
    el.style.transform = `translate(${dx}px, ${dy}px) rotate(${dx / 12}deg)`;
    flags.forEach(f => f.style.opacity = 0);
    if (Math.abs(dx) >= Math.abs(dy)) {
      const ratio = Math.min(Math.abs(dx) / 120, 1);
      (dx > 0 ? likeFlag : nopeFlag).style.opacity = ratio;
    } else {
      const ratio = Math.min(Math.abs(dy) / 120, 1);
      (dy < 0 ? skipFlag : backFlag).style.opacity = ratio;
    }
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;
    el.classList.remove("dragging");
    const threshold = 100;
    const absX = Math.abs(dx), absY = Math.abs(dy);
    if (absX >= absY && absX > threshold) {
      finishSwipe(el, card, dx > 0 ? "right" : "left");
    } else if (absY > absX && absY > threshold) {
      finishVerticalSwipe(el, card, dy < 0 ? "up" : "down");
    } else {
      el.style.transform = "";
      flags.forEach(f => f.style.opacity = 0);
    }
  }

  el.addEventListener("pointerdown", e => {
    if (e.target.closest(".copy-btn")) return; // コピー操作はスワイプとして扱わない
    el.setPointerCapture(e.pointerId);
    onStart(e.clientX, e.clientY);
  });
  el.addEventListener("pointermove", e => onMove(e.clientX, e.clientY));
  el.addEventListener("pointerup", onEnd);
  el.addEventListener("pointercancel", onEnd);
}

function finishSwipe(el, card, direction) {
  const flyX = direction === "right" ? window.innerWidth : -window.innerWidth;
  el.style.transform = `translateX(${flyX}px) rotate(${direction === "right" ? 30 : -30}deg)`;
  el.style.opacity = "0";

  setTimeout(() => {
    el.remove();
    state.cards = state.cards.filter(c => c.row !== card.row);
    if (direction === "right") {
      judge(card, "仕入れ対象", "");
    } else {
      openReasonModal(card);
    }
    renderStack();
  }, 220);
}

// 上スワイプ＝後回し（末尾に送る）／下スワイプ＝直前に後回しにした1件を呼び戻す
// シートへの書き込みは行わず、画面内の表示順だけを変える
function finishVerticalSwipe(el, card, direction) {
  const flyY = direction === "up" ? -window.innerHeight : window.innerHeight;
  el.style.transform = `translateY(${flyY}px)`;
  el.style.opacity = "0";

  setTimeout(() => {
    el.remove();
    if (direction === "up") {
      state.cards = state.cards.filter(c => c.row !== card.row);
      state.cards.push(card);
      state.skipStack.push(card);
    } else {
      const prev = state.skipStack.pop();
      if (prev) {
        state.cards = state.cards.filter(c => c.row !== prev.row);
        state.cards.unshift(prev);
      }
    }
    renderStack();
  }, 220);
}

// ---------- 判定の送信 ----------

async function judge(card, judgment, reason) {
  try {
    await gasPost("judge", { row: card.row, judgment, reason });
    if (judgment === "却下") {
      state.lastRejected = card;
      els.undoBtn.disabled = false;
    }
  } catch (e) {
    alert("判定の保存に失敗しました。通信状況を確認してください。");
  }
}

async function undoLastReject() {
  const card = state.lastRejected;
  if (!card) return;
  els.undoBtn.disabled = true;
  try {
    await gasPost("undo", { row: card.row });
    state.lastRejected = null;
    state.cards.unshift(card);
    renderStack();
  } catch (e) {
    alert("巻き戻しに失敗しました。");
    els.undoBtn.disabled = false;
  }
}

// ---------- 却下理由モーダル ----------

function openReasonModal(card) {
  state.pendingReject = card;
  els.otherInput.classList.add("hidden");
  els.otherText.value = "";
  els.modal.classList.remove("hidden");
}

function closeReasonModal() {
  state.pendingReject = null;
  els.modal.classList.add("hidden");
}

els.reasonGrid.addEventListener("click", e => {
  const btn = e.target.closest(".reason-btn");
  if (!btn) return;
  if (btn.id === "reason-other-btn") {
    els.otherInput.classList.remove("hidden");
    els.otherText.focus();
    return;
  }
  const card = state.pendingReject;
  closeReasonModal();
  if (card) judge(card, "却下", btn.dataset.reason);
});

els.otherSubmit.addEventListener("click", () => {
  const card = state.pendingReject;
  const text = els.otherText.value.trim() || "その他";
  closeReasonModal();
  if (card) judge(card, "却下", text);
});

// ---------- アーカイブ ----------

function renderArchive(items) {
  if (items.length === 0) {
    els.archiveEmpty.textContent = "アーカイブされた商品はまだありません。";
    els.archiveEmpty.style.display = "block";
    return;
  }
  els.archiveEmpty.style.display = "none";
  els.archiveList.innerHTML = items.map(item => `
    <li class="archive-item" data-row="${item.row}">
      ${item.image_url ? `<img class="archive-thumb" src="${escapeAttr(item.image_url)}" alt="">` : `<div class="archive-thumb"></div>`}
      <div class="archive-info">
        <p class="name">${escapeHtml(item.name)}</p>
        <p class="meta">利益率 ${formatPercent(item.margin)} ／ ROI ${formatPercent(item.roi)} ／ ${escapeHtml(item.judgment)}</p>
      </div>
      <div class="archive-actions">
        <a href="${escapeAttr(item.mercari_url)}" target="_blank" rel="noopener">メルカリで見る</a>
        ${item.judgment === "購入済み"
          ? `<button class="done" disabled>購入済み</button>`
          : `<button data-action="purchased">購入済みにする</button>
             <button data-action="reject-archive">却下に戻す</button>`}
      </div>
    </li>
  `).join("");
}

els.archiveList.addEventListener("click", async e => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const li = btn.closest(".archive-item");
  const row = Number(li.dataset.row);
  const action = btn.dataset.action;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "更新中…";
  try {
    if (action === "purchased") {
      await gasPost("purchased", { row });
    } else if (action === "reject-archive") {
      await gasPost("judge", { row, judgment: "却下", reason: "キャンセル" });
    }
    loadArchive();
  } catch (e) {
    btn.disabled = false;
    btn.textContent = original;
    alert("更新に失敗しました。");
  }
});

// ---------- タブ切り替え ----------

els.tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    els.tabs.forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const view = tab.dataset.view;
    if (view === "review") {
      els.reviewView.classList.remove("hidden");
      els.archiveView.classList.add("hidden");
      loadCards();
    } else {
      els.reviewView.classList.add("hidden");
      els.archiveView.classList.remove("hidden");
      loadArchive();
    }
  });
});

els.sortSelect.addEventListener("change", () => {
  state.sort = els.sortSelect.value;
  loadCards();
});

els.undoBtn.addEventListener("click", undoLastReject);

// ---------- ユーティリティ ----------

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function escapeAttr(s) { return escapeHtml(s); }

function formatYen(v) {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" ? `¥${n.toLocaleString()}` : "−";
}

function formatPercent(v) {
  const n = Number(v);
  return Number.isFinite(n) && v !== "" ? `${n}%` : "−";
}

// ---------- 起動 ----------

if ("serviceWorker" in navigator) {
  // PWAとして必要最小限：オフラインキャッシュは行わずホーム画面追加対応のみ
}

loadCards();
