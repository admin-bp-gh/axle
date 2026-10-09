/* assets/axle.js: Axle's client library (redesign v1, 7 Oct 2026). Plain JavaScript, no build step,
   loaded deferred on every page after htmx. It writes the same markup and behaviour as the Workbench
   React primitives (menu, sheet, dialog, drawer, page, toast) over the shared wb- classes.
   Sections, in order:
     1. Basics: strings, icons, the phone test, small helpers
     2. Overlay stack (Esc closes only the topmost) and focus trap
     3. Menu, Sheet, Overlay (dialog, drawer, page), Toast, Banner, confirm dialog
     4. In-place posting, autosave, next email, keyboard
     5. Queue: open an email, Back, filters, the search, live refresh, pull to refresh, Sync now
     6. Compose
     7. Phone draft protection, growing text areas, htmx failures, busy buttons
     8. The email: the reply editor's adapter, translations, folds, the photo viewer, files and the
        camera, documents, the To and Cc lines, Teach, Reset
   The public surface is window.Axle (the end of this file); AXLE-JS.md in _ref is the how-to. */
(() => {
  "use strict";

  /* ---------- 1. Basics ---------- */
  const D = document, W = window;
  const B = D.documentElement.dataset.base || "";
  const L = JSON.parse(D.getElementById("ax-l10n")?.textContent || "{}");
  const t = (k, vars) => Object.entries(vars || {}).reduce((s, [a, b]) => s.replace("{" + a + "}", b), L[k] ?? k);
  const PHONE = W.matchMedia("(max-width: 639.98px)");
  const ONEPANE = W.matchMedia("(max-width: 1023.98px)");
  const phone = () => PHONE.matches;
  const $ = (s, r = D) => r.querySelector(s);
  const $$ = (s, r = D) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const nodes = (html) => { const tp = D.createElement("template"); tp.innerHTML = html.trim(); return [...tp.content.children]; };
  const store = (kind, fn) => { try { return fn(W[kind]); } catch (e) { return null; } };
  const ICONS = {
    check: [2.4, '<polyline points="20 6 9 17 4 12"/>'],
    x: [2.2, '<path d="M6 6l12 12M18 6 6 18"/>'],
    alert: [2.2, '<path d="M10.3 3.8 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>'],
    info: [2.2, '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>'],
    clip: [2, '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>'],
    mail: [2, '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="m2 7 10 6 10-6"/>'],
    search: [2.2, '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>'],
    refresh: [2, '<path d="M21 12a9 9 0 1 1-6.2-8.6"/><polyline points="21 3 21 9 15 9"/>'],
    "chevron-right": [2.2, '<path d="m9 6 6 6-6 6"/>'],
    back: [2.2, '<polyline points="15 18 9 12 15 6"/>'],
  };
  const icon = (n) => `<svg class="wb-i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${ICONS[n][0]}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n][1]}</svg>`;
  const ITEM_RE = new RegExp("^" + B + "/item/(\\d+)(/|$)");
  const itemIdOf = (path) => (ITEM_RE.exec(path || "") || [])[1] || null;
  const currentId = () => itemIdOf(location.pathname);

  /* ---------- 2. Overlay stack and focus ---------- */
  // Every open menu, sheet, dialog, drawer and page is a layer; Esc closes only the topmost, and
  // not while it is busy (a post in flight). One capture listener, so nothing else sees that Esc.
  const stack = [];
  W.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !stack.length) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const top = stack[stack.length - 1];
    if (!top.busy) top.close();
  }, true);
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusables = (root) => $$(FOCUSABLE, root).filter((el) => el.offsetParent !== null || el === D.activeElement);
  function trapTab(e) {
    if (e.key !== "Tab") return;
    const list = focusables(e.currentTarget);
    if (!list.length) { e.preventDefault(); return; }
    const first = list[0], last = list[list.length - 1], at = D.activeElement;
    if (e.shiftKey && (at === first || at === e.currentTarget)) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus(); }
  }
  // A layer: { el, close, busy }. open() registers it; its close() undoes everything and returns
  // focus to what had it before (the trigger), unless focus has already moved on.
  function layer(el, undo, trap = true) {
    const before = D.activeElement;
    const ly = {
      el, busy: false,
      close() {
        const i = stack.indexOf(ly);
        if (i < 0) return;
        stack.splice(i, 1);
        const had = el.contains(D.activeElement) || D.activeElement === D.body;
        undo();
        if (had && before && D.contains(before)) before.focus({ preventScroll: true });
      },
    };
    stack.push(ly);
    if (trap && !el.axTrap) { el.axTrap = true; el.addEventListener("keydown", trapTab); }
    return ly;
  }
  const layerOf = (node) => stack.find((ly) => ly.el.contains(node)) || null;

  /* ---------- 3. Menu, Sheet, Overlay, Toast, Banner, confirm ---------- */
  // Swipe down to close a sheet: a touch on the handle or title always drags; one in the body only
  // when the sheet is scrolled to the top and the first movement is downward. Fields never drag.
  function swipeDown(el, close) {
    el.axSwipe = close;
    if (el.axSwiping) return;
    el.axSwiping = true;
    let mode = "idle", startY = 0, lastY = 0, lastT = 0, speed = 0;
    const setY = (y, animate) => { el.style.transition = animate ? "transform 150ms ease-out" : "none"; el.style.transform = y > 0 ? `translateY(${y}px)` : ""; };
    el.addEventListener("touchstart", (e) => {
      const tg = e.target;
      mode = "idle";
      if (e.touches.length !== 1 || tg.closest("input, textarea, select")) return;
      const head = !!tg.closest(".wb-sheet__grab, .wb-sheet__t");
      if (!head && el.scrollTop > 0) return;
      mode = head ? "drag" : "pending";
      startY = lastY = e.touches[0].clientY;
      lastT = e.timeStamp;
      speed = 0;
    }, { passive: true });
    el.addEventListener("touchmove", (e) => {
      if (mode === "idle") return;
      const y = e.touches[0].clientY, dy = y - startY;
      if (mode === "pending") {
        if (dy < 0) { mode = "idle"; return; }
        if (dy < 6) return;
        mode = "drag";
      }
      if (e.cancelable) e.preventDefault();
      speed = (y - lastY) / Math.max(1, e.timeStamp - lastT);
      lastY = y;
      lastT = e.timeStamp;
      setY(Math.max(0, dy), false);
    }, { passive: false });
    const end = () => {
      if (mode !== "drag") { mode = "idle"; return; }
      mode = "idle";
      if (lastY - startY > 96 || speed > 0.5) { setY(el.offsetHeight, true); setTimeout(() => { el.axSwipe(); setY(0, false); }, 150); }
      else setY(0, true);
    };
    el.addEventListener("touchend", end);
    el.addEventListener("touchcancel", end);
  }

  // Sheet (phone): a choice or anything without a text input. content: nodes appended under the title.
  function openSheet(title, content, onClosed) {
    const [scrim] = nodes('<div class="wb-scrim"></div>');
    const [el] = nodes(`<div class="wb-sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}" tabindex="-1"><div class="wb-sheet__grab" aria-hidden="true"></div><h2 class="wb-sheet__t">${esc(title)}</h2></div>`);
    el.append(...content);
    D.body.append(scrim, el);
    const ly = layer(el, () => { scrim.remove(); el.remove(); onClosed?.(); });
    scrim.addEventListener("click", () => { if (!ly.busy) ly.close(); });
    swipeDown(el, () => { if (!ly.busy) ly.close(); });
    return ly;
  }

  // Menu: [data-menu="name"] opens <template id="m-name" data-title data-align="start|end">: an
  // anchored popover (arrow keys, Home, End, Esc, a press outside closes it), a Sheet on a phone.
  // Rows are .wb-menu__item buttons or links; choosing one closes the menu, then its data
  // attributes act as anywhere else (data-q, data-sync, data-overlay, data-confirm, a link's href).
  let menuLy = null;
  function openMenu(trigger) {
    const src = D.getElementById("m-" + trigger.dataset.menu);
    if (!src) return;
    const title = src.dataset.title || trigger.getAttribute("aria-label") || "";
    const [list] = nodes(`<div role="menu" aria-label="${esc(title)}" tabindex="-1"></div>`);
    list.append(src.content.cloneNode(true));
    const rows = () => $$(".wb-menu__item:not(:disabled)", list);
    list.addEventListener("keydown", (e) => {
      const r = rows(), i = r.indexOf(D.activeElement);
      const go = (n) => { e.preventDefault(); r[(n + r.length) % r.length]?.focus(); };
      if (e.key === "ArrowDown") go(i + 1);
      else if (e.key === "ArrowUp") go(i < 0 ? -1 : i - 1);
      else if (e.key === "Home") go(0);
      else if (e.key === "End") go(-1);
      else if (e.key === "Tab") menuLy?.close();
    });
    trigger.setAttribute("aria-expanded", "true");
    const done = () => { trigger.setAttribute("aria-expanded", "false"); menuLy = null; };
    if (phone()) {
      menuLy = openSheet(title, [list], done);
    } else {
      const [m] = nodes('<div class="wb-menu"></div>');
      m.append(list);
      D.body.append(m);
      const place = () => {
        const r = trigger.getBoundingClientRect(), w = m.offsetWidth, h = m.offsetHeight;
        const below = r.bottom + 4 + h <= innerHeight - 8 || r.top - 4 - h < 8;
        const left = src.dataset.align === "end" ? r.right - w : r.left;
        m.style.top = (below ? r.bottom + 4 : r.top - 4 - h) + "px";
        m.style.left = Math.min(Math.max(8, left), innerWidth - w - 8) + "px";
      };
      const away = (e) => { if (!m.contains(e.target) && !trigger.contains(e.target)) menuLy?.close(); };
      place();
      W.addEventListener("resize", place);
      W.addEventListener("scroll", place, true);
      D.addEventListener("pointerdown", away, true);
      menuLy = layer(m, () => {
        W.removeEventListener("resize", place);
        W.removeEventListener("scroll", place, true);
        D.removeEventListener("pointerdown", away, true);
        m.remove();
        done();
      }, false);
    }
    menuLy.trigger = trigger;
    ($('.wb-menu__item[aria-checked="true"]:not(:disabled)', list) || rows()[0] || list).focus({ preventScroll: true });
  }

  // Overlay: one markup, drawn as the vocabulary's dialog or drawer from 640 up, and on a phone as a
  // Page when it holds a text input (data-form) or a Sheet when it does not.
  //   <div class="ax-ov" data-kind="dialog|drawer" [data-size="lg"] [data-form] role="dialog" hidden>
  //     <div class="ax-ov__hd">[.ax-ov__back data-close] <h2 class="ax-ov__t"> [.ax-ov__x data-close]</div>
  //     <div class="ax-ov__bd">...</div>  <div class="ax-ov__ft">... [.ax-ov-desk: not on a page]</div>
  //   </div>
  // src is that element (kept and reused: its state survives a close) or a <template> holding it
  // (cloned, removed on close). The element moves to the end of body, so a Page can hide the rest.
  function openOverlay(src, trigger) {
    const tmp = src.tagName === "TEMPLATE";
    const el = tmp ? src.content.firstElementChild.cloneNode(true) : src;
    if (!tmp && layerOf(el)) return layerOf(el);
    const kind = el.dataset.kind || "dialog";
    const mode = phone() ? (el.hasAttribute("data-form") ? "page" : "sheet") : kind;
    const part = (c) => $(":scope > " + c, el) || $(c, el);
    const hd = part(".ax-ov__hd"), tt = part(".ax-ov__t"), bd = part(".ax-ov__bd"), ft = part(".ax-ov__ft");
    const added = [];
    const add = (n, c) => { if (n) { n.classList.add(c); added.push([n, c]); } };
    const extra = [];
    let savedY = 0;
    D.body.append(el);
    if (mode === "page") {
      [[el, "wb-page"], [hd, "wb-page__hd"], [tt, "wb-page__t"], [bd, "wb-page__bd"], [ft, "wb-bar"]].forEach(([n, c]) => add(n, c));
      savedY = scrollY;
      D.body.classList.add("wb-pgopen");
    } else if (mode === "sheet") {
      const [scrim] = nodes('<div class="wb-scrim"></div>');
      const [grab] = nodes('<div class="wb-sheet__grab" aria-hidden="true"></div>');
      el.before(scrim);
      el.prepend(grab);
      extra.push(scrim, grab);
      [[el, "wb-sheet"], [tt, "wb-sheet__t"], [bd, "wb-sheet__bd"], [ft, "wb-ov__ft"]].forEach(([n, c]) => add(n, c));
    } else {
      const [scrim] = nodes(`<div class="wb-scrim${kind === "dialog" ? " wb-scrim--dialog" : ""}"></div>`);
      el.before(scrim);
      extra.push(scrim);
      [[el, "wb-" + kind], [hd, "wb-ov__hd"], [tt, "wb-ov__t"], [bd, "wb-ov__bd"], [ft, "wb-ov__ft"]].forEach(([n, c]) => add(n, c));
      if (el.dataset.size === "lg") add(el, "wb-dialog--lg");
    }
    el.tabIndex = -1;
    el.hidden = false;
    const ly = layer(el, () => {
      added.forEach(([n, c]) => n.classList.remove(c));
      extra.forEach((n) => n.remove());
      el.hidden = true;
      el.style.transform = "";
      if (mode === "page") { D.body.classList.remove("wb-pgopen"); scrollTo(0, savedY); }
      if (tmp) el.remove();
      el.dispatchEvent(new CustomEvent("ax:closed"));
    });
    ly.trigger = trigger;
    if (extra[0]) extra[0].addEventListener("click", () => { if (!ly.busy) ly.close(); });
    if (mode === "sheet") swipeDown(el, () => { if (!ly.busy) ly.close(); });
    if (mode === "page") pageFlow(el);
    else ($("[data-autofocus]", el) || focusables(bd || el)[0] || el).focus({ preventScroll: true });
    return ly;
  }
  // Page: the window is the only scroll container, so iOS lifts a focused field above the keyboard
  // itself. It starts at the top with no field focused (the keyboard waits for a tap); a field the
  // user focuses is centred once the keyboard is in. (web/src/components/ui/page.tsx, usePageFlow.)
  function pageFlow(el) {
    scrollTo(0, 0);
    if (D.activeElement?.matches?.("input, textarea, select")) D.activeElement.blur();
    el.axPage = { openedAt: Date.now(), touched: false, timer: 0 };
    if (el.axPaged) return;
    el.axPaged = true;
    const touch = () => { el.axPage.touched = true; };
    el.addEventListener("pointerdown", touch, { passive: true });
    el.addEventListener("touchstart", touch, { passive: true });
    el.addEventListener("focusin", (e) => {
      const f = e.target, pg = el.axPage;
      if (!el.classList.contains("wb-page") || !f.matches("input, textarea, select")) return;
      if (!pg.touched && Date.now() - pg.openedAt < 800) { f.blur(); return; }
      clearTimeout(pg.timer);
      pg.timer = setTimeout(() => {
        if (D.activeElement !== f) return;
        const vh = W.visualViewport?.height ?? innerHeight;
        f.scrollIntoView({ block: f.offsetHeight > vh / 2 ? "start" : "center", behavior: "smooth" });
      }, 300);
    });
  }

  // Toast: one at a time, bottom centre, 3 s, announced politely.
  let toastTimer = 0;
  function toast(msg) {
    let box = $(".wb-toaster");
    if (!box) { [box] = nodes('<div class="wb-toaster" role="status" aria-live="polite"></div>'); D.body.append(box); }
    box.innerHTML = `<div class="wb-toast">${icon("check")}<span>${esc(msg)}</span></div>`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.innerHTML = ""; }, 3000);
  }

  // Banner: the one inline notice. Goes into the nearest [data-ax-banner] slot (inside host, or in
  // the overlay or email around it), else at the top of host; replaces the banner it put there before.
  // opts: { tone: "bad"|"warn"|"info"|"ok", message, detail, more, unchanged, action: {label, run} };
  // detail is a named value on its own line (an offending link), more the technical text behind Details.
  function banner(host, opts) {
    const tone = opts.tone || "bad";
    const slot = (host.matches("[data-ax-banner]") && host) || $("[data-ax-banner]", host)
      || host.closest(".ax-ov, .ax-email, #workpane, #queuepane")?.querySelector("[data-ax-banner]");
    const [el] = nodes(`<div class="wb-banner" data-tone="${tone}" data-ax-made${tone === "bad" ? ' role="alert"' : ""}>${icon(tone === "info" ? "info" : tone === "ok" ? "check" : "alert")}<div class="wb-banner__body"></div></div>`);
    const body = el.lastElementChild;
    body.textContent = opts.message || "";
    if (opts.unchanged) body.append(" " + t("unchanged"));
    if (opts.detail) body.append(...nodes(`<span class="ax-link">${esc(opts.detail)}</span>`));
    if (opts.more) body.append(...nodes(`<details class="wb-details"><summary>${esc(t("details"))}${icon("chevron-right")}</summary><pre>${esc(opts.more)}</pre></details>`));
    if (opts.action) {
      const [b] = nodes(`<button type="button" class="wb-btn wb-btn--sm">${opts.action.icon ? icon(opts.action.icon) : ""}<span>${esc(opts.action.label)}</span></button>`);
      b.addEventListener("click", opts.action.run);
      el.append(b);
    }
    if (slot) slot.replaceChildren(el);
    else { $(":scope > [data-ax-made]", host)?.remove(); host.prepend(el); }
    el.scrollIntoView({ block: "nearest" });
    return el;
  }
  const clearBanner = (host) => $$("[data-ax-made]", host).forEach((n) => n.remove());

  // Confirm: a button with data-confirm="Question?\n\nMore text." asks in a Dialog (a Sheet on a
  // phone) before its click goes through; data-confirm-ok names the go button. Read as data.
  function confirmFirst(btn) {
    const [head, ...rest] = btn.dataset.confirm.split(/\n\s*\n/);
    const [el] = nodes(`<div class="ax-ov" data-kind="dialog" role="dialog" aria-modal="true" hidden><div class="ax-ov__hd"><h2 class="ax-ov__t"></h2><button type="button" class="wb-btn wb-btn--ghost wb-btn--icon ax-ov__x" data-close aria-label="${esc(t("close"))}">${icon("x")}</button></div><div class="ax-ov__bd"><p class="ax-confirm"></p></div><div class="ax-ov__ft"><button type="button" class="wb-btn" data-close>${esc(t("cancel"))}</button><button type="button" class="wb-btn wb-btn--primary" data-autofocus>${esc(btn.dataset.confirmOk || t("confirm_ok"))}</button></div></div>`);
    $(".ax-ov__t", el).textContent = head;
    $(".ax-confirm", el).textContent = rest.join("\n\n");
    if (!rest.length) $(".ax-ov__bd", el).remove();
    const tp = D.createElement("template");
    tp.content.append(el);
    const ly = openOverlay(tp, btn);
    $("[data-autofocus]", ly.el).addEventListener("click", () => {
      ly.close();
      if (btn.isConnected) { btn.dataset.axConfirmed = "1"; btn.click(); }
      else submitRow(btn);   // a menu row: the menu closed before the question was asked
    });
  }
  // A menu row that posts: data-submit="form id" plus its own name and value. A row leaves the page
  // when its menu closes, so it cannot be a submit button of that form; it posts the form in place.
  function submitRow(row) {
    const f = D.getElementById(row.dataset.submit);
    if (f) post(f, row);
  }

  /* ---------- 4. In-place posting, autosave, next email, keyboard ---------- */
  // A form with data-inline (or a submit button with data-inline) posts with fetch instead of
  // navigating. Headers: X-Axle-Inline: 1 (the server answers refusals as JSON) and HX-Request (the
  // redirect to /item/:id comes back as the work-area fragment, as for a queue click). Attributes
  // on the form or the button: data-target (selector to swap into, default #workpane), data-select
  // (that part of the response replaces the target: a desk page redrawn around a decision),
  // data-next (open the next email on success), data-toast (success message). A JSON {ok:false} refusal fires
  // "ax:refused" on the form (cancelable) and otherwise shows a bad banner; the typed text stays.
  const busyBtn = (b, on) => {
    if (!b) return;
    b.disabled = on;
    b.toggleAttribute("aria-busy", on);
    if (on) b.prepend(...nodes('<span class="wb-spin" aria-hidden="true" data-ax-spin></span>'));
    else $(":scope > [data-ax-spin]", b)?.remove();
  };
  const firstPara = (html) => new DOMParser().parseFromString(html, "text/html").querySelector("main p, p")?.textContent.trim().slice(0, 400) || "";
  async function post(form, submitter, opts = {}) {
    const url = new URL(submitter?.getAttribute("formaction") || form.getAttribute("action"), location.href);
    const data = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (typeof v === "string") data.append(k, v);
    if (submitter?.name) data.append(submitter.name, submitter.value);
    const attr = (k) => submitter?.dataset[k] ?? form.dataset[k];
    clearBanner(form.closest(".ax-ov") || form);
    await flush();
    const ly = layerOf(form);
    if (ly) ly.busy = true;
    busyBtn(submitter, true);
    const fail = (j) => {
      const ev = new CustomEvent("ax:refused", { detail: j, cancelable: true, bubbles: true });
      if (form.dispatchEvent(ev)) banner(form, { tone: "bad", message: j.message, unchanged: j.unchanged });
      return { ok: false, refusal: j };
    };
    let res;
    try {
      res = await fetch(url, { method: "POST", body: data, credentials: "same-origin", headers: { "X-Axle-Inline": "1", "HX-Request": "true" } });
    } catch (e) {
      return fail({ ok: false, kind: "error", message: t("post_failed") });
    } finally {
      busyBtn(submitter, false);
      if (ly) ly.busy = false;
    }
    const json = (res.headers.get("Content-Type") || "").includes("application/json");
    if (json) {
      const j = await res.json();
      if (j.ok === false) return fail(j);
    }
    const html = json ? "" : await res.text();
    if (!res.ok) return fail({ ok: false, kind: "failed", message: firstPara(html) || t("load_error") });
    const path = new URL(res.url).pathname;
    const id = itemIdOf(url.pathname);
    if (id && form.matches("#workform, [data-autosave]")) dropDraft(id);
    if (attr("next") !== undefined || path === B + "/") next(attr("toast"));
    else {
      if (html && !opts.noSwap) swapInto($(attr("target") || "#workpane"), html, path, attr("select"));
      if (attr("toast")) toast(attr("toast"));
    }
    form.dispatchEvent(new CustomEvent("ax:posted", { detail: { path }, bubbles: true }));
    return { ok: true, path };
  }
  // Put an HTML fragment into the page the way htmx does (scripts run, hx- attributes work). Into
  // the work area it is an email: the URL follows, the row is marked, the one-pane view switches.
  // The same email swapped for itself (after an action on it) keeps the scroll position, the focus
  // and any text the server does not hold (a new outbound's subject), so nothing typed is lost.
  // With select, only that part of the response replaces the target (a desk page's main column).
  function swapInto(target, html, path, select) {
    if (select) return W.htmx.swap(target, html, { swapStyle: "outerHTML" }, { select });
    const id = itemIdOf(path);
    const same = target.id === "workpane" && !!id && id === emailEl()?.dataset.email;
    const keep = same ? carry() : null;
    W.htmx.swap(target, html, { swapStyle: "innerHTML" });
    if (target.id !== "workpane") return;
    if (id && id !== currentId()) history.pushState({ htmx: true }, "", path);
    afterWork(!same);
    keep?.();
  }
  function carry() {
    const y = scrollY, f = D.getElementById("workform"), a = D.activeElement;
    const typed = f ? [...f.elements].filter((el) => el.name && isText(el) && el.value !== el.defaultValue).map((el) => [el.name, el.value, el.defaultValue]) : [];
    const focus = a?.name && a.form === f ? [a.name, a.selectionStart, a.selectionEnd] : null;
    const caret = a?.id === "replyed" ? replyEd()?.caret() : null;
    return () => {
      const g = D.getElementById("workform");
      typed.forEach(([n, v, d]) => {
        const el = g?.elements.namedItem(n);
        if (el?.defaultValue !== d) return;
        el.value = v;
        if (n === "reply") replyEd()?.setText(v);
      });
      growAll();
      const el = focus && g?.elements.namedItem(focus[0]);
      if (el?.focus) { el.focus({ preventScroll: true }); try { el.setSelectionRange(focus[1], focus[2]); } catch (e) { /* not a text field */ } }
      if (caret) replyEd()?.setCaret(caret);
      scrollTo(0, y);
    };
  }

  // Autosave: a form with data-autosave (its value, else the form's action, is the existing save
  // route: POST /item/:id/work) saves its text fields 800 ms after the last keystroke. The redirect
  // is not followed (nothing renders, no view row). State on the form as data-save-state (saved,
  // dirty, saving, error), in every [data-ax-saved] element (shown only while saved) and every
  // [data-ax-savefail] element (shown only after a failed save, until one lands), and as the
  // "ax:savestate" event. flush() saves at once; it runs before any inline post and before another
  // email opens, and with keepalive when the page is hidden.
  const sv = { form: null, timer: 0, pending: null };
  const isText = (el) => el.matches?.('textarea, input:is([type="text"], [type="email"], [type="search"], :not([type]))');
  function saveState(form, state) {
    form.dataset.saveState = state;
    $$("[data-ax-saved]").forEach((n) => { n.hidden = state !== "saved"; });
    $$("[data-ax-savefail]").forEach((n) => { n.hidden = state !== "error"; });
    form.dispatchEvent(new CustomEvent("ax:savestate", { detail: { state }, bubbles: true }));
  }
  function save(form, keepalive) {
    clearTimeout(sv.timer);
    sv.timer = 0;
    const data = new URLSearchParams();
    for (const el of form.elements) if (el.name && isText(el) && !el.disabled) data.append(el.name, el.value);
    saveState(form, "saving");
    const snap = dr && form === workForm() ? { id: dr.id, v: dVals(dFields()) } : null;
    sv.pending = fetch(new URL(form.dataset.autosave || form.getAttribute("action"), location.href), { method: "POST", body: data, redirect: "manual", keepalive: !!keepalive, credentials: "same-origin" })
      .then((r) => {
        const ok = r.type === "opaqueredirect" || r.ok;
        saveState(form, ok ? "saved" : "error");
        if (ok && snap) draftSaved(snap);
      })
      .catch(() => saveState(form, "error"));
    return sv.pending;
  }
  function flush(keepalive) {
    if (sv.timer && sv.form?.isConnected) return save(sv.form, keepalive);
    return sv.pending || Promise.resolve();
  }
  D.addEventListener("input", (e) => {
    const f = e.target.form;
    if (!f?.hasAttribute("data-autosave") || !e.target.name || !isText(e.target)) return;
    sv.form = f;
    saveState(f, "dirty");
    clearTimeout(sv.timer);
    sv.timer = setTimeout(() => save(f), 800);
  });
  W.addEventListener("pagehide", () => flush(true));
  D.addEventListener("visibilitychange", () => { if (D.hidden) flush(true); });

  // After Send, Mark done, Phone or a handover (anything that closes the email): nothing opens by
  // itself. The work area clears, a toast confirms, and the Open list comes back unsearched and at
  // the top (Mine | All and the mailbox stay as chosen), so the next pick is the reader's own.
  function next(msg) {
    showVoid(false);
    markSelected("");
    if (msg) toast(msg);
    const field = D.getElementById("q");
    if (field) { field.value = ""; const c = $("[data-q-clear]"); if (c) c.hidden = true; }
    const qs = setParams(Q.qs, { show: "open", q: "" });
    Q.listY = 0;
    Q.listUrl = "";
    history.pushState({ htmx: true }, "", B + "/?" + qs);
    const pane = qp();
    if (pane) pane.scrollTop = 0;
    scrollTo(0, 0);
    refreshQueue({ qs, sel: 0, skeleton: qs !== Q.qs });
  }

  // Keyboard: Ctrl+Enter (Cmd+Enter) sends ([data-send] of the field's form, or the old Send
  // button), from the reply editor too (a contenteditable in the work form); Enter in a single-line
  // field of a posting form never submits it.
  const sendBtnOf = (form) => $$("[data-send], button[formaction$='/send']")
    .find((b) => b.form === form && !b.disabled && b.offsetParent !== null);
  D.addEventListener("keydown", (e) => {
    const form = e.target.form || (e.target.isContentEditable ? e.target.closest("form") : null);
    if (e.key !== "Enter" || e.isComposing || !form) return;
    if (e.ctrlKey || e.metaKey) {
      const b = sendBtnOf(form);
      if (b) { e.preventDefault(); b.click(); }
    } else if (e.target.matches("input:not([type=submit], [type=button], [type=checkbox], [type=radio], [type=file], [type=image], [type=reset])") && (e.target.form.getAttribute("method") || "").toLowerCase() === "post") {
      e.preventDefault();
    }
  });

  /* ---------- 5. Queue ---------- */
  // Q: the queue as rendered (filter query string, change stamp) and the reader's place. F: the
  // search in flight (debounce timer, request number, abort controller).
  const Q = { qs: "", stamp: "", inflight: 0, prev: null, keepY: null, focus: null, touch: 0, listY: 0, listUrl: "", rowReq: null, lastReturn: 0, pollY: null };
  const F = { timer: 0, seq: 0, ctl: null };
  const qp = () => D.getElementById("queuepane");
  const setParams = (qs, more) => { const p = new URLSearchParams(qs); new URLSearchParams(more).forEach((v, k) => p.set(k, v)); if (!p.get("q")) p.delete("q"); return p.toString(); };
  const searchOf = (qs) => new URLSearchParams(qs).get("q") || "";
  const listUrl = () => B + "/?" + Q.qs;
  const openId = () => Q.rowReq?.dataset.id || currentId();
  const skelRows = () => '<div class="ax-skelrow"><span class="wb-skel" style="width:38%"></span><span class="wb-skel" style="width:66%"></span><span class="wb-skel" style="width:86%"></span></div>'.repeat(4);

  function markSelected(id) { $$("#qlist .wb-row").forEach((r) => r.setAttribute("aria-selected", String(r.dataset.id === id))); }
  function setRunning(on) {
    const live = $(".ax-live"), tx = D.getElementById("qlivet");
    if (!live || !tx || live.hasAttribute("data-running") === on) return;
    live.toggleAttribute("data-running", on);
    const nl = D.documentElement.lang === "nl";
    const tm = new Date().toLocaleTimeString(nl ? "nl-NL" : "en-US", { timeZone: "Europe/Amsterdam", hour: "numeric", minute: "2-digit", hour12: !nl });
    tx.textContent = on ? t("syncing") : t("updated", { t: nl ? tm : tm.replace(" ", "").toLowerCase() });
  }
  // Fill the summaries that were not yet translated ([data-trs]), one batched call per render.
  function fillSummaries() {
    const pend = $$("#qlist [data-trs]");
    if (!pend.length) return;
    fetch(B + "/queue/summaries", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "ids=" + pend.map((el) => el.dataset.trs).join(",") })
      .then((r) => r.json())
      .then((d) => pend.forEach((el) => {
        const v = d[el.dataset.trs];
        if (!v) return;
        el.textContent = v;
        el.removeAttribute("data-trs");
      }))
      .catch(() => { /* the English summaries stay */ });
  }
  // After every render of the list (the whole queue, or the list part after a search).
  function afterList() {
    const cur = openId();
    if (cur && $(`#qlist .wb-row[data-id="${cur}"]`)) markSelected(cur);
    $(".ax")?.toggleAttribute("data-empty", $("#queuepane .ax-q")?.dataset.show === "open" && !searchOf(Q.qs) && !$("#qlist .wb-row"));
    markDraftKept();
    fillSummaries();
    D.dispatchEvent(new CustomEvent("ax:queue"));
  }
  // After every render of the queue. The focus a refresh took away (a segment, the search field)
  // comes back to the same control.
  function initQueue() {
    const pane = $("#queuepane .ax-q");
    if (!pane) return;
    Q.qs = pane.dataset.qs;
    Q.stamp = pane.dataset.stamp;
    Q.inflight = 0;
    if (Q.prev) $$("#qlist .wb-row").forEach((r) => { if (!Q.prev.has(r.dataset.id)) r.classList.add("ax-new"); });
    Q.prev = null;
    const f = Q.focus && $(Q.focus, pane);
    Q.focus = null;
    if (f) { f.focus({ preventScroll: true }); if (f.id === "q") f.setSelectionRange(f.value.length, f.value.length); }
    pullReset();
    if (Q.keepY != null && ONEPANE.matches) scrollTo(0, Q.keepY);
    Q.keepY = null;
    afterList();
  }
  // Refresh the queue fragment in place, the search field's text included. opts: qs (a new
  // filter), sel, skeleton (a filter switch shows skeleton rows meanwhile), keepScroll (phone: put
  // the list back where it was). A search in flight is dropped: this render carries its text.
  function refreshQueue(opts = {}) {
    const pane = qp();
    if (!pane || !W.htmx) return;
    const field = D.getElementById("q");
    const qs = field ? setParams(opts.qs || Q.qs, { q: field.value.trim() }) : opts.qs || Q.qs;
    findStop();
    if (qs === Q.qs && !opts.skeleton) Q.prev = new Set($$("#qlist .wb-row").map((r) => r.dataset.id));
    if (opts.keepScroll) Q.keepY = scrollY;
    const a = D.activeElement;
    if (a && pane.contains(a)) Q.focus = a.id === "q" ? "#q" : a.dataset.q ? `.ax-qhd [data-q="${a.dataset.q}"]` : null;
    const list = D.getElementById("qlist");
    if (opts.skeleton && list) { list.innerHTML = skelRows(); $$("#qmoreRow, .ax-qcount").forEach((n) => n.remove()); }
    Q.inflight = Date.now();
    W.htmx.ajax("GET", `${B}/queue?${qs}&sel=${opts.sel ?? (openId() || 0)}`, { target: pane, swap: "innerHTML" });
  }
  // A switch of Mine | All, Open | History or Mailbox (or an offer of an empty search): in place,
  // the search text stays. Open | History (even the one already chosen) also closes the open email,
  // so the work area never shows an email from the list that is not on screen; Mine | All and
  // Mailbox keep it.
  function switchFilter(more) {
    if (new URLSearchParams(more).has("show") && !$("#workpane > .ax-void")) {
      flush(true);
      draftFlush();
      if (Q.rowReq && W.htmx) { W.htmx.trigger(Q.rowReq, "htmx:abort"); Q.rowReq = null; }
      showVoid(true);
      markSelected("");
    }
    const field = D.getElementById("q");
    const qs = setParams(setParams(Q.qs, more), { q: field ? field.value.trim() : searchOf(Q.qs) });
    if (qs === Q.qs) return;
    if (!currentId()) history.replaceState({ htmx: true }, "", B + "/?" + qs);
    refreshQueue({ qs, skeleton: true });
  }

  // The search (both lists, on the server): 250 ms after the last keystroke, at once on Enter or
  // when the field is cleared. Only the list part is redrawn, so the field keeps the focus and the
  // keyboard stays up; only the newest request may draw. While one is out the field shows a spinner;
  // the first search on a list shows skeleton rows, later ones dim the rows they replace.
  function findBusy(on) {
    const ad = $(".ax-qfind .wb-adorn");
    if (!ad) return;
    ad.firstElementChild.toggleAttribute("hidden", on);
    ad.lastElementChild.hidden = !on;
  }
  function findStop() {
    clearTimeout(F.timer);
    F.seq++;
    F.ctl?.abort();
    F.ctl = null;
    findBusy(false);
  }
  function findLater() {
    const v = D.getElementById("q").value;
    $("[data-q-clear]").hidden = !v;
    clearTimeout(F.timer);
    if (v.trim()) F.timer = setTimeout(findNow, 250);
    else findNow();
  }
  function findNow() {
    const field = D.getElementById("q"), list = D.getElementById("qlist"), pane = $("#queuepane .ax-q");
    if (!field || !list || !pane) return;
    const qs = setParams(Q.qs, { q: field.value.trim() });
    if (qs === Q.qs && !F.ctl) return;
    findStop();
    const seq = F.seq, ctl = F.ctl = new AbortController(), was = [...list.childNodes];
    if (searchOf(qs) && !searchOf(Q.qs)) list.innerHTML = skelRows();
    else list.setAttribute("aria-busy", "true");
    findBusy(true);
    Q.inflight = Date.now();
    fetch(`${B}/queue?${qs}&sel=${openId() || 0}`, { signal: ctl.signal, credentials: "same-origin" })
      .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
      .then((html) => {
        if (seq !== F.seq) return;
        F.ctl = null;
        findBusy(false);
        const tp = D.createElement("template");
        tp.innerHTML = html;
        const fresh = tp.content.querySelector(".ax-q"), body = tp.content.getElementById("qbody");
        pane.dataset.qs = Q.qs = fresh.dataset.qs;
        pane.dataset.stamp = Q.stamp = fresh.dataset.stamp;
        Q.inflight = 0;
        D.getElementById("qbody").replaceWith(body);
        W.htmx.process(body);
        if (!currentId()) history.replaceState({ htmx: true }, "", listUrl());
        afterList();
      })
      .catch(() => {
        if (seq !== F.seq) return;
        F.ctl = null;
        findBusy(false);
        list.replaceChildren(...was);
        list.removeAttribute("aria-busy");
        banner(qp(), { tone: "bad", message: t("post_failed") });
      });
  }

  // The live refresh: every 10 s a cheap stamp probe; the list re-renders only when the stamp
  // changed. Held back (the "New activity" pill shows instead) while a field in the queue has focus,
  // a menu or overlay is open, the list is paged past its first page, or the list is scrolled away
  // from the top (one-pane: the page scroll or a touch in the last 10 s). A hidden tab pauses it.
  // Only a field being typed in holds the refresh back, never a row: opening an email leaves the
  // focus on its row, and until 2026-10-09 that silently froze the live refresh for the rest of
  // the visit (the list only moved again after a manual reload).
  const TYPING = 'input:not([type="hidden"]), textarea, select, [contenteditable="true"]';
  function holdBack(pane) {
    const a = D.activeElement;
    if (a && a !== D.body && pane.contains(a) && a.matches(TYPING)) return true;
    if (stack.length) return true;
    if (+(D.getElementById("qlist")?.dataset.page || 1) > 1) return true;
    if (ONEPANE.matches) return Date.now() - Q.touch < 10000 || scrollY > 0;
    return pane.scrollTop > 0;
  }
  function tick() {
    if (!W.htmx || D.hidden || !Q.qs) return;
    if (Q.inflight && Date.now() - Q.inflight < 15000) return;
    const qs = Q.qs;
    fetch(`${B}/queue/stamp?${qs}`, { headers: { Accept: "application/json" }, cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || Q.qs !== qs) return;
        setRunning(!!d.running);
        if (d.stamp === Q.stamp) return;
        const pane = qp();
        if (!pane || !pane.offsetParent) return;
        if (holdBack(pane)) { const u = D.getElementById("qupd"); if (u) u.hidden = false; return; }
        refreshQueue();
      })
      .catch(() => { /* offline or restarting: the next tick tries again */ });
  }
  setInterval(tick, 10000);
  // Back to the tab: probe at once; on one pane also refresh the list (at most every 5 s), as on return
  // from an email and from the back-forward cache.
  function queueReturn() {
    const pane = qp();
    if (!ONEPANE.matches || !pane || !pane.offsetParent || D.body.classList.contains("ax-detail")) return;
    const a = D.activeElement;
    if ((a && a !== D.body && pane.contains(a)) || +(D.getElementById("qlist")?.dataset.page || 1) > 1 || Date.now() - Q.lastReturn < 5000) return;
    Q.lastReturn = Date.now();
    refreshQueue({ keepScroll: true });
  }
  D.addEventListener("visibilitychange", () => { if (!D.hidden) { tick(); queueReturn(); } });
  W.addEventListener("pageshow", (e) => { if (e.persisted) queueReturn(); });
  D.addEventListener("touchstart", (e) => { if (e.target.closest?.("#qlist")) Q.touch = Date.now(); }, { capture: true, passive: true });

  // Pull to refresh (one pane, touch): a mostly vertical downward drag that starts in the queue with
  // the page at the top. Only the indicator moves; past 70 px the release refreshes.
  let pl = null, pulling = null;
  function pullReset() {
    pl = null;
    if (pulling) { clearTimeout(pulling); pulling = null; }
    $$(".ax-pull").forEach((n) => n.remove());
  }
  D.addEventListener("touchstart", (e) => {
    pl = null;
    const pane = qp();
    if (pulling || !ONEPANE.matches || e.touches.length !== 1 || scrollY > 0 || !pane?.offsetParent || D.body.classList.contains("ax-detail")) return;
    if (!pane.contains(e.target) || e.target.closest("input, textarea, select") || stack.length) return;
    pl = { x: e.touches[0].clientX, y: e.touches[0].clientY, dy: 0, el: null };
  }, { passive: true });
  D.addEventListener("touchmove", (e) => {
    if (!pl) return;
    const dx = e.touches[0].clientX - pl.x, dy = e.touches[0].clientY - pl.y;
    if (!pl.el) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      if (dy <= 0 || Math.abs(dx) > dy || scrollY > 0) { pl = null; return; }
      [pl.el] = nodes(`<div class="ax-pull" role="status"><span><span class="wb-spin" aria-hidden="true"></span><span></span></span></div>`);
      $(".ax-qhd")?.after(pl.el);
    }
    pl.dy = Math.max(0, dy);
    pl.el.firstElementChild.style.transform = `translateY(${Math.round(Math.min(pl.dy * 0.6, 56))}px)`;
    pl.el.firstElementChild.lastElementChild.textContent = t(pl.dy >= 70 ? "refreshing" : "pull_refresh");
  }, { passive: true });
  D.addEventListener("touchend", () => {
    const s = pl;
    pl = null;
    if (!s?.el) return;
    if (s.dy < 70) { s.el.remove(); return; }
    s.el.classList.add("is-snap");
    s.el.firstElementChild.style.transform = "translateY(40px)";
    pulling = setTimeout(pullReset, 20000);
    refreshQueue();
  });
  D.addEventListener("touchcancel", () => { pl?.el?.remove(); pl = null; });

  // Opening an email (a row is an hx-get link): save the open email first, remember the list
  // (one pane), mark the row, and show the email's skeleton while it loads.
  const skelEmail = '<div class="ax-col" aria-busy="true"><div class="ax-head"><span class="wb-skel" style="width:55%;height:14px"></span><span class="wb-skel" style="width:30%"></span></div><div class="wb-card"><div class="wb-card__bd wb-skel-rows"><span class="wb-skel" style="width:40%"></span><span class="wb-skel" style="width:92%"></span><span class="wb-skel" style="width:86%"></span><span class="wb-skel" style="width:64%"></span></div></div><div class="wb-card"><div class="wb-card__bd wb-skel-rows"><span class="wb-skel" style="width:24%"></span><span class="wb-skel" style="width:90%"></span><span class="wb-skel" style="width:78%"></span><span class="wb-skel" style="width:56%"></span></div></div></div>';
  D.addEventListener("htmx:beforeRequest", (e) => {
    const el = e.detail.elt;
    const row = el?.closest?.("#qlist .wb-row");
    if (row) {
      flush(true);
      draftFlush();
      if (ONEPANE.matches && !currentId()) { Q.listY = scrollY; Q.listUrl = location.pathname + location.search; }
      Q.rowReq = row;
      markSelected(row.dataset.id);
      row.setAttribute("aria-busy", "true");
      $("#workpane").innerHTML = skelEmail;
      D.body.classList.add("ax-detail");
      if (ONEPANE.matches) scrollTo(0, 0);
    }
    if ((el?.getAttribute?.("hx-trigger") || "").includes("load delay")) Q.pollY = scrollY;   // the drafting email's own poll
  });
  D.addEventListener("htmx:afterRequest", (e) => { if (e.detail.elt?.closest?.("#qlist .wb-row")) { e.detail.elt.removeAttribute("aria-busy"); Q.rowReq = null; } });
  D.addEventListener("htmx:afterSwap", (e) => {
    const tg = e.detail.target;
    if (e.target !== tg) return;   // htmx fires it on the source element too
    if (tg?.id === "queuepane") initQueue();
    else if (tg?.id === "qlist") { tg.dataset.page = String(+(tg.dataset.page || 1) + 1); markDraftKept(); fillSummaries(); }
    else if (tg?.id === "workpane") {
      const poll = (e.detail.elt?.getAttribute?.("hx-trigger") || "").includes("load delay");
      afterWork(!poll);
      if (poll && Q.pollY != null) scrollTo(0, Q.pollY);
    }
  });
  // After an email renders in the work area: one-pane view, text areas sized, local draft restored.
  function afterWork(fresh) {
    if (!$("#workpane > .ax-void")) D.body.classList.add("ax-detail");
    if (fresh && ONEPANE.matches) scrollTo(0, 0);
    growAll();
    draftRender();
    emailInit();
  }
  // The void work area (no email open); on one pane the list comes back.
  function showVoid(push) {
    const wp = $("#workpane"), tp = D.getElementById("ax-void");
    if (!wp || !tp) return;
    wp.replaceChildren(tp.content.cloneNode(true));
    D.body.classList.remove("ax-detail");
    if (push && currentId()) history.pushState({ htmx: true }, "", Q.listUrl || listUrl());
  }
  // Back (one pane): in place, never history.back(); the list comes back where it was and refreshes.
  function back() {
    flush(true);
    draftFlush();
    if (Q.rowReq && W.htmx) { W.htmx.trigger(Q.rowReq, "htmx:abort"); Q.rowReq = null; }
    showVoid(false);
    scrollTo(0, Q.listY || 0);
    history.pushState({ htmx: true }, "", Q.listUrl || listUrl());
    markDraftKept();
    queueReturn();
  }

  // Sync now: posts the existing route in place, then the queue refreshes (the open email stays).
  function syncNow() {
    fetch(B + "/sync", { method: "POST", redirect: "manual", credentials: "same-origin" })
      .then((r) => {
        if (r.type !== "opaqueredirect" && !r.ok) throw new Error(String(r.status));
        toast(t("sync_started"));
        setRunning(true);
        refreshQueue();
      })
      .catch(() => banner(qp(), { tone: "bad", message: t("post_failed") }));
  }

  /* ---------- 6. Compose ---------- */
  // The drawer (#compose, rendered by routes/inbox.js composeUi): the customer is resolved with the
  // existing read-only call (Enter or leaving the field); the address comes only from the resolver.
  // Files are staged as base64 hidden fields (limits checked here and again on the server).
  const C = { staged: [], resolved: "" };
  const cmp = () => D.getElementById("compose");
  const cf = (n) => $(`#composeForm [name="${n}"]`);
  function cmpMsg(key, text) {
    const m = $(`#compose [data-msg="${key}"]`);
    if (!m) return;
    m.textContent = text || "";
    m.hidden = !text;
  }
  function cmpPick(card, addr) { cf("pick_card").value = card || ""; cf("pick_addr").value = addr || ""; if (addr) cmpMsg("who", ""); }
  function cmpReset() {
    const el = cmp();
    $("#composeForm", el).reset();
    ["who", "pick_card", "pick_addr"].forEach((n) => { cf(n).value = ""; });
    D.getElementById("cmp-res").replaceChildren();
    $("[data-cmp-clear]", el).hidden = true;
    C.staged = [];
    C.resolved = "";
    cmpAtts();
    el.classList.remove("is-write");
    $$("[data-msg]", el).forEach((m) => { m.hidden = true; });
    clearBanner(el);
  }
  // The address choices as pill buttons; one address is picked at once.
  function addrPills(card, addrs) {
    const [box] = nodes('<div class="ax-cmp-to"></div>');
    addrs.forEach((a) => {
      const [b] = nodes(`<button type="button" class="wb-pillbtn" aria-pressed="false">${icon("mail")}<span></span></button>`);
      b.lastElementChild.textContent = a;
      b.addEventListener("click", () => { $$(".wb-pillbtn", box).forEach((x) => x.setAttribute("aria-pressed", String(x === b))); cmpPick(card, a); });
      box.append(b);
    });
    if (addrs.length === 1) { box.firstElementChild.setAttribute("aria-pressed", "true"); cmpPick(card, addrs[0]); }
    return box;
  }
  const note = (tone, text) => { const [n] = nodes(`<p class="ax-note" data-tone="${tone}">${icon("alert")}<span></span></p>`); n.lastElementChild.textContent = text; return n; };
  const hint = (text) => { const [n] = nodes('<p class="wb-hint"></p>'); n.textContent = text; return n; };
  const msg = (text) => { const [n] = nodes('<p class="wb-msg"></p>'); n.textContent = text; return n; };
  function cmpShow(d) {
    const res = D.getElementById("cmp-res"), who = D.getElementById("cmp-who");
    res.replaceChildren();
    who.setAttribute("aria-expanded", "false");
    if (d.error) return res.append(msg(d.error));
    if (d.resolved && d.customer) {
      const c = d.customer;
      who.value = [c.name || c.contactName, c.cardCode].filter(Boolean).join(" · ");
      C.resolved = who.value;
      if (c.addresses.length > 1) res.append(hint(t("compose_pick_address")));
      res.append(addrPills(c.cardCode, c.addresses));
      if (!c.knownAccount) res.append(note("warn", t("compose_guest")));
      if (c.frozen) res.append(note("warn", t("compose_frozen")));
      return;
    }
    if (d.candidates?.length) {
      res.append(hint(d.message || t("compose_pick_customer")));
      const [list] = nodes('<div class="wb-list ax-cmp-list" role="listbox"></div>');
      d.candidates.forEach((c) => {
        const [b] = nodes(`<button type="button" class="wb-row" role="option" aria-selected="false"><span class="wb-row__title"></span>${c.frozen ? `<span class="wb-pill" data-tone="bad">${esc(t("compose_frozen_pill"))}</span>` : ""}<span class="wb-row__sum"></span></button>`);
        $(".wb-row__title", b).textContent = [c.name || "-", c.cardCode, c.country].filter(Boolean).join(" · ");
        $(".wb-row__sum", b).textContent = [c.contactName !== c.name && c.contactName, c.email, c.reason].filter(Boolean).join(" · ");
        b.addEventListener("click", () => {
          $$(".wb-row", list).forEach((x) => x.setAttribute("aria-selected", String(x === b)));
          $(".ax-cmp-to", res)?.remove();
          cmpPick(c.cardCode, "");
          list.after(addrPills(c.cardCode, c.addresses || []));
        });
        list.append(b);
      });
      res.append(list);
      who.setAttribute("aria-expanded", "true");
      return;
    }
    res.append(msg(d.message || t("compose_not_found")));
  }
  function cmpResolve() {
    const who = D.getElementById("cmp-who"), q = who.value.trim();
    if (!q || q === C.resolved || q === cf("who").value) return;
    cmpPick("", "");
    cf("who").value = q;
    const ad = $("#compose [data-cmp-adorn]");
    ad.innerHTML = `<span class="wb-spin" aria-hidden="true"></span><span class="wb-sr">${esc(t("compose_finding"))}</span>`;
    fetch(B + "/compose/resolve", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "who=" + encodeURIComponent(q), credentials: "same-origin" })
      .then((r) => r.json())
      .then((d) => { if (cf("who").value === q) cmpShow(d); })
      .catch(() => cmpShow({ error: t("post_failed") }))
      .finally(() => { ad.innerHTML = icon("search"); });
  }
  function cmpAtts() {
    const box = D.getElementById("cmp-atts");
    box.replaceChildren(...C.staged.map((f, i) => {
      const [chip] = nodes(`<span class="wb-pill" data-tone="neutral">${icon("clip")}<span></span><button type="button" class="wb-clear" aria-label="${esc(t("remove"))}" title="${esc(t("remove"))}">${icon("x")}</button></span>`);
      chip.children[1].textContent = `${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)`;
      chip.lastElementChild.addEventListener("click", () => { C.staged.splice(i, 1); cmpAtts(); });
      return chip;
    }));
  }
  // Files, shared by the compose drawer and the reply: a file's content as base64, and the images a
  // paste carries as files named snippet-<stamp>[-n].<ext> (null when it is a text paste).
  const readB64 = (f) => new Promise((ok, no) => { const rd = new FileReader(); rd.onload = () => ok(String(rd.result).split(",")[1] || ""); rd.onerror = no; rd.readAsDataURL(f); });
  function snippets(e) {
    const imgs = [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file" && /^image\//i.test(i.type)).map((i) => i.getAsFile()).filter(Boolean);
    if (!imgs.length || ((e.target.matches?.("input, textarea") || e.target.isContentEditable) && e.clipboardData.getData("text/plain"))) return null;
    const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
    return imgs.map((f, i) => new File([f], `snippet-${stamp}${imgs.length > 1 ? "-" + (i + 1) : ""}.${(/image\/(png|jpe?g|gif|webp)/i.exec(f.type) || [, "png"])[1].replace("jpeg", "jpg")}`, { type: f.type || "image/png" }));
  }
  function cmpAdd(files) {
    const el = cmp(), max = +el.dataset.max, maxTotal = +el.dataset.maxTotal;
    cmpMsg("att", "");
    [...files].forEach((f) => {
      if (f.size > max) return cmpMsg("att", t("file_too_big"));
      if (C.staged.reduce((s, x) => s + x.size, 0) + f.size > maxTotal) return cmpMsg("att", t("attach_total"));
      const entry = { name: f.name, ctype: f.type || "application/octet-stream", b64: "", size: f.size };
      C.staged.push(entry);
      readB64(f).then((b) => { entry.b64 = b; });
    });
    cmpAtts();
  }
  function cmpSubmit(e) {
    e.preventDefault();
    const form = e.target, btn = e.submitter, mode = btn?.value || "draft";
    cmpResolve();
    const need = [];
    if (!cf("instruction").value.trim()) need.push(["instruction", t("compose_need_instr")]);
    if (!cf("pick_addr").value) need.push(["who", t("compose_need_pick")]);
    if (mode === "send" && !cf("subject").value.trim()) need.push(["subject", t("compose_need_subject")]);
    ["instruction", "who", "subject"].forEach((k) => cmpMsg(k, (need.find((n) => n[0] === k) || [])[1]));
    if (need.length) return ({ instruction: cf("instruction"), who: D.getElementById("cmp-who"), subject: cf("subject") })[need[0][0]]?.focus();
    const hid = $("#cmp-hidden", form) || form.appendChild(nodes('<div id="cmp-hidden" hidden></div>')[0]);
    hid.replaceChildren(...C.staged.filter((f) => f.b64).flatMap((f) => [["att_name", f.name], ["att_ctype", f.ctype], ["att_data", f.b64]]
      .map(([n, v]) => Object.assign(D.createElement("input"), { type: "hidden", name: n, value: v }))));
    post(form, btn).then((r) => {
      if (!r.ok) return;
      layerOf(form)?.close();
      cmpReset();
      refreshQueue({ sel: currentId() || 0 });
    });
  }
  function wireCompose() {
    const el = cmp();
    if (!el || el.dataset.wired) return;
    el.dataset.wired = "1";
    const who = D.getElementById("cmp-who");
    who.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); cmpResolve(); } });
    who.addEventListener("change", cmpResolve);
    who.addEventListener("input", () => {
      $("[data-cmp-clear]", el).hidden = !who.value;
      if (who.value !== C.resolved) { C.resolved = ""; cf("who").value = ""; cmpPick("", ""); D.getElementById("cmp-res").replaceChildren(); }
    });
    $("[data-cmp-clear]", el).addEventListener("click", () => { who.value = ""; who.dispatchEvent(new Event("input")); who.focus(); });
    $("[data-cmp-attach]", el).addEventListener("click", () => D.getElementById("cmp-file").click());
    D.getElementById("cmp-file").addEventListener("change", (e) => { cmpAdd(e.target.files); e.target.value = ""; });
    $$("[data-cmp-write]", el).forEach((b) => b.addEventListener("click", () => el.classList.toggle("is-write")));
    $("#composeForm", el).addEventListener("submit", cmpSubmit);
    const drop = $("[data-cmp-drop]", el);
    el.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("is-drop"); });
    el.addEventListener("dragleave", (e) => { if (!el.contains(e.relatedTarget)) drop.classList.remove("is-drop"); });
    el.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("is-drop"); cmpAdd(e.dataTransfer.files); });
    // A screenshot on the clipboard is staged with one Ctrl+V anywhere in the drawer; a paste that
    // carries text into a field stays a text paste.
    el.addEventListener("paste", (e) => {
      const files = snippets(e);
      if (!files) return;
      e.preventDefault();
      cmpAdd(files);
    });
  }

  /* ---------- 7. Phone draft protection, text areas, htmx failures, busy buttons ---------- */
  // Phone only: the reply, the redraft text and the subject of the open email are kept in
  // localStorage (axle.draft.<id>, 600 ms after typing, pruned after 14 days). Reopening restores
  // them silently when the server text is unchanged ("Unsaved edits restored"), or offers Restore
  // and Discard when it changed meanwhile; list rows show "Draft kept". A save the server confirmed
  // clears it (draftSaved); a save that failed or never left leaves it in place.
  const PRE = "axle.draft.", PEND = "axle.pending.", MAXAGE = 14 * 864e5;
  const FNAMES = ["reply", "feedback", "cf_subject", "return_subject", "compose_subject"];
  const workForm = () => $("#workpane form#workform, #workpane form[data-autosave]");
  const nz = (v) => (v == null ? null : String(v).split("\r").join("").trim());
  let dr = null;   // { id, base, timer } for the email on screen
  function dFields() {
    const f = workForm();
    if (!f) return {};
    return Object.fromEntries(FNAMES.map((n) => [n, f.elements.namedItem(n)]).filter(([, el]) => el && el.tagName));
  }
  const dVals = (F, def) => Object.fromEntries(Object.entries(F).map(([k, el]) => [k, def ? el.defaultValue : el.value]));
  const dSame = (a, b) => !!a && !!b && FNAMES.every((k) => nz(a[k]) === nz(b[k]));
  const dropDraft = (id) => { store("localStorage", (s) => s.removeItem(PRE + id)); markDraftKept(); };
  function draftWrite() {
    if (!dr) return;
    clearTimeout(dr.timer);
    dr.timer = 0;
    if (!phone()) return;
    const F = dFields();
    if (!F.reply) return;
    const v = dVals(F);
    if (dSame(v, dr.base)) return dropDraft(dr.id);
    store("localStorage", (s) => s.setItem(PRE + dr.id, JSON.stringify({ ...v, base: dr.base, t: Date.now() })));
  }
  function draftFlush() { if (dr?.timer) draftWrite(); }
  // A save the server confirmed (snap: the email and the text it carried): the server holds that
  // text now, so it is the new base, and the local copy goes when it holds nothing more.
  function draftSaved(snap) {
    if (dr?.id === snap.id) {
      dr.base = snap.v;
      if (dSame(dVals(dFields()), snap.v)) { clearTimeout(dr.timer); dr.timer = 0; return dropDraft(snap.id); }
    }
    let d = null;
    try { d = JSON.parse(store("localStorage", (s) => s.getItem(PRE + snap.id)) || "null"); } catch (e) { d = null; }
    if (dSame(d, snap.v)) dropDraft(snap.id);
  }
  function draftRender() {
    dr = null;
    $$("[data-ax-restore]").forEach((n) => n.remove());
    if (!phone()) return;
    const f = workForm(), id = f && itemIdOf(new URL(f.getAttribute("action"), location.href).pathname), F = dFields();
    if (id) {
      const p = store("sessionStorage", (s) => s.getItem(PEND + id));
      if (p != null) {
        if (!F.reply || nz(F.reply.defaultValue) === nz(p)) dropDraft(id);
        store("sessionStorage", (s) => s.removeItem(PEND + id));
      }
    }
    if (!id || !F.reply) return;
    dr = { id, base: dVals(F, true), timer: 0 };
    let d = null;
    try { d = JSON.parse(store("localStorage", (s) => s.getItem(PRE + id)) || "null"); } catch (e) { d = null; }
    if (!d) return;
    if (dSame(d, dr.base)) return dropDraft(id);
    const put = () => { Object.entries(F).forEach(([k, el]) => { if (d[k] != null) el.value = d[k]; }); replyEd()?.setText(F.reply.value); growAll(); };
    const host = F.reply.closest(".ax-reply, .box, .wb-card") || F.reply.parentElement;
    let n;
    if (dSame(d.base, dr.base)) {
      put();
      [n] = nodes(`<div class="wb-banner" data-tone="info" role="status" data-ax-restore>${icon("info")}<div class="wb-banner__body"></div><button type="button" class="wb-btn wb-btn--sm wb-btn--icon" aria-label="${esc(t("close"))}">${icon("x")}</button></div>`);
      n.children[1].textContent = t("restored");
      n.lastElementChild.addEventListener("click", () => n.remove());
    } else {
      const dt = new Date(d.t || 0);
      [n] = nodes(`<div class="wb-banner" data-tone="warn" role="status" data-ax-restore>${icon("alert")}<div class="wb-banner__body"></div><button type="button" class="wb-btn wb-btn--sm">${esc(t("restore"))}</button><button type="button" class="wb-btn wb-btn--sm">${esc(t("discard"))}</button></div>`);
      n.children[1].textContent = t("restore_offer", { t: ("0" + dt.getHours()).slice(-2) + ":" + ("0" + dt.getMinutes()).slice(-2) });
      const [restore, discard] = $$(".wb-btn", n);
      restore.addEventListener("click", () => { put(); dr.base = dVals(F, true); draftWrite(); n.remove(); });
      discard.addEventListener("click", () => { dropDraft(id); n.remove(); });
    }
    host.prepend(n);
  }
  function markDraftKept() {
    $$("#qlist .wb-row").forEach((r) => {
      const has = phone() && !!store("localStorage", (s) => s.getItem(PRE + r.dataset.id) != null);
      const ex = $("[data-ax-kept]", r);
      if (has && !ex) {
        let end = $(".wb-row__end", r);
        if (!end) { [end] = nodes('<span class="wb-row__end"></span>'); r.append(end); }
        end.append(...nodes(`<span class="wb-pill" data-tone="info" data-ax-kept>${esc(t("draft_kept"))}</span>`));
      } else if (!has && ex) ex.remove();
    });
  }
  (function prune() {
    store("localStorage", (s) => {
      const now = Date.now(), dead = [];
      for (let i = 0; i < s.length; i++) {
        const k = s.key(i);
        if (!k?.startsWith(PRE)) continue;
        let d = null;
        try { d = JSON.parse(s.getItem(k)); } catch (e) { d = null; }
        if (!d?.t || now - d.t > MAXAGE) dead.push(k);
      }
      dead.forEach((k) => s.removeItem(k));
    });
  })();
  D.addEventListener("input", (e) => {
    if (e.target.matches?.(".wb-input--area > textarea, textarea.ans")) grow(e.target);
    if (!dr || !phone() || !FNAMES.includes(e.target.name) || e.target.form !== workForm()) return;
    clearTimeout(dr.timer);
    dr.timer = setTimeout(draftWrite, 600);
  });
  // A plain (not in-place) submit of the work form marks the draft for clearing when it lands.
  D.addEventListener("submit", (e) => {
    const f = e.target;
    setTimeout(() => {
      if (e.defaultPrevented) return;
      if (e.submitter) busyBtn(e.submitter, true);
      if (dr && phone() && f === workForm()) { draftWrite(); const r = dFields().reply; if (r) store("sessionStorage", (s) => s.setItem(PEND + dr.id, r.value)); }
    }, 0);
  });
  W.addEventListener("pagehide", draftFlush);
  D.addEventListener("visibilitychange", () => { if (D.hidden) draftFlush(); });
  W.addEventListener("pageshow", () => $$("button[aria-busy]").forEach((b) => busyBtn(b, false)));
  PHONE.addEventListener("change", () => { markDraftKept(); draftRender(); });

  // Text areas grow with their text (three lines minimum, no inner scrollbar).
  function grow(el) { if (!el.offsetParent) return; el.style.height = "auto"; el.style.height = el.scrollHeight + 2 + "px"; }
  function growAll() { $$(".wb-input--area > textarea, textarea.ans").forEach(grow); }
  W.addEventListener("resize", growAll);

  // A failed request into the work area: the server's own error pane when it sent one, else a bad
  // banner that says nothing changed, with Retry for a GET. Background requests fail silently.
  ["htmx:responseError", "htmx:sendError", "htmx:timeout"].forEach((ev) => D.addEventListener(ev, (e) => {
    const wp = $("#workpane"), tg = e.detail.target;
    if (!wp || !tg || (tg !== wp && !wp.contains(tg))) return;
    const xhr = e.detail.xhr;
    const doc = ev === "htmx:responseError" && xhr?.responseText ? new DOMParser().parseFromString(xhr.responseText, "text/html") : null;
    if (doc?.querySelector("[data-ax-pane]") && !doc.querySelector(".errbox")) {
      W.htmx.swap(wp, xhr.responseText, { swapStyle: "innerHTML" });   // Axle's own pane (not found)
    } else {
      // The route error pane of server.js (or no answer at all): one banner, the message behind Details.
      const back = `<a class="wb-btn wb-btn--ghost wb-btn--icon" href="${B}/" data-back aria-label="${esc(t("inbox"))}">${icon("back")}</a>`;
      wp.innerHTML = `<div class="ax-email" data-ax-pane><header class="wb-page__hd ax-ptop">${back}<h1 class="wb-page__t"></h1></header><div class="ax-col"><a class="wb-link ax-back" href="${B}/" data-back>${icon("back")}${esc(t("inbox"))}</a><div data-ax-banner></div></div></div>`;
      const path = e.detail.pathInfo?.finalRequestPath || e.detail.pathInfo?.requestPath;
      const get = e.detail.requestConfig?.verb === "get";
      const why = [...(doc?.querySelectorAll(".errbox p") || [])].pop()?.textContent.trim();
      banner(wp, {
        tone: "bad", message: t("load_failed_title"), unchanged: true, more: [why, xhr?.status ? "HTTP " + xhr.status : ""].filter(Boolean).join("\n"),
        action: get && path ? { label: t("retry"), icon: "refresh", run: () => W.htmx.ajax("GET", path, { target: wp, swap: "innerHTML" }) } : null,
      });
    }
    D.body.classList.add("ax-detail");
  }));

  /* ---------- 8. The email ---------- */
  // The open email is .ax-email[data-email] in the work area (routes/item.js). Its buttons carry
  // data attributes; the posts go through post() above. Nothing here writes outside the routes the
  // old page used, with the same fields.
  const emailEl = () => $("#workpane .ax-email[data-email]");
  const itemUrl = (id, p) => `${B}/item/${id}${p || ""}`;
  const replyBox = () => D.getElementById("replybox");
  // The reply editor (assets/axle-editor.js) over the hidden reply field. The field holds the stored
  // text (markers and all) that every reader uses: autosave, the phone's draft, Reset to draft,
  // Translate, Send; the editor writes it on every input and fires the field's input event. Whatever
  // sets or inserts reply text goes through here: setReply (Reset to draft), replyEd().setText (a
  // restored or carried edit), replyEd().insert (an [image:N] token at the caret).
  const replyEd = () => { const el = D.getElementById("replyed"), f = replyBox(); return el && f && W.AxleEditor ? W.AxleEditor.mount(el, f) : null; };
  function setReply(text) {
    const f = replyBox();
    f.value = text;
    replyEd()?.setText(text);
    f.dispatchEvent(new Event("input", { bubbles: true }));   // autosave, the draft protection, Reset's visibility
  }
  // The email again from the server, swapped in place (scroll, focus and typed text kept).
  async function reloadEmail() {
    const id = emailEl()?.dataset.email;
    if (!id) return;
    await flush();   // a pending save lands first, so no timer outlives the form it belongs to
    return fetch(itemUrl(id), { headers: { "HX-Request": "true" }, credentials: "same-origin" })
      .then((r) => (r.ok ? r.text() : Promise.reject(r.status)))
      .then((html) => { if (emailEl()?.dataset.email === id) swapInto($("#workpane"), html, itemUrl(id)); })
      .catch(() => banner(emailEl() || $("#workpane"), { tone: "bad", message: t("post_failed") }));
  }

  // After every render of an email: the reply editor, the Cc row the user opened, the phone clamp,
  // Reset to draft, the background translations.
  function emailInit() {
    const em = emailEl();
    if (!em) return;
    replyEd();
    if (ccOpened.has(em.dataset.email)) ccShow(false);
    foldCheck();
    dockFold();
    resetVisible();
    const id = em.dataset.email, pend = $("[data-tr-pending]", em), qs = $$("[data-trq]", em);
    if (!pend && !qs.length) return;
    // Uncached translations (the email and the questions) are fetched once and filled in as text;
    // the server caches them, so the next view renders them inline with no fetch at all.
    fetch(itemUrl(id, "/translations"), { method: "POST", credentials: "same-origin" })
      .then((r) => r.json())
      .then((d) => {
        if (pend) {
          if (d.email) { pend.replaceChildren(...nodes(d.email.split(/\n[ \t\r]*\n/).filter((x) => x.trim()).map((x) => `<p>${esc(x)}</p>`).join(""))); pend.removeAttribute("data-tr-pending"); }
          else $$("[data-tr-email], [data-tr-box]", em).forEach((n) => { n.hidden = true; });   // unavailable: no toggle
        }
        qs.forEach((el) => { const v = d.questions?.[el.dataset.trq]; if (v) el.textContent = v; });
      })
      .catch(() => { /* the original text stays */ });
  }
  // Phone: the newest message is clamped; "Show full message" only when the clamp hides text.
  function foldCheck() {
    $$("#workpane [data-more-toggle]").forEach((b) => {
      const m = b.previousElementSibling;
      if (m.classList.contains("is-open")) return;
      b.hidden = !phone() || m.scrollHeight <= m.clientHeight + 1;
      m.classList.toggle("is-clamped", !b.hidden);
    });
  }
  PHONE.addEventListener("change", foldCheck);
  // The dock rule (Vocabulary.md): when the slots do not fit, the lowest-priority slot folds into
  // More, one at a time, and shows there as its row. Slots that may fold carry data-fold (1 folds
  // first), their rows in m-more data-fold-row; More shows when it holds a row. Measured, never
  // scrolled; the phone has its own bar (the dock is not drawn there).
  function dockFold() {
    const dock = $("#workpane .ax-email .wb-dock"), tpl = D.getElementById("m-more");
    if (!dock || !tpl) return;
    const more = $('[data-menu="more"]', dock), rows = tpl.content;
    const slots = $$("[data-fold]", dock).sort((a, b) => a.dataset.fold - b.dataset.fold);
    const fixed = !!$(".wb-menu__item:not([data-fold-row])", rows);
    const fold = (n) => {
      slots.forEach((s, k) => { s.hidden = k < n; $(`[data-fold-row="${s.dataset.fold}"]`, rows).hidden = k >= n; });
      const sep = $("[data-fold-sep]", rows);
      if (sep) sep.hidden = !n;
      if (more) more.hidden = !n && !fixed;
    };
    let n = 0;
    fold(0);
    if (dock.offsetParent) while (n < slots.length && dock.scrollWidth > dock.clientWidth + 1) fold(++n);
  }
  // Reset to draft shows only while the text differs from Axle's draft.
  function resetVisible() {
    const b = $("#workpane [data-reset]"), seed = D.getElementById("ai_seed"), r = replyBox();
    if (b && seed && r) b.hidden = nz(r.value) === nz(seed.value);
  }
  // The To and Cc lines (kind "to" or "cc"): "Other address..." swaps the line's pills for an email
  // field and Use address; Cancel (or Esc) puts them back.
  function toOther(on, kind) {
    const em = emailEl();
    if (!em) return;
    $$(`[data-${kind}-pill]`, em).forEach((n) => { n.hidden = on; });
    $$(`[data-${kind}-other-field]`, em).forEach((n) => { n.hidden = !on; });
    // The field and Use come fully into view (on a phone above the sticky bar: the row's scroll
    // margin, axle.css), then take the focus.
    if (on) {
      const f = $(`[data-${kind}-other-field] input`, em), row = f.closest(".ax-to");
      if (row.getBoundingClientRect().bottom + parseFloat(getComputedStyle(row).scrollMarginBottom) > innerHeight) row.scrollIntoView({ block: "end" });
      f.focus({ preventScroll: true });
    }
  }
  // The Cc row: drawn hidden while the Cc is empty; Add Cc opens it, and it stays open for that email
  // through the redraws an add or a remove brings (otherwise it goes when the last address does).
  const ccOpened = new Set();
  function ccShow(focus) {
    const row = D.getElementById("ax-ccrow"), b = $("#workpane [data-cc-open]");
    if (!row) return;
    row.hidden = false;
    if (b) { b.hidden = true; b.setAttribute("aria-expanded", "true"); }
    if (focus) $('[data-menu="cc"]', row).focus();
  }

  // Files: the Attach button's picker, the camera, a drop on the reply card and a pasted screenshot
  // go through the existing POST /item/:id/attach-add, one call per file, carrying the reply and the
  // redraft note as before (the route saves them first). Pasted into the reply, an image also gets
  // its [image:N] token at the caret, and the token-edited reply is saved by one more call without a
  // file. A camera photo, and any picked image over the per-file limit, is first scaled down here
  // (shrink). Each file shows as a busy chip until it landed. Then the email renders again in place;
  // a refusal (the per-file or the total limit) is a banner, nothing else changes.
  const textFields = (form) => { const d = new URLSearchParams(); for (const el of form.elements) if (el.name && isText(el) && !el.disabled) d.append(el.name, el.value); return d; };
  // A photo scaled for the reply: long edge at most 1600 px, JPEG at quality 0.8. createImageBitmap
  // with imageOrientation "from-image" turns it upright by its EXIF orientation; where that is not
  // supported, an img element is drawn instead, which current engines also turn upright by default
  // (CSS image-orientation: from-image). Throws when the browser cannot read the image.
  async function shrink(f, name) {
    let src;
    try { src = await createImageBitmap(f, { imageOrientation: "from-image" }); }
    catch (e) {
      const u = URL.createObjectURL(f);
      try { src = await new Promise((ok, no) => { const im = new Image(); im.onload = () => ok(im); im.onerror = no; im.src = u; }); }
      finally { URL.revokeObjectURL(u); }
    }
    const w = src.naturalWidth || src.width, h = src.naturalHeight || src.height, k = Math.min(1, 1600 / Math.max(w, h));
    const c = Object.assign(D.createElement("canvas"), { width: Math.round(w * k), height: Math.round(h * k) });
    c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
    src.close?.();
    const blob = await new Promise((ok, no) => c.toBlob((b) => (b ? ok(b) : no(new Error("encode"))), "image/jpeg", 0.8));
    return new File([blob], name, { type: "image/jpeg" });
  }
  const photoName = () => "photo-" + new Date().toTimeString().slice(0, 8).replace(/:/g, "") + ".jpg";
  async function addFiles(files, token, camera) {
    const em = emailEl(), form = D.getElementById("workform"), card = $(".ax-reply[data-max]", em || D);
    if (!em || !form || !card || !files.length) return;
    const id = em.dataset.email, btn = $(camera ? "[data-camera]" : "[data-attach]", card), row = $(".ax-atts", card), say = (m) => banner(form, { tone: "bad", message: m, unchanged: true });
    clearBanner(form);
    await flush();
    busyBtn(btn, true);
    const wasHidden = row.hidden;
    row.hidden = false;
    let added = false, tokens = false;
    for (let f of files) {
      const [chip] = nodes('<span class="wb-pill ax-chip" data-tone="neutral" aria-busy="true"><span class="wb-spin" aria-hidden="true"></span><span></span></span>');
      chip.lastElementChild.textContent = camera ? photoName() : f.name;
      row.append(chip);
      try {
        if (camera || (f.size > +card.dataset.max && /^image\//i.test(f.type || ""))) {
          try { f = await shrink(f, camera ? chip.lastElementChild.textContent : f.name.replace(/\.[^.]*$/, "") + ".jpg"); } catch (e) { /* not an image this browser reads: sent as it is */ }
        }
        if (f.size > +card.dataset.max) { say(t("file_too_big")); continue; }
        const p = textFields(form);
        p.set("name", f.name); p.set("ctype", f.type || "application/octet-stream"); p.set("data", await readB64(f));
        const d = await (await fetch(itemUrl(id, "/attach-add"), { method: "POST", body: p, credentials: "same-origin" })).json();
        if (d.error) { say(d.error); continue; }
        added = true;
        if (token && d.id && /^image\//i.test(f.type || "")) { replyEd()?.insert(`[image:${d.id}]`); tokens = true; }
      } catch (e) { say(t("attach_failed")); }
      finally { chip.remove(); }
    }
    if (tokens) await fetch(itemUrl(id, "/attach-add"), { method: "POST", body: textFields(form), credentials: "same-origin" }).catch(() => {});
    busyBtn(btn, false);
    if (added) { dropDraft(id); reloadEmail(); }
    else row.hidden = wasHidden;
  }
  D.addEventListener("paste", (e) => {
    if (!replyBox() || stack.length) return;   // no editable email, or an overlay (compose has its own) has the paste
    const files = snippets(e);
    if (!files) return;
    e.preventDefault();
    addFiles(files, !!e.target.closest?.("#replyed"));
  });
  D.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    e.preventDefault();   // a file dropped anywhere never navigates away
    const card = e.target.closest?.("#workpane .ax-reply[data-max]");
    $$("#workpane .ax-reply.is-drop").forEach((c) => { if (c !== card) c.classList.remove("is-drop"); });
    card?.classList.add("is-drop");
  });
  D.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.types?.includes("Files")) return;
    const card = e.target.closest?.("#workpane .ax-reply[data-max]");
    $$("#workpane .ax-reply.is-drop").forEach((c) => c.classList.remove("is-drop"));
    if (e.target.closest?.(".ax-ov")) return;   // the compose drawer takes its own drops
    e.preventDefault();
    if (card) addFiles([...e.dataTransfer.files]);
  });
  D.addEventListener("change", (e) => {
    if (e.target.id !== "att_file" && e.target.id !== "att_cam") return;
    addFiles([...e.target.files], false, e.target.id === "att_cam");
    e.target.value = "";
  });

  // The photo viewer: every photo of the conversation that loaded, in the order the email shows
  // them (the newest message first, then the earlier ones). An overlay on a dim backdrop from 640 up,
  // full screen on a phone (axle.css): the photo fitted to the window, previous and next (buttons,
  // arrow keys, a swipe on a phone when not zoomed in), "2 of 5", the file name with the sender and
  // time of its message, Open original and Close. A layer of the overlay stack: Esc closes it, focus
  // stays inside and goes back to the thumbnail. The browser's own pinch zoom is never blocked.
  function viewer(start) {
    const list = $$("#workpane .ax-thumb:not([data-failed]) [data-photo]");
    let at = Math.max(0, list.indexOf(start));
    const [el] = nodes(`<div class="ax-viewer" role="dialog" aria-modal="true" aria-label="${esc(t("viewer_title"))}" tabindex="-1">
      <div class="ax-viewer__hd"><span class="ax-viewer__n" aria-live="polite"></span><span class="ax-viewer__name"><b></b><span></span></span>
        <a class="wb-btn wb-btn--sm ax-viewer__open" target="_blank" rel="noopener">${esc(t("viewer_open"))}</a>
        <button type="button" class="wb-btn wb-btn--icon ax-viewer__x" aria-label="${esc(t("close"))}" title="${esc(t("close"))}">${icon("x")}</button></div>
      <div class="ax-viewer__stage"><img alt=""></div>
      <button type="button" class="wb-btn wb-btn--icon ax-viewer__go" data-go="-1" aria-label="${esc(t("viewer_prev"))}" title="${esc(t("viewer_prev"))}">${icon("back")}</button>
      <button type="button" class="wb-btn wb-btn--icon ax-viewer__go" data-go="1" aria-label="${esc(t("viewer_next"))}" title="${esc(t("viewer_next"))}">${icon("chevron-right")}</button></div>`);
    const img = $("img", el), more = list.length > 1;
    const show = (n) => {
      at = (n + list.length) % list.length;
      const b = list[at];
      img.src = b.dataset.photo;
      img.alt = b.dataset.name;
      $(".ax-viewer__n", el).textContent = t("viewer_count", { i: at + 1, n: list.length });
      $(".ax-viewer__name b", el).textContent = b.dataset.name;
      $(".ax-viewer__name span", el).textContent = b.dataset.meta;
      $(".ax-viewer__open", el).href = b.dataset.photo;
    };
    $$("[data-go]", el).forEach((b) => { b.hidden = !more; b.addEventListener("click", () => show(at + +b.dataset.go)); });
    el.addEventListener("keydown", (e) => {
      if (more && (e.key === "ArrowLeft" || e.key === "ArrowRight")) { e.preventDefault(); show(at + (e.key === "ArrowRight" ? 1 : -1)); }
    });
    el.addEventListener("click", (e) => { if (e.target === el || e.target.matches(".ax-viewer__stage") || e.target.closest(".ax-viewer__x")) ly.close(); });
    let sw = null;
    el.addEventListener("touchstart", (e) => { sw = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null; }, { passive: true });
    el.addEventListener("touchend", (e) => {
      const p = e.changedTouches[0], zoomed = (W.visualViewport?.scale || 1) > 1.01;
      if (!sw || !more || zoomed || e.touches.length) return;
      const dx = p.clientX - sw.x, dy = p.clientY - sw.y;
      sw = null;
      if (Math.abs(dx) > 50 && Math.abs(dy) < Math.abs(dx) * 0.6) show(at + (dx < 0 ? 1 : -1));
    }, { passive: true });
    show(at);
    start.focus({ preventScroll: true });
    D.body.append(el);
    D.body.classList.add("ax-viewing");
    const ly = layer(el, () => { el.remove(); D.body.classList.remove("ax-viewing"); });
    el.focus({ preventScroll: true });
  }
  // A thumbnail's skeleton goes once its photo is in; a photo that fails shows "Could not load" with
  // Retry, which asks for it again (the server fetches a missing file from Graph on the way).
  D.addEventListener("load", (e) => { if (e.target.matches?.(".ax-thumb img")) e.target.previousElementSibling?.remove(); }, true);
  D.addEventListener("error", (e) => { if (e.target.matches?.(".ax-thumb img")) e.target.closest(".ax-thumb").toggleAttribute("data-failed", true); }, true);
  function retryPhoto(tile) {
    const img = $("img", tile), u = img.dataset.src || img.getAttribute("src");
    img.dataset.src = u;
    tile.removeAttribute("data-failed");
    img.src = u + (u.includes("?") ? "&" : "?") + "r=" + Date.now();
    $("[data-photo]", tile).focus({ preventScroll: true });
  }

  // A refused Send says what was refused and that nothing was sent; an offending link is named on
  // its own line. The reply stays exactly as typed.
  D.addEventListener("ax:refused", (e) => {
    const j = e.detail, f = e.target;
    if (j.html) return choices(e);
    if (f.id !== "workform" || (j.kind !== "refused" && j.kind !== "failed")) return;
    e.preventDefault();
    const m = /^(.*?):\s*(https?:\/\/\S.*)$/.exec(j.message || "");
    const why = String(m ? m[1] : j.message || "").replace(/\.?$/, ".");
    banner(f, { tone: "bad", message: `${t("not_sent")}: ${why} ${t("nothing_sent")}`, detail: m ? m[2] : "" });
  });
  // A document that needs a choice (several share the number, or it belongs to another customer):
  // the route's message and choices, inside the Other document dialog when it asked, else in a
  // small dialog of their own. Each choice posts /attach-doc in place like the old buttons.
  function choices(e) {
    e.preventDefault();
    const j = e.detail, ov = e.target.closest(".ax-ov");
    const fill = (host) => { host.replaceChildren(...nodes(`<p></p>${j.html}`)); host.firstElementChild.textContent = j.message; };
    const slot = ov && $("[data-ax-choices]", ov);
    if (slot) return fill(slot);
    const [el] = nodes(`<div class="ax-ov" data-kind="dialog" role="dialog" aria-modal="true" hidden><div class="ax-ov__hd"><h2 class="ax-ov__t"></h2><button type="button" class="wb-btn wb-btn--ghost wb-btn--icon ax-ov__x" data-close aria-label="${esc(t("close"))}">${icon("x")}</button></div><div class="ax-ov__bd"><div data-ax-banner></div><div></div></div><div class="ax-ov__ft"><button type="button" class="wb-btn" data-close>${esc(t("cancel"))}</button></div></div>`);
    $(".ax-ov__t", el).textContent = t(j.kind === "scope" ? "doc_other_cust" : "pick_doc");
    fill($(".ax-ov__bd", el).lastElementChild);
    const go = $("form .wb-btn--primary", el);   // Attach anyway sits in the footer, beside Cancel
    if (go) { go.form.id = "ax-choice-form"; go.setAttribute("form", "ax-choice-form"); $(".ax-ov__ft", el).append(go); }
    const tp = D.createElement("template");
    tp.content.append(el);
    openOverlay(tp);
  }

  // A dialog whose body the server renders (data-remote="url"): Block sender. The GET carries
  // X-Axle-Inline: the route answers with an .ax-ov element, shown as it is (its form posts in place
  // and the next email opens), or with a JSON refusal, shown as a banner on the email.
  function openRemote(trigger) {
    const [el] = nodes(`<div class="ax-ov" data-kind="dialog" role="dialog" aria-modal="true" hidden><div class="ax-ov__hd"><h2 class="ax-ov__t"></h2><button type="button" class="wb-btn wb-btn--ghost wb-btn--icon ax-ov__x" data-close aria-label="${esc(t("close"))}">${icon("x")}</button></div><div class="ax-ov__bd"><div data-ax-banner></div><div class="wb-skel-rows" aria-busy="true"><span class="wb-skel" style="width:70%"></span><span class="wb-skel" style="width:95%"></span><span class="wb-skel" style="width:60%"></span></div></div></div>`);
    $(".ax-ov__t", el).textContent = trigger.dataset.remoteTitle || "";
    const tp = D.createElement("template");
    tp.content.append(el);
    const ly = openOverlay(tp, trigger);
    fetch(trigger.dataset.remote, { headers: { "X-Axle-Inline": "1", "HX-Request": "true" }, credentials: "same-origin" })
      .then(async (r) => {
        if (!ly.el.isConnected) return;
        if ((r.headers.get("Content-Type") || "").includes("application/json")) {
          const j = await r.json();
          ly.close();
          return banner(emailEl() || D.getElementById("workpane"), { tone: "bad", message: j.message, unchanged: j.unchanged });
        }
        const own = new DOMParser().parseFromString(await r.text(), "text/html").querySelector(".ax-ov");
        if (!own) throw new Error("no dialog");
        ly.close();
        const tp2 = D.createElement("template");
        tp2.content.append(own);
        openOverlay(tp2, trigger);
      })
      .catch(() => { if (ly.el.isConnected) banner(ly.el, { tone: "bad", message: t("load_failed_title"), unchanged: true }); });
  }

  // The email's own clicks; true when one was handled.
  function emailClick(tg) {
    const em = tg.closest?.(".ax-email, .ax-ov, .wb-menu, .wb-sheet");
    if (!em) return false;
    const b = tg.closest("[data-tr-email], [data-tr-reply], [data-more-toggle], [data-reset], [data-insimg], [data-attach], [data-camera], [data-to-other], [data-to-cancel], [data-cc-open], [data-cc-other], [data-cc-cancel], [data-photo], [data-photo-retry], [data-remote]");
    if (!b) return false;
    // Translate, the same control on the customer's message and on the reply: the label swaps, the
    // translation shows in its box below the text.
    const trToggle = (box) => {
      const on = box.hidden;
      box.hidden = !on;
      b.textContent = on ? b.dataset.on : b.dataset.off;
      b.setAttribute("aria-expanded", String(on));
      return on;
    };
    if (b.matches("[data-tr-email]")) trToggle($("#workpane [data-tr-box]"));
    else if (b.matches("[data-tr-reply]")) {
      // The reply's words (the server strips the markers), fetched when switched on and again when
      // switched on after the text changed; the skeleton meanwhile.
      const box = D.getElementById("replytr"), out = box.lastElementChild, text = replyBox().value;
      box.axSkel ??= out.innerHTML;
      if (!trToggle(box) || box.dataset.text === text) return true;
      box.dataset.text = text;
      out.innerHTML = box.axSkel;
      fetch(itemUrl(emailEl().dataset.email, "/translate-reply"), { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "text=" + encodeURIComponent(text), credentials: "same-origin" })
        .then((r) => r.json())
        .then((d) => {
          if (box.dataset.text !== text) return;
          if (d.error) delete box.dataset.text;
          out.replaceChildren(...nodes(String(d.text || d.error || "").split(/\n[ \t\r]*\n/).filter((x) => x.trim()).map((x) => `<p>${esc(x)}</p>`).join("")));
        })
        .catch(() => { if (box.dataset.text === text) { delete box.dataset.text; out.textContent = t("post_failed"); } });
    } else if (b.matches("[data-more-toggle]")) {
      const m = b.previousElementSibling, on = m.classList.toggle("is-open");
      b.firstChild.textContent = on ? b.dataset.less : b.dataset.more;
      b.setAttribute("aria-expanded", String(on));
    } else if (b.matches("[data-reset]")) {
      setReply(D.getElementById("ai_seed").value);
    } else if (b.matches("[data-insimg]")) {
      replyEd()?.insert(`[image:${b.dataset.insimg}]`);
    } else if (b.matches("[data-attach], [data-camera]")) {
      D.getElementById(b.matches("[data-camera]") ? "att_cam" : "att_file").click();
    } else if (b.matches("[data-photo]")) {
      viewer(b);
    } else if (b.matches("[data-photo-retry]")) {
      retryPhoto(b.closest(".ax-thumb"));
    } else if (b.matches("[data-cc-open]")) {
      ccOpened.add(emailEl().dataset.email);
      ccShow(true);
    } else if (b.matches("[data-remote]")) {
      openRemote(b);
    } else toOther(b.matches("[data-to-other], [data-cc-other]"), b.matches("[data-cc-other], [data-cc-cancel]") ? "cc" : "to");
    return true;
  }
  D.addEventListener("input", (e) => { if (e.target.id === "replybox") resetVisible(); });
  D.addEventListener("keydown", (e) => {
    const el = e.target;
    // A typed address (To or Cc): Enter uses it (it never sends the email), Esc puts the pills back.
    const kind = el.matches?.("[data-to-other-field] input") ? "to" : el.matches?.("[data-cc-other-field] input") ? "cc" : "";
    if (kind) {
      if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); $(`#workpane button[form="${kind === "cc" ? "ax-f-cctyped" : "ax-f-typed"}"]`)?.click(); }
      else if (e.key === "Escape" && !stack.length) toOther(false, kind);
    }
  });
  // Ctrl+Enter in the redraft note redrafts (it is that field's own action); everywhere else in the
  // work form it sends.
  D.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" || !(e.ctrlKey || e.metaKey) || e.target.name !== "feedback" || e.target.form?.id !== "workform") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    $('button[name="action"][value="redraft"]', e.target.form)?.click();
  }, true);
  W.addEventListener("resize", () => { foldCheck(); dockFold(); });

  /* ---------- Wiring: one click listener, in order ---------- */
  D.addEventListener("click", (e) => {
    const tg = e.target;
    // A confirm runs first (capture below); a menu row closes its menu, then acts like any element.
    if (menuLy && tg.closest(".wb-menu__item") && menuLy.el.contains(tg)) {
      if (tg.closest("a[href]")) { setTimeout(() => menuLy?.close()); return; }
      menuLy.close();
    }
    const close = tg.closest("[data-close]");
    if (close) { const ly = layerOf(close); if (ly && !ly.busy) ly.close(); return; }
    const sub = tg.closest("[data-submit]");
    if (sub) { submitRow(sub); return; }
    if (emailClick(tg)) return;
    const m = tg.closest("[data-menu]");
    if (m) { if (menuLy?.trigger === m) menuLy.close(); else openMenu(m); return; }
    const ov = tg.closest("[data-overlay]");
    if (ov) { const src = D.getElementById(ov.dataset.overlay); if (src) openOverlay(src, ov); return; }
    if (tg.closest("[data-compose]")) { wireCompose(); if (cmp()) openOverlay(cmp(), tg.closest("[data-compose]")); return; }
    const q = tg.closest("[data-q]");
    if (q) { if (q.getAttribute("aria-checked") !== "true" || /(^|&)show=/.test(q.dataset.q)) switchFilter(q.dataset.q); return; }
    if (tg.closest("[data-sync]")) return syncNow();
    if (tg.closest("[data-q-clear]")) { const f = D.getElementById("q"); f.value = ""; f.focus(); return findLater(); }
    if (tg.closest("#qupd")) { tg.closest("#qupd").hidden = true; qp().scrollTop = 0; scrollTo(0, 0); return refreshQueue(); }
    const bk = tg.closest("[data-back]");
    if (bk && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.button === 0) { e.preventDefault(); return back(); }
  });
  // A tap on a field's own frame (its padding, around the text) focuses the field inside it.
  D.addEventListener("click", (e) => {
    if (e.target.matches?.(".wb-input")) $("input, textarea, select", e.target)?.focus();
  });
  D.addEventListener("click", (e) => {
    const b = e.target.closest?.("[data-confirm]");
    if (!b) return;
    if (b.dataset.axConfirmed) { delete b.dataset.axConfirmed; return; }
    e.preventDefault();
    e.stopImmediatePropagation();
    if (menuLy?.el.contains(b)) menuLy.close();
    confirmFirst(b);
  }, true);
  D.addEventListener("submit", (e) => {
    const f = e.target, b = e.submitter;
    if (e.defaultPrevented || !(f.hasAttribute("data-inline") || b?.hasAttribute("data-inline"))) return;
    e.preventDefault();
    // Posted from inside a dialog (Teach, Other document, a choice): it closes once the post landed.
    const ly = layerOf(b || f);
    post(f, b).then((r) => { if (r.ok && ly?.el.matches(".ax-ov")) ly.close(); });
  });
  // A filter form (data-autosubmit, the audit log): a choice in a select applies at once; the text
  // fields apply on Enter.
  D.addEventListener("change", (e) => {
    if (e.target.matches("select") && e.target.form?.hasAttribute("data-autosubmit")) e.target.form.requestSubmit();
  });
  D.addEventListener("input", (e) => { if (e.target.id === "q") findLater(); });
  D.addEventListener("keydown", (e) => {
    // The search field: Enter searches at once (and nothing else), Esc clears it.
    if (e.target.id === "q" && !e.isComposing) {
      if (e.key === "Enter") { e.preventDefault(); clearTimeout(F.timer); findNow(); }
      else if (e.key === "Escape" && !stack.length && e.target.value) { e.preventDefault(); e.target.value = ""; findLater(); }
    }
    // The queue is a listbox: ArrowDown and ArrowUp move the focus between its visible rows (Enter
    // opens one, as a link).
    const row = e.target.closest?.("#qlist .wb-row");
    if (row && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      const rows = $$("#qlist .wb-row"), i = rows.indexOf(row);
      e.preventDefault();
      rows[Math.min(rows.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))].focus();
    }
    // The segmented control: arrow keys move the choice, as the vocabulary's radiogroup.
    const seg = e.target.closest?.(".wb-seg");
    if (seg && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      const opts = $$("button", seg), i = opts.indexOf(e.target), n = opts[(i + (e.key === "ArrowRight" ? 1 : -1) + opts.length) % opts.length];
      e.preventDefault();
      n.focus();
      n.click();
    }
  });

  initQueue();
  afterWork(false);
  if (!currentId()) D.body.classList.remove("ax-detail");

  W.Axle = {
    menu: openMenu, sheet: openSheet, overlay: openOverlay, toast, banner, clearBanner,
    post, next, flush, saveState, refreshQueue, back, phone, remote: openRemote,
    close: () => stack[stack.length - 1]?.close(),
  };
})();
