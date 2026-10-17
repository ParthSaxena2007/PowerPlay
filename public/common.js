// Shared helpers for all pages
const PP = (() => {
  const fmt = (n) => Math.round(Number(n) || 0).toLocaleString('en-IN');
  const fmt1 = (n) => (Math.round((Number(n) || 0) * 10) / 10).toLocaleString('en-IN');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const $ = (sel, root = document) => root.querySelector(sel);

  let skew = 0; // serverNow - localNow, so every screen shows the same time
  const syncClock = (s) => { if (s) skew = s - Date.now(); };
  const serverNow = () => Date.now() + skew;

  async function api(path, { method = 'GET', body, token } = {}) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed. Check your connection.');
    return data;
  }

  let toastTimer;
  function toast(msg, isErr = false) {
    let el = document.getElementById('toast');
    if (!el) { el = document.createElement('div'); el.id = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); }
    el.className = 'toast' + (isErr ? ' err' : '');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3200);
  }

  function clockText(ms) {
    const s = Math.ceil(Math.max(0, ms) / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  // Time shown to players: ends lockBufferSec before the server actually locks
  function remainingMs(pub) {
    const r = pub?.round;
    if (!r) return 0;
    const buf = (pub.config.lockBufferSec || 0) * 1000;
    if (pub.status === 'paused') return Math.max(0, (r.remainingMs ?? 0) - buf);
    if (pub.status !== 'running') return 0;
    return Math.max(0, r.displayEndsAt - serverNow());
  }

  function beep() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const o = ctx.createOscillator(); const g = ctx.createGain();
      o.frequency.value = 880; o.connect(g); g.connect(ctx.destination);
      g.gain.setValueAtTime(0.15, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
      o.start(); o.stop(ctx.currentTime + 0.5);
    } catch {}
  }

  const statusText = { lobby: 'Waiting to start', running: 'Trading open', paused: 'Paused', results: 'Round results', finished: 'Game over' };

  return { fmt, fmt1, esc, $, api, toast, syncClock, serverNow, clockText, remainingMs, beep, statusText };
})();
