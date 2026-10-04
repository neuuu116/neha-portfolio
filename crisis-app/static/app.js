/* Crisis Support Hub — vanilla JS, no build step.
 * Same-origin by default; set window.API_BASE before this script to point elsewhere. */
(() => {
  'use strict';

  const API_BASE = (window.API_BASE || '').replace(/\/+$/, '');
  const OUTBOX_KEY = 'csh.outbox.v1';
  const $ = (sel, root = document) => root.querySelector(sel);

  const state = {
    strategies: [],
    resources: [],
    posts: [],
    outbox: readOutbox(),
  };

  /* ---------------- storage ---------------- */
  function readOutbox() {
    try {
      return JSON.parse(localStorage.getItem(OUTBOX_KEY)) || [];
    } catch {
      return [];
    }
  }

  function writeOutbox(items) {
    state.outbox = items;
    try {
      localStorage.setItem(OUTBOX_KEY, JSON.stringify(items));
    } catch {
      /* storage disabled (private mode) — the in-memory copy still works */
    }
  }

  /* ---------------- network ---------------- */
  async function api(path, options = {}) {
    const res = await fetch(API_BASE + path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.status === 204 ? null : res.json();
  }

  function newId() {
    return (crypto.randomUUID && crypto.randomUUID()) ||
      'c-' + Date.now() + '-' + Math.random().toString(16).slice(2);
  }

  /* ---------------- rendering ---------------- */
  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  function showTab(tab) {
    document.querySelectorAll('.tabs button').forEach((btn) => {
      const on = btn.dataset.tab === tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.panel').forEach((panel) => {
      panel.hidden = panel.id !== 'panel-' + tab;
    });
  }

  function renderStrategies() {
    const box = $('#strategies');
    if (!state.strategies.length) {
      box.innerHTML = '<p class="muted">No strategies cached yet. Connect once to download them.</p>';
      return;
    }
    box.innerHTML = state.strategies.map((s) => `
      <article class="card">
        <h3>${escapeHtml(s.title)} <span class="pill">${escapeHtml(s.duration || '')}</span></h3>
        <ol>${s.steps.map((step) => `<li>${escapeHtml(step)}</li>`).join('')}</ol>
      </article>`).join('');
  }

  function renderResources() {
    const box = $('#resources');
    if (!state.resources.length) {
      box.innerHTML = '<p class="muted">No resources cached yet. Connect once to download them.</p>';
      return;
    }
    box.innerHTML = state.resources.map((r) => {
      const call = r.phone
        ? `<a class="call-btn" href="tel:${escapeHtml(r.phone)}">Call ${escapeHtml(r.phone)}</a>`
        : '';
      const text = r.sms
        ? `<a class="call-btn ghost" href="sms:${escapeHtml(r.sms)}">Text ${escapeHtml(r.sms)}</a>`
        : '';
      const link = r.url
        ? `<a class="text-link" href="${escapeHtml(r.url)}" target="_blank" rel="noopener">Website</a>`
        : '';
      const dist = typeof r.distance_km === 'number'
        ? `<span class="pill">${r.distance_km} km</span>`
        : '';
      return `
        <article class="card ${r.kind === 'emergency' ? 'card-alert' : ''}">
          <h3>${escapeHtml(r.name)} ${dist}</h3>
          <p>${escapeHtml(r.note || '')}</p>
          <div class="row">${call}${text}${link}</div>
        </article>`;
    }).join('');
  }

  function renderPosts() {
    const box = $('#posts');
    if (!state.posts.length) {
      box.innerHTML = '<p class="muted">No posts yet.</p>';
      return;
    }
    box.innerHTML = state.posts.map((p) => `
      <article class="post-card ${p.pending ? 'pending' : ''}">
        <p>${escapeHtml(p.content)}</p>
        <small>${p.pending ? 'Queued — will send when you are back online' : escapeHtml(p.created_at || '')}</small>
      </article>`).join('');
  }

  function renderQueueStatus() {
    const n = state.outbox.length;
    $('#queue-status').textContent = n
      ? `${n} post${n > 1 ? 's' : ''} waiting to send.`
      : '';
  }

  function renderNetStatus() {
    const online = navigator.onLine;
    $('#net-status').textContent = online
      ? 'Online'
      : 'Offline — cached content still works';
    $('#net-status').classList.toggle('offline', !online);
  }

  /* ---------------- data ---------------- */
  async function loadBootstrap() {
    try {
      const data = await api('/api/bootstrap');
      state.strategies = data.strategies || [];
      state.resources = data.resources || [];
    } catch {
      /* offline on first run: the service worker cache may still answer below */
    }
    renderStrategies();
    renderResources();
  }

  async function loadPosts() {
    try {
      const data = await api('/api/posts');
      state.posts = data.posts || [];
    } catch {
      /* offline: keep whatever is on screen */
    }
    renderPosts();
  }

  async function sortByDistance() {
    const status = $('#locate-status');
    if (!navigator.geolocation) {
      status.textContent = 'This browser has no location support.';
      return;
    }
    status.textContent = 'Getting your location…';
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const data = await api(`/api/resources?lat=${latitude}&lon=${longitude}`);
          state.resources = data.resources || [];
          renderResources();
          status.textContent = 'Sorted by distance from your location.';
        } catch {
          status.textContent = 'Could not reach the server. Showing cached list.';
        }
      },
      () => { status.textContent = 'Location permission denied. Showing the default list.'; },
      { timeout: 8000 }
    );
  }

  /* ---------------- posting + offline outbox ---------------- */
  async function sendPost(payload) {
    return api('/api/posts', { method: 'POST', body: JSON.stringify(payload) });
  }

  async function submitPost() {
    const input = $('#post-input');
    const content = input.value.trim();
    if (!content) return;
    const payload = { content, client_id: newId() };
    input.value = '';

    try {
      const saved = await sendPost(payload);
      state.posts.unshift(saved);
    } catch {
      // No connection: keep it locally, show it as queued, retry later.
      writeOutbox([...state.outbox, payload]);
      state.posts.unshift({ content, pending: true });
    }
    renderPosts();
    renderQueueStatus();
  }

  async function flushOutbox() {
    if (!state.outbox.length) return;
    const pending = state.outbox;
    const remaining = [];
    for (const item of pending) {
      try {
        await sendPost(item);
      } catch {
        remaining.push(item);
      }
    }
    writeOutbox(remaining);
    if (remaining.length < pending.length) await loadPosts();
    renderQueueStatus();
  }

  /* ---------------- wiring ---------------- */
  document.querySelectorAll('.tabs button').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });

  document.querySelectorAll('[data-goto]').forEach((btn) => {
    btn.addEventListener('click', () => showTab(btn.dataset.goto));
  });

  $('#locate-btn').addEventListener('click', sortByDistance);
  $('#post-btn').addEventListener('click', submitPost);
  $('#post-input').addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) submitPost();
  });

  window.addEventListener('online', () => {
    renderNetStatus();
    flushOutbox();
  });
  window.addEventListener('offline', renderNetStatus);

  renderNetStatus();
  renderQueueStatus();
  loadBootstrap();
  loadPosts();
  flushOutbox();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
})();
