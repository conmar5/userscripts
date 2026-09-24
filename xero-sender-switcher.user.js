// ==UserScript==
// @name         Xero Sender Switcher
// @namespace    https://github.com/conmar5
// @version      1.1.3
// @description  Adds a "Send from" selector to Xero's quote and invoice email dialogs. Pre-selects the sender from the contact's default branding theme, and leaves it blank when the contact has none.
// @author       conmar5
// @match        https://go.xero.com/app/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @grant        GM_xmlhttpRequest
// @connect      go.xero.com
// @sandbox      JavaScript
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Configuration (kept in Tampermonkey storage, not in this file)
  // Key "themeToSender": { "<branding theme name>": "<sender email address>" }
  // Edit it in Tampermonkey: script > Storage tab (Advanced config mode),
  // or via the Tampermonkey menu > "Sender Switcher settings" while on Xero.
  // Themes not listed are treated as "no default", so the selector is left blank.
  // ---------------------------------------------------------------------------
  const STORE_KEY = 'themeToSender';
  function loadMapping() {
    const v = GM_getValue(STORE_KEY, {});
    return (v && typeof v === 'object') ? v : {};
  }

  // Run in the page's own context (@sandbox JavaScript) so requests carry the Xero
  // session exactly like Xero's own code. If the page fetch is unavailable, fall back
  // to GM_xmlhttpRequest. Both return a fetch-like response: { ok, status, text(), json() }.
  const LOG = (...a) => console.log('[SenderSwitcher]', ...a);
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  function gmRequest(path, opts) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || 'GET',
        url: location.origin + path,
        headers: opts.headers || {},
        data: opts.body,
        anonymous: false,
        onload: r => resolve({
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          text: async () => r.responseText,
          json: async () => JSON.parse(r.responseText),
        }),
        onerror: r => reject(new Error(`request failed for ${path} (${(r && (r.error || r.statusText || r.status)) || 'no detail'})`)),
        ontimeout: () => reject(new Error('request timed out for ' + path)),
      });
    });
  }
  async function xfetch(path, opts = {}) {
    try {
      return await W.fetch(location.origin + path, opts);
    } catch (e) {
      LOG('page fetch failed, trying GM_xmlhttpRequest', e);
      try {
        return await gmRequest(path, opts);
      } catch (e2) {
        throw new Error(`page fetch: ${e.message}; GM request: ${e2.message}`);
      }
    }
  }

  const OIDC_KEY = 'oidc.user:https://identity.xero.com:xero_business_go';
  const BAR_ID = 'xss-sender-switcher';

  // ---------------------------------------------------------------------------
  // Xero settings endpoints (cookie + CSRF token, same as Settings > Email settings)
  // ---------------------------------------------------------------------------
  async function csrfToken() {
    const html = await xfetch('/Settings/Email/', { credentials: 'include' }).then(r => r.text());
    const m = html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/);
    if (!m) throw new Error('Could not read Xero security token. Are you still logged in?');
    return m[1];
  }

  async function settingsPost(url, body, token) {
    const r = await xfetch(url, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'X-CSRFToken': token,
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body,
    });
    if (!r.ok) throw new Error(`Xero returned ${r.status} for ${url}`);
    return r.json();
  }

  // Returns [{id, name, address, active}]
  async function getSenders(token) {
    const j = await settingsPost('/Settings/Email/GetEmailAddresses', 'page=1&start=0&limit=50', token);
    return (j.Data || [])
      .filter(x => x.EmailAddress) // skip "The logged in user"
      .map(x => ({
        id: x.EmailAddressID,
        name: x.EmailAddressName,
        address: x.EmailAddress.toLowerCase(),
        active: /ACTIVE$/.test(x.Status || ''),
        verified: /(ACTIVE|VERIFIED)$/.test(x.Status || ''),
      }));
  }

  async function setDefaultSender(senderId, token) {
    const body = 'email=' + encodeURIComponent(senderId) +
      '&emailSetting=' + encodeURIComponent('OUTGOINGEMAILADDR/CUSTOM');
    return settingsPost('/Settings/Email/UpdateOutgoingEmailSettings', body, token);
  }

  // ---------------------------------------------------------------------------
  // Xero app API (bearer token that the Xero web app already holds)
  // ---------------------------------------------------------------------------
  function shortCode() {
    const m = location.pathname.match(/\/app\/(![^/]+)/);
    return m ? m[1] : '';
  }

  async function appGet(path, appName) {
    const raw = W.sessionStorage.getItem(OIDC_KEY);
    if (!raw) throw new Error('Xero session token not found');
    const token = JSON.parse(raw).access_token;
    const r = await xfetch(path, {
      credentials: 'include',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Xero-Shell-App-Name': appName,
        'Xero-Tenant-Shortcode': shortCode(),
        'Accept': 'application/json',
      },
    });
    if (!r.ok) throw new Error(`Xero returned ${r.status} for ${path}`);
    return r.json();
  }

  // Works out which document is open and returns the contact's default branding theme ID.
  // Returns { themeId: string|null, contactName: string|null } or null when no saved document is open.
  async function contactDefaultTheme() {
    const p = location.pathname;
    let m = p.match(/\/quotes\/(?:view|edit)\/([0-9a-f-]{36})/i);
    if (m) {
      const q = await appGet('/api/quotes/quotes/' + m[1], 'quotes');
      return { themeId: q?.contact?.brandingThemeId || null, contactName: q?.contact?.name || null };
    }
    m = p.match(/\/invoicing\/(?:view|edit)\/([0-9a-f-]{36})/i);
    if (m) {
      const inv = await appGet('/api/invoicing/invoice/find/' + m[1], 'invoicing');
      return { themeId: inv?.Customer?.BrandingThemeId || null, contactName: inv?.Customer?.Name || null };
    }
    return null;
  }

  let themeCache = null;
  async function themeNames() {
    if (themeCache) return themeCache;
    const list = await appGet('/api/quotes/brandingTheme/all', 'quotes');
    themeCache = {};
    (list || []).forEach(t => { themeCache[t.id] = t.name; });
    return themeCache;
  }

  // ---------------------------------------------------------------------------
  // UI
  // ---------------------------------------------------------------------------
  function isSendDialog(el) {
    if (!(el instanceof HTMLElement)) return false;
    if (el.matches('.EmailModal--wrapper')) return true; // quotes
    if (el.matches('.eui-isolationModal') && /Send email/.test(el.querySelector('h1')?.textContent || '')) return true; // invoices
    return false;
  }

  function findSendButton(dialog) {
    return [...dialog.querySelectorAll('button')].find(b => /^Send( email)?$/.test(b.textContent.trim()));
  }

  function buildBar() {
    const bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.style.cssText = [
      'display:flex', 'align-items:center', 'gap:10px', 'flex-wrap:wrap',
      'padding:10px 14px', 'margin:0 0 12px 0', 'border-radius:6px',
      'background:#f2f6fa', 'border:1px solid #c7d3de', 'font-size:14px',
    ].join(';');
    bar.innerHTML = `
      <label style="font-weight:600;white-space:nowrap">Send from</label>
      <select style="min-width:280px;padding:6px 8px;border:1px solid #9aa9b7;border-radius:4px;font-size:14px" disabled>
        <option value="">Loading senders…</option>
      </select>
      <span data-role="status" style="color:#44525e"></span>`;
    return bar;
  }

  function setStatus(bar, text, tone) {
    const s = bar.querySelector('[data-role=status]');
    const colours = { ok: '#1b7a3a', warn: '#a35a00', err: '#b3261e', info: '#44525e' };
    s.style.color = colours[tone] || colours.info;
    s.textContent = text;
    bar.style.background = tone === 'warn' ? '#fff6e5' : tone === 'err' ? '#fdecea' : '#f2f6fa';
    bar.style.borderColor = tone === 'warn' ? '#f0c27a' : tone === 'err' ? '#e6a39d' : '#c7d3de';
  }

  async function applySelection(bar, senders, senderId) {
    const sel = bar.querySelector('select');
    sel.disabled = true;
    setStatus(bar, 'Switching sender…', 'info');
    try {
      const token = await csrfToken();
      await setDefaultSender(senderId, token);
      const fresh = await getSenders(token);
      const active = fresh.find(s => s.active);
      if (active && active.id === senderId) {
        const previewNote = location.pathname.includes('/invoicing/')
          ? ' (the preview on the right may still show the old reply-to until reopened)' : '';
        setStatus(bar, `✓ This email will be sent from ${active.name} <${active.address}>${previewNote}`, 'ok');
      } else {
        setStatus(bar, 'Xero did not confirm the change. Check Settings > Email settings.', 'err');
      }
    } catch (e) {
      setStatus(bar, 'Could not switch sender: ' + e.message, 'err');
    } finally {
      sel.disabled = false;
    }
  }

  async function enhance(dialog) {
    if (dialog.querySelector('#' + BAR_ID)) return;
    const bar = buildBar();

    // Place the bar at the top of the dialog's form content.
    const anchor =
      dialog.querySelector('fieldset') ||                       // invoices: "To" fieldset
      dialog.querySelector('.xui-modal--body') ||               // quotes
      dialog.querySelector('[class*=body]') || dialog;
    if (anchor.tagName === 'FIELDSET') anchor.parentNode.insertBefore(bar, anchor);
    else anchor.insertBefore(bar, anchor.firstChild);

    const sel = bar.querySelector('select');
    let senders = [];

    try {
      const token = await csrfToken();
      senders = await getSenders(token);
    } catch (e) {
      setStatus(bar, 'Could not load senders: ' + e.message, 'err');
      return;
    }

    sel.innerHTML = '<option value="">— Choose sender —</option>' + senders
      .filter(s => s.verified)
      .map(s => `<option value="${s.id}">${s.name} &lt;${s.address}&gt;</option>`)
      .join('');
    sel.disabled = false;

    const current = senders.find(s => s.active);

    // Work out the default from the contact's branding theme.
    let auto = null;
    let reason = '';
    try {
      const info = await contactDefaultTheme();
      if (!info) {
        reason = 'Unsaved document, so no contact default could be read.';
      } else if (!info.themeId) {
        reason = `${info.contactName || 'This contact'} has no default branding theme.`;
      } else {
        const names = await themeNames();
        const themeName = names[info.themeId];
        const mapping = loadMapping();
        const addr = mapping[themeName];
        auto = addr ? senders.find(s => s.address === addr.toLowerCase()) : null;
        reason = auto
          ? `Chosen from ${info.contactName || 'the contact'}'s branding theme "${themeName}".`
          : Object.keys(mapping).length === 0
            ? 'No theme-to-sender settings saved yet (Tampermonkey menu > Sender Switcher settings).'
            : `${info.contactName || 'This contact'}'s branding theme "${themeName}" has no sender mapped.`;
      }
    } catch (e) {
      reason = 'Could not read the contact\'s branding theme (' + e.message + ').';
    }

    if (auto) {
      sel.value = auto.id;
      if (current && current.id === auto.id) {
        setStatus(bar, `✓ ${auto.name} <${auto.address}>. ${reason}`, 'ok');
      } else {
        await applySelection(bar, senders, auto.id);
        const s = bar.querySelector('[data-role=status]');
        s.textContent += ' ' + reason;
      }
    } else {
      sel.value = '';
      setStatus(bar, `${reason} Choose a sender. Xero's current default is ${current ? current.name : 'unknown'}.`, 'warn');
    }

    sel.addEventListener('change', () => {
      if (sel.value) applySelection(bar, senders, sel.value);
      else setStatus(bar, `No sender chosen. Xero's current default will be used.`, 'warn');
    });

    // Safety check on Send: block if nothing chosen, or if Xero's default has drifted.
    const sendBtn = findSendButton(dialog);
    if (sendBtn && !sendBtn.dataset.xssGuard) {
      sendBtn.dataset.xssGuard = '1';
      sendBtn.addEventListener('click', async (ev) => {
        if (sendBtn.dataset.xssOk === '1') { sendBtn.dataset.xssOk = ''; return; }
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (!sel.value) {
          setStatus(bar, 'Choose a sender before sending.', 'err');
          sel.focus();
          return;
        }
        try {
          const token = await csrfToken();
          const fresh = await getSenders(token);
          const active = fresh.find(s => s.active);
          if (!active || active.id !== sel.value) {
            await setDefaultSender(sel.value, token);
            const again = (await getSenders(token)).find(s => s.active);
            if (!again || again.id !== sel.value) {
              setStatus(bar, 'Sender could not be confirmed. Email NOT sent.', 'err');
              return;
            }
          }
        } catch (e) {
          setStatus(bar, 'Sender check failed: ' + e.message + '. Email NOT sent.', 'err');
          return;
        }
        sendBtn.dataset.xssOk = '1';
        sendBtn.click();
      }, true);
    }
  }

  // ---------------------------------------------------------------------------
  // Settings editor (Tampermonkey menu). Pre-fills with the current settings, or
  // with a template built from Xero's actual theme names and sender addresses.
  // ---------------------------------------------------------------------------
  async function editSettings() {
    let current = loadMapping();
    if (Object.keys(current).length === 0) {
      try {
        const names = Object.values(await themeNames()).filter(n => !/^OLD/i.test(n));
        const senders = await getSenders(await csrfToken());
        current = {};
        names.forEach(n => {
          const s = senders.find(x => x.name.toLowerCase().startsWith(n.toLowerCase()));
          current[n] = s ? s.address : '';
        });
      } catch (e) { LOG('could not build template', e); }
    }
    const input = prompt(
      'Branding theme name -> sender email (JSON). Leave a value empty to ignore that theme.',
      JSON.stringify(current)
    );
    if (input === null) return;
    try {
      const parsed = JSON.parse(input);
      const clean = {};
      Object.entries(parsed).forEach(([k, v]) => { if (v) clean[k] = String(v).trim(); });
      GM_setValue(STORE_KEY, clean);
      alert('Saved ' + Object.keys(clean).length + ' theme mapping(s).');
    } catch (e) {
      alert('That was not valid JSON. Nothing was saved.');
    }
  }
  GM_registerMenuCommand('Sender Switcher settings', editSettings);

  // ---------------------------------------------------------------------------
  // Watch for the send dialogs opening
  // ---------------------------------------------------------------------------
  const seen = new WeakSet();
  function scan() {
    document.querySelectorAll('.EmailModal--wrapper, .eui-isolationModal').forEach(d => {
      if (seen.has(d) || !isSendDialog(d)) return;
      seen.add(d);
      enhance(d).catch(e => LOG('error', e));
    });
  }
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
  LOG('loaded');
})();
