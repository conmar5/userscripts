// ==UserScript==
// @name         Xero Branding Guard
// @namespace    https://github.com/conmar5
// @version      1.0.0
// @description  Stops Xero quietly applying the first branding theme to new quotes and invoices. Unless the theme came from the contact's default or you chose it, Save, Approve and Send are blocked until you pick one.
// @author       conmar5
// @match        https://go.xero.com/app/*
// @grant        unsafeWindow
// @run-at       document-idle
// @updateURL    https://raw.githubusercontent.com/conmar5/userscripts/main/xero-branding-guard.user.js
// @downloadURL  https://raw.githubusercontent.com/conmar5/userscripts/main/xero-branding-guard.user.js
// ==/UserScript==

(function () {
  'use strict';

  // How it decides:
  //   Xero fills in the contact's default branding theme, or the theme at the top of the
  //   Invoice settings list when the contact has none. Only the second case is a silent
  //   guess. The theme counts as confirmed when any of these is true:
  //     - you picked a theme from the Branding theme dropdown on this page,
  //     - the theme is not the top-of-list theme (so someone chose it deliberately),
  //     - the theme is the contact's own default theme.
  //   Until then the field is highlighted and Save / Approve / Send are blocked.

  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const OIDC_KEY = 'oidc.user:https://identity.xero.com:xero_business_go';
  const LOG = (...a) => console.log('[BrandingGuard]', ...a);
  const NOTE_ID = 'xbg-note';

  // Buttons and menu items that save or send the document.
  const ACTION_RE = /^(Save|Save & close|Save as draft|Save & continue|Save & add another|Save & view next|Approve|Approve & email|Approve & print|Approve & add another|Approve & view next|Send)$/i;

  let touched = false;          // user picked from the theme dropdown on this page
  let lastPath = location.pathname;
  let state = { confirmed: true, reason: '' };
  let checkSeq = 0;

  // ---------------------------------------------------------------------------
  // Xero API (bearer token the web app already holds)
  // ---------------------------------------------------------------------------
  async function api(path) {
    const raw = W.sessionStorage.getItem(OIDC_KEY);
    if (!raw) throw new Error('Xero session token not found');
    const shortCode = (location.pathname.match(/\/app\/(![^/]+)/) || [])[1] || '';
    const r = await W.fetch(location.origin + path, {
      credentials: 'include',
      headers: {
        'Authorization': 'Bearer ' + JSON.parse(raw).access_token,
        'Xero-Shell-App-Name': 'quotes',
        'Xero-Tenant-Shortcode': shortCode,
        'Accept': 'application/json',
      },
    });
    if (!r.ok) throw new Error(`Xero returned ${r.status} for ${path}`);
    return r.json();
  }

  let themesCache = null;
  async function themes() {
    if (!themesCache) {
      const list = await api('/api/quotes/brandingTheme/all');
      themesCache = (list || []).slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    }
    return themesCache;
  }

  const contactCache = new Map();
  async function contactDefaultThemeName(contactName) {
    if (!contactName) return null;
    if (contactCache.has(contactName)) return contactCache.get(contactName);
    const list = await api('/api/quotes/contacts?search=' + encodeURIComponent(contactName));
    const match = (list || []).find(c => (c.name || '').trim().toLowerCase() === contactName.trim().toLowerCase());
    let name = null;
    if (match && match.brandingThemeId) {
      const t = (await themes()).find(x => x.id === match.brandingThemeId);
      name = t ? t.name : null;
    }
    contactCache.set(contactName, name);
    return name;
  }

  // ---------------------------------------------------------------------------
  // Page reading
  // ---------------------------------------------------------------------------
  function labelledControl(text) {
    const lab = [...document.querySelectorAll('label')].find(l => l.textContent.trim() === text);
    if (!lab) return null;
    const id = lab.getAttribute('for');
    return id ? document.getElementById(id) : null;
  }

  // The editable Branding theme control: an input (quotes) or a select-style button (invoices).
  function themeControl() {
    const el = labelledControl('Branding theme');
    if (!el || !(el.tagName === 'INPUT' || el.tagName === 'BUTTON')) return null;
    return el;
  }
  const themeValue = el => (el.tagName === 'INPUT' ? el.value : el.textContent).trim();

  function contactName() {
    const el = labelledControl('Contact');
    return el && el.tagName === 'INPUT' ? el.value.trim() : '';
  }

  function onEditablePage() {
    return /\/(quotes|invoicing)(\/|$)/.test(location.pathname) && !!themeControl();
  }

  // ---------------------------------------------------------------------------
  // Decision
  // ---------------------------------------------------------------------------
  async function evaluate() {
    const seq = ++checkSeq;
    const ctl = themeControl();
    if (!ctl) { state = { confirmed: true }; render(); return; }
    const current = themeValue(ctl);
    try {
      const list = await themes();
      const top = list[0] && list[0].name;
      let confirmed = false;
      let reason = '';
      if (touched) {
        confirmed = true;
      } else if (current && top && current !== top) {
        confirmed = true;
      } else {
        const who = contactName();
        const def = await contactDefaultThemeName(who);
        if (def && def === current) {
          confirmed = true;
        } else {
          reason = who
            ? `Xero filled in "${current}" because ${who} has no default branding theme. Choose the theme for this document.`
            : `Xero filled in "${current}" as a default. Choose the branding theme for this document.`;
        }
      }
      if (seq !== checkSeq) return; // a newer check has started
      state = { confirmed, reason };
    } catch (e) {
      LOG('check failed', e);
      if (seq !== checkSeq) return;
      state = { confirmed: false, reason: 'Could not check the branding theme (' + e.message + '). Choose it explicitly.' };
    }
    render();
  }

  // ---------------------------------------------------------------------------
  // UI: highlight + note under the field
  // ---------------------------------------------------------------------------
  function render() {
    const ctl = themeControl();
    let note = document.getElementById(NOTE_ID);
    if (!ctl || state.confirmed) {
      if (note) note.remove();
      if (ctl) { ctl.style.outline = ''; ctl.style.boxShadow = ''; }
      return;
    }
    ctl.style.outline = '2px solid #e8a33d';
    ctl.style.boxShadow = '0 0 0 3px #fff1d6';
    if (!note) {
      note = document.createElement('div');
      note.id = NOTE_ID;
      note.style.cssText = 'margin-top:6px;padding:6px 8px;border-radius:4px;background:#fff6e5;border:1px solid #f0c27a;color:#7a4300;font-size:12px;line-height:1.35;max-width:320px';
      const host = ctl.closest('div[class*="field"], div[class*="Field"], div') || ctl.parentElement;
      host.parentElement.insertBefore(note, host.nextSibling);
    }
    note.textContent = state.reason || 'Choose the branding theme for this document.';
  }

  function flash() {
    const note = document.getElementById(NOTE_ID);
    const ctl = themeControl();
    if (ctl) ctl.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (note) {
      note.style.background = '#fdecea'; note.style.borderColor = '#e6a39d'; note.style.color = '#8a1c14';
      note.textContent = 'Not saved. ' + (state.reason || 'Choose the branding theme first.');
    }
  }

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------
  // Block Save / Approve / Send while the theme is unconfirmed.
  document.addEventListener('click', ev => {
    if (!onEditablePage() || state.confirmed) return;
    const el = ev.target.closest('button, [role="menuitem"], [role="option"], a');
    if (!el) return;
    if (el.closest('.EmailModal--wrapper, .eui-isolationModal')) return;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!ACTION_RE.test(text)) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    flash();
  }, true);

  // Mark the theme as chosen when the user picks from the theme dropdown.
  document.addEventListener('pointerdown', ev => {
    const ctl = themeControl();
    if (!ctl) return;
    const opt = ev.target.closest('[role="option"], [role="menuitemradio"], [role="menuitem"], li');
    if (!opt) return;
    const listId = ctl.getAttribute('aria-controls') || ctl.getAttribute('aria-owns');
    const inThemeList = (listId && opt.closest('#' + CSS.escape(listId))) ||
      document.activeElement === ctl || ctl.getAttribute('aria-expanded') === 'true';
    if (!inThemeList) return;
    const names = (themesCache || []).map(t => t.name);
    const text = opt.textContent.replace(/\s+/g, ' ').trim();
    if (names.length && !names.some(n => text.startsWith(n))) return;
    touched = true;
    setTimeout(evaluate, 300);
  }, true);

  // Re-check when the page, the contact or the theme changes.
  let lastKey = '';
  function tick() {
    if (location.pathname !== lastPath) {
      // A new document starts unconfirmed; an auto-saved new draft keeps the choice.
      const wasNew = /\/(quotes|invoicing)\/?$/.test(lastPath);
      const isEditOfNew = wasNew && /\/(quotes|invoicing)\/edit\//.test(location.pathname);
      if (!isEditOfNew) touched = false;
      lastPath = location.pathname;
    }
    const ctl = themeControl();
    const key = ctl ? location.pathname + '|' + contactName() + '|' + themeValue(ctl) : '';
    if (key !== lastKey) {
      lastKey = key;
      if (ctl) evaluate(); else { state = { confirmed: true }; render(); }
    } else if (ctl && !state.confirmed && !document.getElementById(NOTE_ID)) {
      render(); // the app re-rendered and dropped the note
    }
  }
  new MutationObserver(() => { clearTimeout(tick.t); tick.t = setTimeout(tick, 250); })
    .observe(document.body, { childList: true, subtree: true, characterData: true });
  setInterval(tick, 1500);
  tick();
  LOG('loaded');
})();
