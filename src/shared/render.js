/* DOM helpers shared by extension pages. All API text is inserted with textContent. */
(function (root) {
  'use strict';
  const BB = root.BB;

  function h(tag, attrs) {
    const el = document.createElement(tag);
    const a = attrs || {};
    for (const k of Object.keys(a)) {
      const v = a[k];
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    return el;
  }

  function append(el, child) {
    if (child === undefined || child === null || child === false) return;
    if (Array.isArray(child)) child.forEach((c) => append(el, c));
    else el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }

  const LEVEL_TEXT = { scam: 'Scam', suspicious: 'Suspicious', safe: 'Clear', unknown: 'Unknown', error: 'Error', skipped: 'Skipped', checking: 'Checking' };

  function pill(level, text) {
    return h('span', { class: 'pill ' + (level || 'unknown') }, text || LEVEL_TEXT[level] || level || 'Unknown');
  }

  function middle(s, keep) {
    const str = String(s || '');
    const k = keep || 10;
    return str.length > k * 2 + 1 ? str.slice(0, k) + '…' + str.slice(-k) : str;
  }

  function fmtDate(v) {
    if (!v) return '';
    const d = typeof v === 'number' ? new Date(v) : new Date(String(v));
    if (isNaN(d.getTime())) return String(v);
    return d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function kv(fields) {
    if (!fields || !fields.length) return null;
    const dl = h('dl', { class: 'kv' });
    for (const f of fields) dl.append(h('dt', { text: f.key }), h('dd', { text: f.value }));
    return dl;
  }

  function raw(data, label) {
    if (data === undefined || data === null || data === '') return null;
    let text;
    try {
      text = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    } catch (e) {
      text = String(data);
    }
    return h('details', { class: 'raw' }, h('summary', { text: label || 'Raw API response' }), h('pre', { text }));
  }

  function notice(kind, text, extra) {
    return h('div', { class: 'notice ' + (kind || ''), role: kind === 'error' ? 'alert' : 'status' }, text, extra || null);
  }

  /** Render a verdict object from the background into a card. */
  function verdictCard(v, subject) {
    if (!v) return notice('', 'No result.');
    const level = v.level || 'unknown';
    const headline = level === 'error' ? 'Check failed' : v.label || LEVEL_TEXT[level];
    const card = h(
      'div',
      { class: 'verdict ' + level },
      h('div', { class: 'row' }, h('div', { class: 'headline grow' }, headline), v.score !== null && v.score !== undefined ? pill(level, 'Risk ' + v.score + '%') : null),
      subject ? h('div', { class: 'subject', text: subject }) : null
    );
    const reasons = (v.reasons || []).slice(0, 6);
    if (v.error) reasons.unshift(v.error);
    if (reasons.length) card.append(h('ul', null, reasons.map((r) => h('li', { text: r }))));
    const fields = kv((v.fields || []).slice(0, 12));
    if (fields) card.append(fields);
    const meta = [];
    if (v.op) meta.push('via ' + v.op);
    if (v.checkedAt) meta.push((v.cached ? 'cached · ' : '') + fmtDate(v.checkedAt));
    if (meta.length) card.append(h('div', { class: 'hint', text: meta.join(' · ') }));
    const r = raw(v.raw);
    if (r) card.append(r);
    return card;
  }

  /** Render submission records (from describeRecord). */
  function records(list, opts) {
    const o = opts || {};
    if (!list || !list.length) return notice('', o.empty || 'No records.');
    const ul = h('ul', { class: 'records' });
    for (const r of list) {
      const li = h(
        'li',
        { class: 'record' },
        h('div', { class: 'row' }, h('div', { class: 'grow mono', title: r.title, text: middle(r.title, 18) }), r.status ? pill(statusLevel(r.status), r.status) : null),
        h('div', { class: 'hint' }, [r.kind, r.id ? 'ID ' + r.id : '', fmtDate(r.date)].filter(Boolean).join(' · '))
      );
      if (o.onStatus && r.id) li.append(h('button', { class: 'small', type: 'button', onclick: () => o.onStatus(r, li) }, 'Check status'));
      ul.append(li);
    }
    return ul;
  }

  function statusLevel(status) {
    const s = String(status || '').toLowerCase();
    if (/approved|confirmed|accepted|listed|scam|malicious|verified/.test(s)) return 'scam';
    if (/pending|review|open|new|submitted|queued|processing/.test(s)) return 'suspicious';
    if (/rejected|dismissed|declined|closed|safe|false/.test(s)) return 'safe';
    return 'unknown';
  }

  function spinner(text) {
    return h('div', { class: 'row muted small-text' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text || 'Working…');
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  BB.ui = { h, pill, middle, fmtDate, kv, raw, notice, verdictCard, records, spinner, clear, statusLevel };
})(globalThis);
