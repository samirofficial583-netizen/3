/**
 * TransportPro — Transport Management System
 * script.js — Pure ES6+, no frameworks
 * Columns: id, name, gst, contact, map, places, created_at, front_photo_url, back_photo_url
 */

'use strict';

/* ============================================================
   1. CONFIG & SUPABASE INIT
   ============================================================ */
const SUPABASE_URL      = 'https://psbadrkeouletglhdhfy.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_p0KlLEoknnfpJT24S5l2GQ_D6a7i5x6';
const TABLE             = 'transporters';
// You have two separate storage buckets (one per photo side) instead of one shared bucket.
const BUCKETS           = { front: 'LR-Front', back: 'LR-Back' };
const PER_PAGE          = 50;

let sb = null;
try {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) {
  console.error('Supabase init failed:', e);
}

/* ============================================================
   2. APPLICATION STATE
   ============================================================ */
const state = {
  isAdmin:           false,
  transporters:      [],
  filtered:          [],
  currentPage:       1,
  totalPages:        1,
  viewMode:          'card',
  currentView:       'dashboard',
  searchQuery:       '',
  placesFilter:      '',
  sortOrder:         'newest',
  editingId:         null,
  detailTransporter: null,
  confirmCallback:   null,
  autoSaveTimer:     null,
};

/* ============================================================
   3. DOM HELPERS
   ============================================================ */
const $  = (sel, ctx = document) => ctx.querySelector(sel);
const $$ = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const on = (el, ev, fn) => el && el.addEventListener(ev, fn);

function show(el) { el && el.classList.remove('hidden'); }
function hide(el) { el && el.classList.add('hidden'); }

function openModal(id) {
  const el = $(id);
  if (!el) return;
  // Safety: close any other modal overlay still open so they can't stack and block input
  $$('.modal-overlay.open').forEach(other => {
    if (other !== el) other.classList.remove('open');
  });
  el.classList.add('open');
  document.body.style.overflow = 'hidden';
  setTimeout(() => {
    const first = el.querySelector('input:not([type=hidden]), button, select, textarea');
    first && first.focus();
  }, 120);
}
function closeModal(id) {
  const el = $(id);
  if (!el) return;
  el.classList.remove('open');
  document.body.style.overflow = '';
}

/* ============================================================
   4. TOAST
   ============================================================ */
function showToast(message, type = 'success', duration = 3500) {
  const container = $('#toast-container');
  if (!container) return;
  const icons = { success:'fa-check-circle', error:'fa-times-circle', warning:'fa-exclamation-triangle', info:'fa-info-circle' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', 'alert');
  toast.innerHTML = `
    <i class="fas ${icons[type]||icons.info} toast-icon"></i>
    <span class="toast-msg">${escapeHtml(message)}</span>
    <button class="toast-close" aria-label="Close"><i class="fas fa-times"></i></button>
  `;
  container.appendChild(toast);
  const remove = () => { toast.classList.add('removing'); setTimeout(() => toast.remove(), 300); };
  toast.querySelector('.toast-close').addEventListener('click', remove);
  setTimeout(remove, duration);
}

/* ============================================================
   5. THEME
   ============================================================ */
function initTheme() {
  setTheme(localStorage.getItem('tms-theme') || 'dark');
}
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('tms-theme', theme);
  const cls = theme === 'dark' ? 'fa-sun' : 'fa-moon';
  const ic = $('#theme-icon');
  if (ic) ic.className = `fas ${cls}`;
}
function toggleTheme() {
  setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}

/* ============================================================
   6. ADMIN AUTH (Supabase Auth — email + password)
   ============================================================ */

// Restore session on page load (persists admin mode across refresh)
async function initAdminSession() {
  if (!sb) return;
  try {
    const { data: { session } } = await sb.auth.getSession();
    state.isAdmin = !!session;
  } catch (e) {
    console.warn('Supabase session check failed:', e.message);
  }
  updateAdminUI();

  // Keep state in sync if the session changes/expires in another tab, etc.
  sb.auth.onAuthStateChange((_event, session) => {
    state.isAdmin = !!session;
    updateAdminUI();
  });
}

function openAdminLogin() {
  if (state.isAdmin) {
    // Already admin — ask to sign out
    confirmAction('Exit Admin Mode?', 'You will need to sign in again to make changes.', async () => {
      if (sb) {
        try { await sb.auth.signOut(); } catch (e) { console.warn('Sign out error:', e.message); }
      }
      state.isAdmin = false;
      updateAdminUI();
      showToast('Signed out of admin mode.', 'info');
    });
    return;
  }
  openModal('#admin-login-overlay');
  const emailInp = $('#admin-email-input');
  const passInp  = $('#admin-password-input');
  if (emailInp) emailInp.value = '';
  if (passInp)  passInp.value = '';
  if (emailInp) emailInp.focus();
  const err = $('#admin-password-error');
  if (err) err.textContent = '';
}

async function handleAdminLogin() {
  const emailInp  = $('#admin-email-input');
  const passInp   = $('#admin-password-input');
  const err       = $('#admin-password-error');
  const submitBtn = $('#admin-login-form button[type="submit"]');
  const email     = emailInp ? emailInp.value.trim() : '';
  const password  = passInp ? passInp.value : '';

  if (err) err.textContent = '';

  if (!email || !password) {
    if (err) err.textContent = 'Enter both email and password.';
    return;
  }

  if (!sb) {
    if (err) err.textContent = 'Supabase is not connected. Check script.js config.';
    return;
  }

  if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Signing in…'; }
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) {
      if (err) err.textContent = error.message || 'Incorrect email or password.';
      if (passInp) { passInp.value = ''; passInp.focus(); }
      return;
    }
  } catch (e) {
    if (err) err.textContent = 'Sign-in failed. Please try again.';
    return;
  } finally {
    if (submitBtn) { submitBtn.disabled = false; submitBtn.innerHTML = '<i class="fas fa-unlock-alt"></i> Enter Admin Mode'; }
  }

  state.isAdmin = true;
  closeModal('#admin-login-overlay');
  updateAdminUI();
  showToast('Admin mode active — you can now add, edit and delete.', 'success');
}

function openForgotPassword() {
  closeModal('#admin-login-overlay');
  openModal('#forgot-password-overlay');
  const emailInp = $('#forgot-email-input');
  const err      = $('#forgot-password-error');
  const success  = $('#forgot-password-success');
  if (emailInp) { emailInp.value = $('#admin-email-input')?.value.trim() || ''; emailInp.focus(); }
  if (err) err.textContent = '';
  if (success) success.textContent = '';
}

async function handleForgotPassword() {
  const emailInp  = $('#forgot-email-input');
  const err       = $('#forgot-password-error');
  const success   = $('#forgot-password-success');
  const submitBtn = $('#forgot-password-submit');
  const btnText   = submitBtn?.querySelector('.btn-text');
  const spinner   = submitBtn?.querySelector('.btn-spinner');
  const email     = emailInp ? emailInp.value.trim() : '';

  if (err) err.textContent = '';
  if (success) success.textContent = '';

  if (!email) { if (err) err.textContent = 'Enter your admin email.'; return; }
  if (!sb)    { if (err) err.textContent = 'Supabase is not connected.'; return; }

  if (submitBtn) submitBtn.disabled = true;
  if (btnText)   btnText.classList.add('hidden');
  if (spinner)   spinner.classList.remove('hidden');

  try {
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname,
    });
    if (error) {
      if (err) {
        err.textContent = /rate limit/i.test(error.message || '')
          ? 'Too many reset emails sent. Please wait a while and try again, or contact support to set up custom SMTP.'
          : (error.message || 'Failed to send reset email.');
      }
      return;
    }
    if (success) success.textContent = 'Reset link sent! Check your inbox (and spam folder).';
    showToast('Password reset email sent!', 'success');
  } catch (e) {
    if (err) err.textContent = 'Failed to send reset email. Please try again.';
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (btnText)   btnText.classList.remove('hidden');
    if (spinner)   spinner.classList.add('hidden');
  }
}

/* Detect Supabase password-recovery link (#access_token=...&type=recovery) and open reset modal */
function checkForPasswordRecoveryLink() {
  if (!sb) return;
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') {
      openModal('#reset-password-overlay');
    }
  });
}

async function handleResetPassword() {
  const newInp     = $('#new-password-input');
  const confirmInp = $('#confirm-password-input');
  const err        = $('#reset-password-error');
  const submitBtn  = $('#reset-password-submit');
  const btnText    = submitBtn?.querySelector('.btn-text');
  const spinner    = submitBtn?.querySelector('.btn-spinner');
  const pass1      = newInp ? newInp.value : '';
  const pass2      = confirmInp ? confirmInp.value : '';

  if (err) err.textContent = '';

  if (!pass1 || pass1.length < 6) { if (err) err.textContent = 'Password must be at least 6 characters.'; return; }
  if (pass1 !== pass2)            { if (err) err.textContent = 'Passwords do not match.'; return; }
  if (!sb)                        { if (err) err.textContent = 'Supabase is not connected.'; return; }

  if (submitBtn) submitBtn.disabled = true;
  if (btnText)   btnText.classList.add('hidden');
  if (spinner)   spinner.classList.remove('hidden');

  try {
    const { error } = await sb.auth.updateUser({ password: pass1 });
    if (error) { if (err) err.textContent = error.message || 'Failed to update password.'; return; }
    closeModal('#reset-password-overlay');
    showToast('Password updated! You are now signed in.', 'success');
    state.isAdmin = true;
    updateAdminUI();
  } catch (e) {
    if (err) err.textContent = 'Failed to update password. Please try again.';
  } finally {
    if (submitBtn) submitBtn.disabled = false;
    if (btnText)   btnText.classList.remove('hidden');
    if (spinner)   spinner.classList.add('hidden');
  }
}

function updateAdminUI() {
  const adminBtn = $('#admin-toggle-btn');

  if (adminBtn) {
    if (state.isAdmin) {
      adminBtn.innerHTML = '<i class="fas fa-shield-alt"></i> <span class="hide-mobile">Admin</span> <i class="fas fa-check-circle" style="color:#4ade80;margin-left:4px"></i>';
      adminBtn.title = 'Click to exit admin mode';
      adminBtn.classList.add('admin-active');
    } else {
      adminBtn.innerHTML = '<i class="fas fa-lock"></i> <span class="hide-mobile">Admin</span>';
      adminBtn.title = 'Click to enter admin mode';
      adminBtn.classList.remove('admin-active');
    }
  }

  // Use style.display so inline "display:none" is properly overridden
  $$('.admin-only').forEach(el => {
    el.style.display = state.isAdmin ? '' : 'none';
  });
  $$('.view-only').forEach(el => {
    el.style.display = state.isAdmin ? 'none' : '';
  });

  // Re-render current view to show/hide card/table action buttons
  if (state.filtered.length) renderCurrentView();
}

/* Guard: only run action if admin */
function requireAdmin(action) {
  if (state.isAdmin) { action(); return; }
  showToast('Enter admin mode first.', 'warning');
  openAdminLogin();
}

/* ============================================================
   7. NAVIGATION
   ============================================================ */
function navigateTo(viewName) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $$('.nav-item').forEach(n => n.classList.remove('active'));

  const viewEl  = $(`#${viewName}-view`);
  if (viewEl) viewEl.classList.add('active');

  const navItem = $(`.nav-item[data-view="${viewName}"]`);
  if (navItem) navItem.classList.add('active');

  state.currentView = viewName;

  const bc = $('#breadcrumb');
  if (bc) bc.innerHTML = {
    dashboard:    '<i class="fas fa-tachometer-alt"></i> Dashboard',
    transporters: '<i class="fas fa-truck"></i> Transporters',
    'lr-images':  '<i class="fas fa-images"></i> L.R. Images',
  }[viewName] || viewName;

  if (viewName === 'transporters') {
    const title = $('#transporters-page-title');
    const sub   = $('#transporters-page-subtitle');
    if (title) title.textContent = 'All Transporters';
    if (sub)   sub.textContent   = 'Manage your transport network';
    applyFilters();
  }

  if (viewName === 'lr-images') renderLrImagesView();

  if (window.innerWidth <= 900) closeSidebar();
}

function openSidebar()  { $('#sidebar').classList.add('open'); $('#sidebar-overlay').classList.add('open'); }
function closeSidebar() { $('#sidebar').classList.remove('open'); $('#sidebar-overlay').classList.remove('open'); }

/* ============================================================
   8. DATA — LOAD & CRUD
   ============================================================ */
async function loadTransporters() {
  try {
    if (!sb) { renderEmpty('Database not connected. Check your Supabase config in script.js.'); return; }
    const { data, error } = await sb
      .from(TABLE)
      .select('*')
      .order('created_at', { ascending: false });

    if (error) throw error;
    state.transporters = data || [];
    applyFilters();
    updateBadges();
    populatePlacesFilter();
  } catch (err) {
    console.error('Load error:', err);
    renderEmpty(err.message || 'Failed to load data.');
    showToast('Failed to load: ' + (err.message || ''), 'error');
  }
}

async function loadDashboard() {
  try {
    if (!sb) return;
    const { data } = await sb.from(TABLE).select('*');
    if (!data) return;

    const total  = data.length;
    const places = new Set(data.map(t => t.places).filter(Boolean)).size;
    const maps   = data.filter(t => t.map).length;
    const photos = data.filter(t => t.front_photo_url || t.back_photo_url).length;

    animateCount($('#stat-total'),   total);
    animateCount($('#stat-places'),  places);
    animateCount($('#stat-maps'),    maps);
    animateCount($('#stat-photos'),  photos);

    renderRecentList(data.slice(0, 5));
    renderPlacesChart(data);
  } catch (err) { console.error('Dashboard error:', err); }
}

function animateCount(el, target) {
  if (!el) return;
  let cur = 0;
  const step  = Math.ceil(target / 20) || 1;
  const timer = setInterval(() => {
    cur = Math.min(cur + step, target);
    el.textContent = cur.toLocaleString();
    if (cur >= target) clearInterval(timer);
  }, 40);
}

function renderRecentList(items) {
  const el = $('#recent-list');
  if (!el) return;
  if (!items.length) { el.innerHTML = '<p class="text-muted" style="padding:12px">No transporters yet.</p>'; return; }
  el.innerHTML = items.map(t => `
    <div class="recent-item" data-id="${t.id}">
      <div class="item-avatar">${getInitials(t.name)}</div>
      <div class="item-info">
        <span class="item-name">${escapeHtml(t.name)}</span>
        <span class="item-sub">${escapeHtml(t.places || '—')}</span>
      </div>
    </div>
  `).join('');
  $$('.recent-item', el).forEach(item => {
    on(item, 'click', () => {
      const t = state.transporters.find(x => x.id === item.dataset.id);
      if (t) openDetailModal(t);
    });
  });
}

function renderPlacesChart(data) {
  const el = $('#place-chart');
  if (!el) return;
  const counts = {};
  data.forEach(t => { if (t.places) counts[t.places] = (counts[t.places] || 0) + 1; });
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = sorted[0]?.[1] || 1;
  if (!sorted.length) { el.innerHTML = '<p class="text-muted" style="padding:12px">No data yet.</p>'; return; }
  el.innerHTML = sorted.map(([place, count]) => `
    <div class="state-bar-item">
      <span class="state-bar-label" title="${escapeHtml(place)}">${escapeHtml(place)}</span>
      <div class="state-bar-track">
        <div class="state-bar-fill" style="width:${(count / max) * 100}%"></div>
      </div>
      <span class="state-bar-count">${count}</span>
    </div>
  `).join('');
}

/* ---- CREATE / UPDATE ---- */
async function saveTransporter() {
  if (!validateForm()) return;

  const btn     = $('#transporter-form-submit');
  const btnText = btn.querySelector('.btn-text');
  const spinner = btn.querySelector('.btn-spinner');
  btnText.classList.add('hidden');
  spinner.classList.remove('hidden');
  btn.disabled = true;

  const payload = buildPayload();

  try {
    if (!sb) throw new Error('Supabase not initialized.');
    let result;
    if (state.editingId) {
      const { data, error } = await sb.from(TABLE).update(payload).eq('id', state.editingId).select().single();
      if (error) throw error;
      result = data;
      const idx = state.transporters.findIndex(t => t.id === state.editingId);
      if (idx >= 0) state.transporters[idx] = result;
      showToast('Transporter updated!', 'success');
    } else {
      const { data, error } = await sb.from(TABLE).insert(payload).select().single();
      if (error) throw error;
      result = data;
      state.transporters.unshift(result);
      showToast('Transporter added!', 'success');
    }
    closeModal('#transporter-modal-overlay');
    clearAutoSave();
    applyFilters();
    updateBadges();
    loadDashboard();
  } catch (err) {
    showToast('Save failed: ' + (err.message || ''), 'error');
    console.error('Save error:', err);
  } finally {
    btnText.classList.remove('hidden');
    spinner.classList.add('hidden');
    btn.disabled = false;
  }
}

function buildPayload() {
  return {
    name:            $('#form-name').value.trim(),
    gst:             $('#form-gst').value.trim().toUpperCase(),
    contact:         getContactsFromForm().length ? JSON.stringify(getContactsFromForm()) : null,
    places:          $('#form-places').value.trim(),
    map:             $('#form-map').value.trim(),
    front_photo_url: $('#form-front-photo-url').value || null,
    back_photo_url:  $('#form-back-photo-url').value  || null,
  };
}

/* ---- DELETE ---- */
async function deleteTransporter(id) {
  try {
    if (!sb) throw new Error('Supabase not initialized.');
    const t = state.transporters.find(x => x.id === id);
    if (t) {
      if (t.front_photo_url) {
        const p = storagePathFromUrl(t.front_photo_url, 'front');
        if (p) await sb.storage.from(BUCKETS.front).remove([p]);
      }
      if (t.back_photo_url) {
        const p = storagePathFromUrl(t.back_photo_url, 'back');
        if (p) await sb.storage.from(BUCKETS.back).remove([p]);
      }
    }
    const { error } = await sb.from(TABLE).delete().eq('id', id);
    if (error) throw error;
    state.transporters = state.transporters.filter(x => x.id !== id);
    applyFilters();
    updateBadges();
    loadDashboard();
    closeModal('#detail-modal-overlay');
    showToast('Transporter deleted.', 'success');
  } catch (err) {
    showToast('Delete failed: ' + (err.message || ''), 'error');
  }
}

/* ============================================================
   9. SEARCH, FILTER, SORT, PAGINATE
   ============================================================ */
function applyFilters() {
  let list = [...state.transporters];

  if (state.placesFilter) {
    list = list.filter(t => (t.places || '').toLowerCase().includes(state.placesFilter.toLowerCase()));
  }

  const q = state.searchQuery.toLowerCase().trim();
  if (q) {
    list = list.filter(t =>
      (t.name    || '').toLowerCase().includes(q) ||
      (t.gst     || '').toLowerCase().includes(q) ||
      (t.places  || '').toLowerCase().includes(q) ||
      getContactsArray(t).some(c => c.toLowerCase().includes(q))
    );
  }

  list.sort((a, b) => {
    switch (state.sortOrder) {
      case 'az':     return (a.name || '').localeCompare(b.name || '');
      case 'za':     return (b.name || '').localeCompare(a.name || '');
      case 'oldest': return new Date(a.created_at) - new Date(b.created_at);
      default:       return new Date(b.created_at) - new Date(a.created_at);
    }
  });

  state.filtered   = list;
  state.totalPages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  if (state.currentPage > state.totalPages) state.currentPage = 1;

  renderCurrentView();
  renderPagination();
  renderResultsInfo(list.length);
}

function renderCurrentView() {
  const page  = state.currentPage;
  const start = (page - 1) * PER_PAGE;
  const items = state.filtered.slice(start, start + PER_PAGE);

  if (!items.length) {
    renderEmpty(state.searchQuery || state.placesFilter
      ? 'No transporters match your search.'
      : 'No transporters yet. Admin can add transporters.');
    return;
  }
  hide($('#empty-state'));

  if (state.viewMode === 'card') renderCards(items);
  else renderTable(items);
}

function renderEmpty(msg = '') {
  show($('#empty-state'));
  const msgEl = $('#empty-state-msg');
  if (msgEl && msg) msgEl.textContent = msg;
  const grid  = $('#card-view');
  const table = $('#table-view');
  if (grid) grid.innerHTML = '';
  if (table) hide(table);
}

function renderCards(items) {
  const grid = $('#card-view');
  if (!grid) return;
  hide($('#table-view'));
  show(grid);

  grid.innerHTML = items.map(t => buildTransporterCard(t)).join('');

  $$('.transporter-card', grid).forEach(card => {
    const id = card.dataset.id;
    on(card, 'click', e => {
      if (e.target.closest('.card-action-btn')) return;
      const t = state.transporters.find(x => x.id === id);
      if (t) openDetailModal(t);
    });
  });
  $$('.card-edit-btn', grid).forEach(btn => {
    on(btn, 'click', e => { e.stopPropagation(); requireAdmin(() => openEditModal(btn.dataset.id)); });
  });
  $$('.card-delete-btn', grid).forEach(btn => {
    on(btn, 'click', e => { e.stopPropagation(); requireAdmin(() => confirmDelete(btn.dataset.id, btn.dataset.name)); });
  });
}

function buildTransporterCard(t) {
  const adminActions = state.isAdmin ? `
    <button class="card-action-btn card-edit-btn" data-id="${t.id}" title="Edit"><i class="fas fa-edit"></i></button>
    <button class="card-action-btn danger card-delete-btn" data-id="${t.id}" data-name="${escapeHtml(t.name)}" title="Delete"><i class="fas fa-trash"></i></button>
  ` : '';

  const photoUrl = t.front_photo_url || t.back_photo_url || '';
  const avatarHtml = photoUrl
    ? `<img src="${escapeHtml(photoUrl)}" alt="LR photo" class="card-thumb" loading="lazy"
         onclick="event.stopPropagation();openZoom('${escapeHtml(photoUrl)}')"
         onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" />
       <div class="card-avatar" style="display:none">${getInitials(t.name)}</div>`
    : `<div class="card-avatar">${getInitials(t.name)}</div>`;

  const contacts = getContactsArray(t);
  const contactRowsHtml = contacts.map(c => `
    <div class="card-contact-row"><i class="fas fa-phone"></i><a href="tel:${escapeHtml(c)}" onclick="event.stopPropagation()">${escapeHtml(c)}</a></div>
  `).join('');
  const contactActionsHtml = contacts.map(c => `
    <button class="card-action-btn" onclick="event.stopPropagation();window.open('tel:${escapeHtml(c)}')" title="Call ${escapeHtml(c)}"><i class="fas fa-phone"></i></button>
    <button class="card-action-btn" onclick="event.stopPropagation();window.open('https://wa.me/${cleanPhone(c)}')" title="WhatsApp ${escapeHtml(c)}"><i class="fab fa-whatsapp"></i></button>
  `).join('');

  return `
    <div class="transporter-card glass-card" data-id="${t.id}">
      <div class="card-top">
        ${avatarHtml}
        <div class="card-badges"></div>
      </div>
      <div class="card-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</div>
      ${t.gst    ? `<div class="card-gst">${escapeHtml(t.gst)}</div>` : ''}
      ${t.places ? `<div class="card-location"><i class="fas fa-map-marker-alt"></i>${escapeHtml(t.places)}</div>` : ''}

      <div class="card-divider"></div>
      ${contactRowsHtml}

      <div class="card-actions">
        ${contactActionsHtml}
        ${t.map    ? `<button class="card-action-btn" onclick="event.stopPropagation();window.open('${escapeHtml(t.map)}')" title="Maps"><i class="fas fa-map-marker-alt"></i></button>` : ''}
        ${adminActions}
      </div>
    </div>
  `;
}

function renderTable(items) {
  const tbody = $('#transporters-table-body');
  const table = $('#table-view');
  const grid  = $('#card-view');
  if (!tbody || !table) return;
  grid && hide(grid);
  show(table);

  const start = (state.currentPage - 1) * PER_PAGE;
  tbody.innerHTML = items.map((t, i) => `
    <tr>
      <td>${start + i + 1}</td>
      <td>
        <div style="display:flex;align-items:center;gap:8px">
          <div class="item-avatar" style="width:30px;height:30px;font-size:.65rem">${getInitials(t.name)}</div>
          <span class="table-name">${escapeHtml(t.name)}</span>
        </div>
      </td>
      <td><span class="table-gst">${escapeHtml(t.gst || '—')}</span></td>
      <td>${escapeHtml(t.places || '—')}</td>
      <td>${getContactsArray(t).length ? getContactsArray(t).map(c => `<a href="tel:${escapeHtml(c)}">${escapeHtml(c)}</a>`).join(', ') : '—'}</td>
      <td class="hide-mobile">${formatDate(t.created_at)}</td>
      <td>
        <div class="table-actions">
          <button class="table-action-btn view-btn-row" data-id="${t.id}" title="View"><i class="fas fa-eye"></i></button>
          ${state.isAdmin ? `
          <button class="table-action-btn edit-btn-row" data-id="${t.id}" title="Edit"><i class="fas fa-edit"></i></button>
          <button class="table-action-btn danger delete-btn-row" data-id="${t.id}" data-name="${escapeHtml(t.name)}" title="Delete"><i class="fas fa-trash"></i></button>
          ` : ''}
        </div>
      </td>
    </tr>
  `).join('');

  $$('.view-btn-row', tbody).forEach(btn => {
    on(btn, 'click', () => { const t = state.transporters.find(x => x.id === btn.dataset.id); if (t) openDetailModal(t); });
  });
  $$('.edit-btn-row', tbody).forEach(btn => { on(btn, 'click', () => requireAdmin(() => openEditModal(btn.dataset.id))); });
  $$('.delete-btn-row', tbody).forEach(btn => { on(btn, 'click', () => requireAdmin(() => confirmDelete(btn.dataset.id, btn.dataset.name))); });
}

function renderPagination() {
  const el   = $('#pagination');
  const info = $('#pagination-info');
  if (!el) return;
  const total = state.filtered.length;
  const start = (state.currentPage - 1) * PER_PAGE + 1;
  const end   = Math.min(state.currentPage * PER_PAGE, total);
  if (info) info.textContent = total ? `Showing ${start}–${end} of ${total}` : '';
  if (state.totalPages <= 1) { el.innerHTML = ''; return; }

  let html = `<button class="page-btn" id="pg-prev" ${state.currentPage <= 1 ? 'disabled' : ''}><i class="fas fa-chevron-left"></i></button>`;
  getPaginationRange(state.currentPage, state.totalPages).forEach(p => {
    if (p === '...') html += `<button class="page-btn" disabled>…</button>`;
    else html += `<button class="page-btn ${p === state.currentPage ? 'active' : ''}" data-page="${p}">${p}</button>`;
  });
  html += `<button class="page-btn" id="pg-next" ${state.currentPage >= state.totalPages ? 'disabled' : ''}><i class="fas fa-chevron-right"></i></button>`;
  el.innerHTML = html;

  $$('.page-btn[data-page]', el).forEach(btn => {
    on(btn, 'click', () => { state.currentPage = parseInt(btn.dataset.page); renderCurrentView(); renderPagination(); });
  });
  const prev = $('#pg-prev', el);
  const next = $('#pg-next', el);
  if (prev) on(prev, 'click', () => { if (state.currentPage > 1) { state.currentPage--; renderCurrentView(); renderPagination(); }});
  if (next) on(next, 'click', () => { if (state.currentPage < state.totalPages) { state.currentPage++; renderCurrentView(); renderPagination(); }});
}

function getPaginationRange(cur, total) {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  if (cur <= 3)        return [1, 2, 3, 4, '...', total];
  if (cur >= total - 2) return [1, '...', total - 3, total - 2, total - 1, total];
  return [1, '...', cur - 1, cur, cur + 1, '...', total];
}

/* ============================================================
   L.R. IMAGES GALLERY VIEW
   ============================================================ */
function renderLrImagesView() {
  populateLrUploadTransporterSelect();

  const grid  = $('#lr-images-grid');
  const empty = $('#lr-images-empty');
  if (!grid) return;

  const withPhotos = state.transporters.filter(t => t.front_photo_url || t.back_photo_url);

  if (!withPhotos.length) {
    grid.innerHTML = '';
    show(empty);
    return;
  }
  hide(empty);

  grid.innerHTML = withPhotos.map(t => `
    <div class="lr-group glass-card">
      <div class="lr-group-header">
        <div class="item-avatar" style="width:32px;height:32px;font-size:.7rem">${getInitials(t.name)}</div>
        <span class="lr-group-name">${escapeHtml(t.name)}</span>
      </div>
      <div class="lr-group-photos">
        ${t.front_photo_url ? buildLrPhotoItem(t.front_photo_url, 'Front') : ''}
        ${t.back_photo_url  ? buildLrPhotoItem(t.back_photo_url,  'Back')  : ''}
      </div>
    </div>
  `).join('');
}

function buildLrPhotoItem(url, side) {
  const safeUrl = escapeHtml(url);
  return `
    <div class="lr-photo-item">
      <img src="${safeUrl}" alt="${side} LR" loading="lazy"
           onclick="openZoom('${safeUrl}')"
           onerror="this.closest('.lr-photo-item').classList.add('lr-photo-broken')" />
      <div class="lr-photo-meta">
        <span class="lr-photo-side">${side} LR</span>
        <div class="lr-photo-url-row">
          <input type="text" class="lr-photo-url-input" readonly value="${safeUrl}" onclick="this.select()" />
          <button class="img-action-btn" onclick="copyToClipboard('${safeUrl}', this, 'URL copied!')" title="Copy URL">
            <i class="fas fa-copy"></i>
          </button>
        </div>
      </div>
    </div>
  `;
}

function populateLrUploadTransporterSelect() {
  const sel = $('#lr-upload-transporter');
  if (!sel) return;
  const current = sel.value;
  sel.innerHTML = '<option value="">Select Transporter</option>' +
    state.transporters.map(t => `<option value="${t.id}">${escapeHtml(t.name)}</option>`).join('');
  if (current) sel.value = current;
}

/* Uploads a photo from the L.R. Images page, auto-creating the bucket if it doesn't exist yet */
async function handleLrPageUpload() {
  const transporterId = $('#lr-upload-transporter')?.value;
  const side           = $('#lr-upload-side')?.value || 'front';
  const fileInput      = $('#lr-upload-file');
  const file            = fileInput?.files?.[0];

  if (!transporterId) { showToast('Select a transporter first.', 'warning'); return; }
  if (!file)           { showToast('Choose a photo file first.', 'warning'); return; }
  if (file.size > 5 * 1024 * 1024) { showToast('File too large. Max 5MB.', 'warning'); return; }

  const btn      = $('#lr-upload-btn');
  const progress = $('#lr-upload-progress');
  const fill     = $('#lr-upload-progress-fill');
  const text     = $('#lr-upload-progress-text');

  if (btn) btn.disabled = true;
  show(progress);
  if (fill) fill.style.width = '0%';

  try {
    if (!sb) throw new Error('Supabase not initialized.');
    const bucket = BUCKETS[side];
    const ext  = file.name.split('.').pop();
    const path = `lr-images/${side}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    let prog = 0;
    const pt = setInterval(() => {
      prog = Math.min(prog + 15, 85);
      if (fill) fill.style.width = `${prog}%`;
      if (text) text.textContent  = `Uploading… ${prog}%`;
    }, 200);

    let uploadRes = await sb.storage.from(bucket).upload(path, file, { upsert: true });

    // Bucket missing? Create it automatically (public, so photos load without extra policies) and retry.
    if (uploadRes.error && /bucket.*not.*found/i.test(uploadRes.error.message || '')) {
      const { error: createErr } = await sb.storage.createBucket(bucket, { public: true });
      if (createErr) throw createErr;
      showToast(`Bucket "${bucket}" created.`, 'info');
      uploadRes = await sb.storage.from(bucket).upload(path, file, { upsert: true });
    }
    clearInterval(pt);
    if (uploadRes.error) throw uploadRes.error;

    if (fill) fill.style.width = '100%';
    if (text) text.textContent  = 'Upload complete!';

    const { data: urlData } = sb.storage.from(bucket).getPublicUrl(path);
    const publicUrl = urlData?.publicUrl;

    const column = side === 'front' ? 'front_photo_url' : 'back_photo_url';
    const { data: updated, error: updateErr } = await sb
      .from(TABLE).update({ [column]: publicUrl }).eq('id', transporterId).select().single();
    if (updateErr) throw updateErr;

    const idx = state.transporters.findIndex(t => t.id === transporterId);
    if (idx >= 0) state.transporters[idx] = updated;

    hide(progress);
    if (fileInput) fileInput.value = '';
    showToast('Photo uploaded successfully!', 'success');
    renderLrImagesView();
    updateBadges();
  } catch (err) {
    hide(progress);
    showToast('Upload failed: ' + (err.message || ''), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function renderResultsInfo(count) {
  const el = $('#results-count');
  if (!el) return;
  const parts = [];
  if (state.searchQuery) parts.push(`"${state.searchQuery}"`);
  if (state.placesFilter) parts.push(state.placesFilter);
  el.textContent = `${count} transporter${count !== 1 ? 's' : ''} found${parts.length ? ' for ' + parts.join(' + ') : ''}`;

  const af = $('#active-filters');
  if (!af) return;
  af.innerHTML = '';
  if (state.searchQuery) {
    const tag = document.createElement('span');
    tag.className = 'filter-tag';
    tag.innerHTML = `Search: ${escapeHtml(state.searchQuery)} <i class="fas fa-times"></i>`;
    on(tag, 'click', () => { state.searchQuery = ''; $('#table-search').value = ''; hide($('#clear-table-search')); applyFilters(); });
    af.appendChild(tag);
  }
  if (state.placesFilter) {
    const tag = document.createElement('span');
    tag.className = 'filter-tag';
    tag.innerHTML = `Place: ${escapeHtml(state.placesFilter)} <i class="fas fa-times"></i>`;
    on(tag, 'click', () => { state.placesFilter = ''; $('#places-filter').value = ''; applyFilters(); });
    af.appendChild(tag);
  }
}

function populatePlacesFilter() {
  const el = $('#places-filter');
  if (!el) return;
  const places  = [...new Set(state.transporters.map(t => t.places).filter(Boolean))].sort();
  const current = el.value;
  el.innerHTML  = '<option value="">All Places</option>' + places.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  el.value = current;
}

function updateBadges() {
  const tb = $('#total-count-badge');
  if (tb) tb.textContent = state.transporters.length;
}

/* ============================================================
   10. ADD / EDIT MODAL
   ============================================================ */
function openAddModal() {
  requireAdmin(() => {
    state.editingId = null;
    resetForm();
    const title = $('#modal-title');
    if (title) title.textContent = 'Add Transporter';
    const submitText = $('#transporter-form-submit .btn-text');
    if (submitText) submitText.textContent = 'Save Transporter';
    openModal('#transporter-modal-overlay');
  });
}

function openEditModal(id) {
  const t = state.transporters.find(x => x.id === id);
  if (!t) return;
  state.editingId = id;
  resetForm();
  populateForm(t);
  const title = $('#modal-title');
  if (title) title.textContent = 'Edit Transporter';
  const submitText = $('#transporter-form-submit .btn-text');
  if (submitText) submitText.textContent = 'Update Transporter';
  openModal('#transporter-modal-overlay');
}

function resetForm() {
  $('#transporter-form') && $('#transporter-form').reset();
  ['form-id', 'form-front-photo-url', 'form-back-photo-url'].forEach(id => {
    const el = $(`#${id}`);
    if (el) el.value = '';
  });
  resetImageUpload('front');
  resetImageUpload('back');
  $$('.field-error').forEach(el => { el.textContent = ''; });
  hide($('#auto-save-indicator'));
  clearAutoSave();

  // Reset contact numbers to a single empty row
  const list = $('#contacts-list');
  if (list) { list.innerHTML = ''; addContactRow(); }
}

function populateForm(t) {
  const fields = {
    'form-name':    t.name,
    'form-gst':     t.gst,
    'form-places':  t.places,
    'form-map':     t.map,
  };
  Object.entries(fields).forEach(([id, val]) => {
    const el = $(`#${id}`);
    if (el) el.value = val || '';
  });
  if (t.front_photo_url) { setImagePreview('front', t.front_photo_url); $('#form-front-photo-url').value = t.front_photo_url; }
  if (t.back_photo_url)  { setImagePreview('back',  t.back_photo_url);  $('#form-back-photo-url').value  = t.back_photo_url; }

  // Populate contact number rows (falls back to one empty row if none)
  const list = $('#contacts-list');
  if (list) {
    list.innerHTML = '';
    const contacts = getContactsArray(t);
    if (contacts.length) contacts.forEach(c => addContactRow(c));
    else addContactRow();
  }
}

/* ---- Dynamic contact number rows ---- */
function addContactRow(value = '') {
  const list = $('#contacts-list');
  if (!list) return;
  const row = document.createElement('div');
  row.className = 'contact-row';
  row.innerHTML = `
    <input type="tel" class="form-input contact-input" placeholder="e.g. 9876543210" maxlength="15" />
    <button type="button" class="contact-remove-btn" title="Remove number"><i class="fas fa-times"></i></button>
  `;
  const input = row.querySelector('.contact-input');
  input.value = value;
  on(input, 'input', scheduleAutoSave);
  on(row.querySelector('.contact-remove-btn'), 'click', () => removeContactRow(row));
  list.appendChild(row);
  updateContactRemoveButtons();
}

function removeContactRow(row) {
  const list = $('#contacts-list');
  if (!list) return;
  if (list.children.length <= 1) {
    // Keep at least one row — just clear it instead of removing
    const input = row.querySelector('.contact-input');
    if (input) input.value = '';
    return;
  }
  row.remove();
  updateContactRemoveButtons();
}

function updateContactRemoveButtons() {
  const list = $('#contacts-list');
  if (!list) return;
  const onlyOne = list.children.length <= 1;
  $$('.contact-remove-btn', list).forEach(btn => { btn.disabled = onlyOne; });
}

function getContactsFromForm() {
  return $$('.contact-input').map(el => el.value.trim()).filter(Boolean);
}

function resetImageUpload(side) {
  show($(`#${side}-lr-placeholder`));
  hide($(`#${side}-lr-preview`));
  hide($(`#${side}-lr-progress`));
  const input = $(`#${side}-lr-input`);
  if (input) input.value = '';
}

function setImagePreview(side, url) {
  const placeholder = $(`#${side}-lr-placeholder`);
  const preview     = $(`#${side}-lr-preview`);
  const img         = $(`#${side}-lr-img`);
  if (!preview || !img) return;
  img.src = url;
  hide(placeholder);
  show(preview);
}

/* ============================================================
   11. FORM VALIDATION
   ============================================================ */
function validateForm() {
  let valid = true;
  const name = $('#form-name').value.trim();
  if (!name) { setFieldError('err-name', 'Transporter name is required.'); valid = false; }
  else { setFieldError('err-name', ''); }

  const gst = $('#form-gst').value.trim().toUpperCase();
  if (gst && !validateGST(gst)) { setFieldError('err-gst', 'Invalid GST. Format: 22AAAAA0000A1Z5 (15 chars)'); valid = false; }
  else { setFieldError('err-gst', ''); }

  const contactInputs = $$('.contact-input');
  let contactError = '';
  contactInputs.forEach(el => {
    const val = el.value.trim();
    if (val && !validatePhone(val)) { contactError = 'Enter valid 10-digit phone numbers.'; valid = false; }
  });
  setFieldError('err-contact', contactError);

  if (!valid) showToast('Please fix the validation errors.', 'warning');
  return valid;
}

function setFieldError(id, msg) { const el = $(`#${id}`); if (el) el.textContent = msg; }
function validateGST(gst)   { return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gst); }
function validatePhone(ph)  { return /^[6-9][0-9]{9}$/.test(ph.replace(/[\s\-+()]/g, '')); }

/* ============================================================
   12. IMAGE UPLOAD
   ============================================================ */
async function handleImageUpload(side, file) {
  if (!file) return;
  if (file.size > 5 * 1024 * 1024) { showToast('File too large. Max 5MB.', 'warning'); return; }

  const progress     = $(`#${side}-lr-progress`);
  const progressFill = $(`#${side}-lr-progress-fill`);
  const progressText = $(`#${side}-lr-progress-text`);
  const placeholder  = $(`#${side}-lr-placeholder`);
  const preview      = $(`#${side}-lr-preview`);

  hide(placeholder);
  hide(preview);
  show(progress);
  if (progressFill) progressFill.style.width = '0%';

  try {
    if (!sb) throw new Error('Supabase not initialized.');
    const ext  = file.name.split('.').pop();
    const path = `lr-images/${side}-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

    let prog = 0;
    const pt = setInterval(() => {
      prog = Math.min(prog + 15, 85);
      if (progressFill) progressFill.style.width = `${prog}%`;
      if (progressText) progressText.textContent  = `Uploading… ${prog}%`;
    }, 200);

    const { data, error } = await sb.storage.from(BUCKETS[side]).upload(path, file, { upsert: true });
    clearInterval(pt);
    if (error) throw error;

    if (progressFill) progressFill.style.width = '100%';
    if (progressText) progressText.textContent  = 'Upload complete!';

    const { data: urlData } = sb.storage.from(BUCKETS[side]).getPublicUrl(path);
    const publicUrl = urlData?.publicUrl;

    $(`#form-${side}-photo-url`).value = publicUrl;
    setImagePreview(side, publicUrl);
    hide(progress);
    showToast(`${side === 'front' ? 'Front' : 'Back'} photo uploaded!`, 'success');
  } catch (err) {
    hide(progress);
    show(placeholder);
    showToast('Upload failed: ' + (err.message || ''), 'error');
  }
}

async function deleteImage(side) {
  const urlInput = $(`#form-${side}-photo-url`);
  const url = urlInput?.value;
  if (url && sb) {
    const path = storagePathFromUrl(url, side);
    if (path) await sb.storage.from(BUCKETS[side]).remove([path]);
  }
  if (urlInput) urlInput.value = '';
  resetImageUpload(side);
  showToast('Image removed.', 'info');
}

function storagePathFromUrl(url, side) {
  if (!url) return null;
  try {
    const parts = new URL(url).pathname.split(`/storage/v1/object/public/${BUCKETS[side]}/`);
    return parts[1] || null;
  } catch { return null; }
}

/* ============================================================
   13. DETAIL MODAL
   ============================================================ */
function openDetailModal(t) {
  state.detailTransporter = t;
  const body  = $('#detail-modal-body');
  const title = $('#detail-modal-title');
  if (!body || !title) return;
  title.textContent = t.name;

  // Show/hide admin buttons in detail modal header
  const editBtn   = $('#detail-edit-btn');
  const deleteBtn = $('#detail-delete-btn');
  if (editBtn)   { state.isAdmin ? show(editBtn)   : hide(editBtn); }
  if (deleteBtn) { state.isAdmin ? show(deleteBtn) : hide(deleteBtn); }

  const contacts = getContactsArray(t);
  const primaryContact = contacts[0] || '';

  body.innerHTML = `
    <!-- Action Bar -->
    <div class="detail-action-bar">
      ${primaryContact ? `<button class="detail-action-btn" onclick="window.open('tel:${escapeHtml(primaryContact)}')"><i class="fas fa-phone"></i> Call</button>` : ''}
      ${primaryContact ? `<button class="detail-action-btn whatsapp" onclick="window.open('https://wa.me/${cleanPhone(primaryContact)}')"><i class="fab fa-whatsapp"></i> WhatsApp</button>` : ''}
      ${t.map     ? `<button class="detail-action-btn maps" onclick="window.open('${escapeHtml(t.map)}')"><i class="fas fa-map-marker-alt"></i> Maps</button>` : ''}
      <button class="detail-action-btn copy-all" id="copy-all-btn"><i class="fas fa-copy"></i> Copy All</button>
      <button class="detail-action-btn" id="qr-gen-btn"><i class="fas fa-qrcode"></i> QR Code</button>
      <button class="detail-action-btn" id="print-btn"><i class="fas fa-print"></i> Print</button>
    </div>

    <div style="padding:var(--gap-lg)">
      <div class="detail-grid">
        <!-- Left -->
        <div>
          <div class="detail-section">
            <div class="detail-section-title"><i class="fas fa-info-circle"></i> Basic Info</div>

            <div class="detail-field">
              <div class="detail-label">Transporter Name</div>
              <div class="detail-value">
                <span>${escapeHtml(t.name)}</span>
                <button class="copy-btn" data-copy="${escapeHtml(t.name)}" title="Copy"><i class="fas fa-copy"></i></button>
              </div>
            </div>

            ${t.gst ? `
            <div class="detail-field">
              <div class="detail-label">GST Number</div>
              <div class="detail-value">
                <span class="detail-gst">${escapeHtml(t.gst)}</span>
                <button class="copy-btn" data-copy="${escapeHtml(t.gst)}" title="Copy GST"><i class="fas fa-copy"></i></button>
              </div>
            </div>` : ''}

            <div class="detail-field">
              <div class="detail-label">Added On</div>
              <div class="detail-value">${formatDate(t.created_at, true)}</div>
            </div>
          </div>

          <div class="detail-section">
            <div class="detail-section-title"><i class="fas fa-phone-alt"></i> Contact${contacts.length > 1 ? ' Numbers' : ''}</div>

            ${contacts.length ? `
            <div class="detail-field">
              <div class="detail-label">${contacts.length > 1 ? `Phone / Contact (${contacts.length})` : 'Phone / Contact'}</div>
              ${contacts.map(c => `
              <div class="detail-contact-row">
                <a href="tel:${escapeHtml(c)}">${escapeHtml(c)}</a>
                <button class="detail-action-btn whatsapp" style="padding:4px 8px;font-size:.75rem" onclick="window.open('https://wa.me/${cleanPhone(c)}')" title="WhatsApp"><i class="fab fa-whatsapp"></i></button>
                <button class="copy-btn" data-copy="${escapeHtml(c)}" title="Copy"><i class="fas fa-copy"></i></button>
              </div>`).join('')}
            </div>` : ''}
          </div>
        </div>

        <!-- Right -->
        <div>
          ${t.places || t.map ? `
          <div class="detail-section">
            <div class="detail-section-title"><i class="fas fa-map-marker-alt"></i> Location</div>
            ${t.places ? `
            <div class="detail-field">
              <div class="detail-label">Place</div>
              <div class="detail-value">
                <span>${escapeHtml(t.places)}</span>
                <button class="copy-btn" data-copy="${escapeHtml(t.places)}" title="Copy"><i class="fas fa-copy"></i></button>
              </div>
            </div>` : ''}
            ${t.map ? `
            <div class="detail-field">
              <div class="detail-label">Google Maps</div>
              <div class="detail-value">
                <a href="${escapeHtml(t.map)}" target="_blank" rel="noopener" style="font-size:.8rem;word-break:break-all">${escapeHtml(t.map.length > 50 ? t.map.substring(0, 50) + '…' : t.map)}</a>
                <button class="copy-btn" data-copy="${escapeHtml(t.map)}" title="Copy link"><i class="fas fa-copy"></i></button>
              </div>
            </div>` : ''}
          </div>` : ''}

          <!-- QR placeholder -->
          <div class="detail-section" id="qr-section" style="display:none">
            <div class="detail-section-title"><i class="fas fa-qrcode"></i> QR Code</div>
            <div class="qr-container">
              <div id="qr-code-canvas"></div>
              <span class="qr-label">${escapeHtml(t.name)}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- LR Images -->
      ${t.front_photo_url || t.back_photo_url ? `
      <div class="detail-section">
        <div class="detail-section-title"><i class="fas fa-images"></i> LR Photos</div>
        <div class="lr-images">
          ${t.front_photo_url ? `
          <div class="lr-image-card" onclick="openZoom('${escapeHtml(t.front_photo_url)}')">
            <img src="${escapeHtml(t.front_photo_url)}" alt="Front LR" loading="lazy" />
            <div class="lr-image-label"><i class="fas fa-image"></i> Front LR</div>
          </div>` : ''}
          ${t.back_photo_url ? `
          <div class="lr-image-card" onclick="openZoom('${escapeHtml(t.back_photo_url)}')">
            <img src="${escapeHtml(t.back_photo_url)}" alt="Back LR" loading="lazy" />
            <div class="lr-image-label"><i class="fas fa-image"></i> Back LR</div>
          </div>` : ''}
        </div>
      </div>` : ''}
    </div>
  `;

  $$('.copy-btn', body).forEach(btn => {
    on(btn, 'click', () => copyToClipboard(btn.dataset.copy, btn));
  });

  const copyAllBtn = $('#copy-all-btn');
  if (copyAllBtn) on(copyAllBtn, 'click', () => copyToClipboard(buildCopyAll(t), copyAllBtn, 'All details copied!'));

  const qrBtn = $('#qr-gen-btn');
  if (qrBtn) on(qrBtn, 'click', () => generateQR(t));

  const printBtn = $('#print-btn');
  if (printBtn) on(printBtn, 'click', () => printTransporter(t));

  openModal('#detail-modal-overlay');
}

function buildCopyAll(t) {
  const lines = [`Transporter: ${t.name}`];
  if (t.gst) lines.push(`GST: ${t.gst}`);
  const contacts = getContactsArray(t);
  if (contacts.length) lines.push(`Contact: ${contacts.join(', ')}`);
  if (t.places)  lines.push(`Place: ${t.places}`);
  if (t.map)     lines.push(`Maps: ${t.map}`);
  return lines.join('\n');
}

function generateQR(t) {
  const qrSection = $('#qr-section');
  const qrCanvas  = $('#qr-code-canvas');
  if (!qrSection || !qrCanvas) return;
  qrCanvas.innerHTML = '';
  try {
    new QRCode(qrCanvas, {
      text: buildCopyAll(t).substring(0, 500),
      width: 160, height: 160,
      colorDark:  document.documentElement.getAttribute('data-theme') === 'dark' ? '#ffffff' : '#000000',
      colorLight: 'transparent',
      correctLevel: QRCode.CorrectLevel.M,
    });
    qrSection.style.display = 'block';
    showToast('QR Code generated!', 'success');
  } catch { showToast('QR generation failed.', 'error'); }
}

/* ============================================================
   14. COPY TO CLIPBOARD
   ============================================================ */
async function copyToClipboard(text, btnEl = null, successMsg = 'Copied!') {
  try {
    await navigator.clipboard.writeText(text);
    showToast(successMsg, 'success');
    if (btnEl) {
      const original = btnEl.innerHTML;
      btnEl.innerHTML = '<i class="fas fa-check"></i>';
      btnEl.classList.add('copied');
      setTimeout(() => { btnEl.innerHTML = original; btnEl.classList.remove('copied'); }, 2000);
    }
  } catch {
    const el = document.createElement('textarea');
    el.value = text;
    el.style.cssText = 'position:fixed;left:-9999px;top:-9999px';
    document.body.appendChild(el);
    el.select();
    document.execCommand('copy');
    el.remove();
    showToast(successMsg, 'success');
  }
}

/* ============================================================
   15. CONFIRM (generic + delete)
   ============================================================ */
function confirmDelete(id, name) {
  const msg = $('#confirm-message');
  if (msg) msg.textContent = `Are you sure you want to delete "${name}"? This cannot be undone.`;
  state.confirmCallback = () => deleteTransporter(id);
  openModal('#confirm-modal-overlay');
}

function confirmAction(title, message, callback) {
  const titleEl = $('#confirm-title');
  const msgEl   = $('#confirm-message');
  if (titleEl) titleEl.textContent = title;
  if (msgEl)   msgEl.textContent   = message;
  state.confirmCallback = callback;
  openModal('#confirm-modal-overlay');
}

/* ============================================================
   16. EXPORT
   ============================================================ */
function exportCSV(items = null) {
  const data = items || state.filtered;
  if (!data.length) { showToast('No data to export.', 'warning'); return; }
  const headers = ['Name', 'GST', 'Contact', 'Place', 'Maps Link', 'Added On'];
  const rows = data.map(t => [
    t.name, t.gst, getContactsArray(t).join(', '), t.places, t.map, formatDate(t.created_at, true)
  ].map(v => `"${(v || '').toString().replace(/"/g, '""')}"`));
  downloadFile([headers.join(','), ...rows.map(r => r.join(','))].join('\n'), `transporters-${dateStamp()}.csv`, 'text/csv');
  showToast('CSV exported!', 'success');
}

function exportExcel(items = null) {
  if (!window.XLSX) { showToast('Excel library not loaded.', 'error'); return; }
  const data = items || state.filtered;
  if (!data.length) { showToast('No data to export.', 'warning'); return; }
  const rows = data.map(t => ({
    'Name': t.name, 'GST': t.gst, 'Contact': getContactsArray(t).join(', '),
    'Place': t.places, 'Maps Link': t.map,
    'Added On': formatDate(t.created_at, true)
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [22, 18, 16, 18, 40, 16].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Transporters');
  XLSX.writeFile(wb, `transporters-${dateStamp()}.xlsx`);
  showToast('Excel exported!', 'success');
}

function exportPDF(items = null) {
  if (!window.jspdf) { showToast('PDF library not loaded.', 'error'); return; }
  const data = items || state.filtered;
  if (!data.length) { showToast('No data to export.', 'warning'); return; }
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  doc.setFontSize(18); doc.setTextColor(99, 102, 241);
  doc.text('TransportPro — Transporter List', 14, 16);
  doc.setFontSize(9); doc.setTextColor(100, 100, 100);
  doc.text(`Generated: ${new Date().toLocaleString()} | Total: ${data.length}`, 14, 22);
  const columns = [
    { header: '#',       dataKey: 'no' },
    { header: 'Name',    dataKey: 'name' },
    { header: 'GST',     dataKey: 'gst' },
    { header: 'Contact', dataKey: 'contact' },
    { header: 'Place',   dataKey: 'place' },
    { header: 'Added',   dataKey: 'date' },
  ];
  const rows = data.map((t, i) => ({
    no: i + 1, name: t.name, gst: t.gst || '—',
    contact: getContactsArray(t).join(', ') || '—', place: t.places || '—',
    date: formatDate(t.created_at),
  }));
  doc.autoTable({
    head: [columns.map(c => c.header)],
    body: rows.map(r => columns.map(c => r[c.dataKey])),
    startY: 26,
    styles: { fontSize: 8, cellPadding: 3 },
    headStyles: { fillColor: [99, 102, 241], textColor: 255, fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [245, 247, 255] },
    margin: { left: 14, right: 14 },
  });
  doc.save(`transporters-${dateStamp()}.pdf`);
  showToast('PDF exported!', 'success');
}

function printTransporter(t) {
  const content = `
    <!DOCTYPE html><html><head>
    <title>Transporter: ${escapeHtml(t.name)}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #111; }
      h1 { color: #6366f1; margin-bottom: 4px; }
      table { width: 100%; border-collapse: collapse; margin-top: 16px; }
      th { text-align: left; background: #f8fafc; padding: 8px 12px; font-size: 11px; text-transform: uppercase; color: #888; border-bottom: 1px solid #eee; }
      td { padding: 10px 12px; border-bottom: 1px solid #f0f0f0; font-size: 13px; }
      .footer { margin-top: 24px; font-size: 11px; color: #aaa; border-top: 1px solid #eee; padding-top: 12px; }
    </style></head><body>
    <h1>${escapeHtml(t.name)}</h1>
    <table>
      ${t.gst     ? `<tr><th>GST Number</th><td>${escapeHtml(t.gst)}</td></tr>` : ''}
      ${getContactsArray(t).length ? `<tr><th>Contact / Phone</th><td>${escapeHtml(getContactsArray(t).join(', '))}</td></tr>` : ''}
      ${t.places  ? `<tr><th>Place</th><td>${escapeHtml(t.places)}</td></tr>` : ''}
      ${t.map     ? `<tr><th>Maps Link</th><td>${escapeHtml(t.map)}</td></tr>` : ''}
      <tr><th>Added On</th><td>${formatDate(t.created_at, true)}</td></tr>
    </table>
    <div class="footer">Printed via TransportPro &bull; ${new Date().toLocaleString()}</div>
    </body></html>
  `;
  const win = window.open('', '_blank');
  win.document.write(content);
  win.document.close();
  win.onload = () => { win.focus(); win.print(); };
}

function downloadFile(content, filename, type) {
  const blob = new Blob([content], { type });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/* ============================================================
   17. IMAGE ZOOM
   ============================================================ */
function openZoom(url) {
  const overlay = $('#image-zoom-overlay');
  const img     = $('#zoom-img');
  if (!overlay || !img) return;
  img.src = url;
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
}
window.openZoom = openZoom;

function closeZoom() {
  const overlay = $('#image-zoom-overlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  document.body.style.overflow = '';
  const img = $('#zoom-img');
  if (img) img.src = '';
}

/* ============================================================
   18. GLOBAL SEARCH SUGGESTIONS
   ============================================================ */
let searchDebounce = null;

function handleGlobalSearch(query) {
  const suggestions = $('#search-suggestions');
  if (!suggestions) return;
  if (!query || query.length < 2) { suggestions.classList.remove('show'); return; }

  const q     = query.toLowerCase();
  const found = state.transporters.filter(t =>
    (t.name    || '').toLowerCase().includes(q) ||
    (t.gst     || '').toLowerCase().includes(q) ||
    (t.places  || '').toLowerCase().includes(q) ||
    getContactsArray(t).some(c => c.toLowerCase().includes(q))
  ).slice(0, 6);

  if (!found.length) {
    suggestions.innerHTML = '<div class="suggestion-no-results">No results found</div>';
    suggestions.classList.add('show');
    return;
  }

  suggestions.innerHTML = found.map(t => `
    <div class="suggestion-item" data-id="${t.id}">
      <i class="fas fa-truck"></i>
      <div>
        <div class="suggestion-name">${escapeHtml(t.name)}</div>
        <div class="suggestion-sub">${escapeHtml(t.places || '')}</div>
      </div>
      <span class="suggestion-sub">${escapeHtml(t.gst || '')}</span>
    </div>
  `).join('');

  $$('.suggestion-item', suggestions).forEach(item => {
    on(item, 'click', () => {
      const t = state.transporters.find(x => x.id === item.dataset.id);
      if (t) { suggestions.classList.remove('show'); $('#global-search').value = ''; openDetailModal(t); }
    });
  });
  suggestions.classList.add('show');
}

/* ============================================================
   19. AUTO-SAVE
   ============================================================ */
function scheduleAutoSave() {
  clearAutoSave();
  const indicator = $('#auto-save-indicator');
  if (indicator) show(indicator);
  state.autoSaveTimer = setTimeout(() => {
    try { localStorage.setItem('tms-draft', JSON.stringify({ ...buildPayload(), editingId: state.editingId })); } catch {}
    if (indicator) hide(indicator);
  }, 1500);
}

function clearAutoSave() {
  if (state.autoSaveTimer) { clearTimeout(state.autoSaveTimer); state.autoSaveTimer = null; }
  try { localStorage.removeItem('tms-draft'); } catch {}
}

/* ============================================================
   20. UTILITIES
   ============================================================ */
function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').map(w => w[0]).join('').substring(0, 2).toUpperCase();
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatDate(iso, full = false) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  if (full) return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

function dateStamp() { return new Date().toISOString().slice(0, 10); }
function cleanPhone(ph) { return (ph || '').replace(/\D/g, ''); }

/* Parses the `contact` column into an array of numbers.
   Supports the new JSON-array format, and falls back to the old
   single-string / comma-separated format for existing records. */
function getContactsArray(t) {
  const raw = t && t.contact;
  if (!raw) return [];
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.map(v => String(v).trim()).filter(Boolean);
      } catch { /* fall through to legacy parsing */ }
    }
    return trimmed.split(',').map(s => s.trim()).filter(Boolean);
  }
  if (Array.isArray(raw)) return raw.map(v => String(v).trim()).filter(Boolean);
  return [];
}

/* ============================================================
   21. EVENT LISTENERS
   ============================================================ */
function bindEvents() {
  /* Theme */
  on($('#theme-toggle'), 'click', toggleTheme);

  /* Admin button */
  on($('#admin-toggle-btn'), 'click', openAdminLogin);

  /* Admin login modal */
  on($('#admin-login-form'), 'submit', e => { e.preventDefault(); handleAdminLogin(); });
  on($('#admin-login-cancel'), 'click', () => closeModal('#admin-login-overlay'));
  on($('#admin-login-overlay'), 'click', e => { if (e.target === $('#admin-login-overlay')) closeModal('#admin-login-overlay'); });

  /* Toggle password visibility */
  on($('#toggle-admin-password'), 'click', () => {
    const inp  = $('#admin-password-input');
    const icon = $('#toggle-admin-password i');
    if (!inp) return;
    if (inp.type === 'password') { inp.type = 'text'; icon.className = 'fas fa-eye-slash'; }
    else { inp.type = 'password'; icon.className = 'fas fa-eye'; }
  });
  on($('#toggle-new-password'), 'click', () => {
    const inp  = $('#new-password-input');
    const icon = $('#toggle-new-password i');
    if (!inp) return;
    if (inp.type === 'password') { inp.type = 'text'; icon.className = 'fas fa-eye-slash'; }
    else { inp.type = 'password'; icon.className = 'fas fa-eye'; }
  });

  /* Forgot / reset password */
  on($('#forgot-password-link'), 'click', e => { e.preventDefault(); openForgotPassword(); });
  on($('#forgot-password-form'), 'submit', e => { e.preventDefault(); handleForgotPassword(); });
  on($('#forgot-password-cancel'), 'click', () => { closeModal('#forgot-password-overlay'); openModal('#admin-login-overlay'); });
  on($('#forgot-password-overlay'), 'click', e => { if (e.target === $('#forgot-password-overlay')) closeModal('#forgot-password-overlay'); });
  on($('#reset-password-form'), 'submit', e => { e.preventDefault(); handleResetPassword(); });

  /* Sidebar */
  on($('#sidebar-toggle'),  'click', openSidebar);
  on($('#sidebar-close'),   'click', closeSidebar);
  on($('#sidebar-overlay'), 'click', closeSidebar);

  /* Nav items */
  $$('.nav-item[data-view]').forEach(item => {
    on(item, 'click', e => { e.preventDefault(); navigateTo(item.dataset.view); });
  });
  on($('#add-transporter-nav'), 'click', e => { e.preventDefault(); openAddModal(); closeSidebar(); });

  /* Add buttons */
  on($('#add-transporter-btn'),      'click', openAddModal);
  on($('#add-transporter-view-btn'), 'click', openAddModal);
  on($('#empty-add-btn'),            'click', openAddModal);

  /* LR Images page upload */
  on($('#lr-upload-btn'), 'click', () => requireAdmin(handleLrPageUpload));

  /* Dashboard links */
  $$('[data-view]').forEach(el => {
    if (el.tagName === 'A') on(el, 'click', e => { e.preventDefault(); navigateTo(el.dataset.view); });
    if (el.classList.contains('stat-card')) on(el, 'click', () => navigateTo(el.dataset.view));
  });
  on($('#refresh-dashboard-btn'), 'click', () => { loadDashboard(); showToast('Dashboard refreshed!', 'info'); });

  /* Quick actions */
  on($('#qa-add'),          'click', openAddModal);
  on($('#qa-export-csv'),   'click', () => exportCSV());
  on($('#qa-export-pdf'),   'click', () => exportPDF());
  on($('#qa-export-excel'), 'click', () => exportExcel());

  /* Transporter modal */
  on($('#transporter-modal-close'),  'click', () => closeModal('#transporter-modal-overlay'));
  on($('#transporter-modal-cancel'), 'click', () => closeModal('#transporter-modal-overlay'));
  on($('#transporter-form-submit'),  'click', saveTransporter);

  /* Detail modal */
  on($('#detail-modal-close'), 'click', () => closeModal('#detail-modal-overlay'));
  on($('#detail-edit-btn'), 'click', () => {
    if (state.detailTransporter) { closeModal('#detail-modal-overlay'); openEditModal(state.detailTransporter.id); }
  });
  on($('#detail-delete-btn'), 'click', () => {
    if (state.detailTransporter) confirmDelete(state.detailTransporter.id, state.detailTransporter.name);
  });

  /* Confirm modal */
  on($('#confirm-cancel'), 'click', () => closeModal('#confirm-modal-overlay'));
  on($('#confirm-ok'), 'click', () => {
    closeModal('#confirm-modal-overlay');
    if (state.confirmCallback) { state.confirmCallback(); state.confirmCallback = null; }
  });

  /* Image zoom */
  on($('#image-zoom-close'),   'click', closeZoom);
  on($('#image-zoom-overlay'), 'click', e => { if (e.target === $('#image-zoom-overlay')) closeZoom(); });

  /* Close on overlay click */
  ['#transporter-modal-overlay', '#detail-modal-overlay', '#confirm-modal-overlay'].forEach(id => {
    const el = $(id);
    if (el) on(el, 'click', e => { if (e.target === el) closeModal(id); });
  });

  /* Table search */
  const tableSearch = $('#table-search');
  if (tableSearch) {
    on(tableSearch, 'input', () => {
      const val = tableSearch.value.trim();
      state.searchQuery  = val;
      state.currentPage  = 1;
      const clearBtn = $('#clear-table-search');
      if (clearBtn) { val ? show(clearBtn) : hide(clearBtn); }
      applyFilters();
    });
  }
  on($('#clear-table-search'), 'click', () => {
    if ($('#table-search')) $('#table-search').value = '';
    state.searchQuery = ''; state.currentPage = 1;
    hide($('#clear-table-search'));
    applyFilters();
  });

  /* Global search */
  const globalSearch = $('#global-search');
  if (globalSearch) {
    on(globalSearch, 'input', () => {
      clearTimeout(searchDebounce);
      searchDebounce = setTimeout(() => handleGlobalSearch(globalSearch.value.trim()), 200);
    });
    on(globalSearch, 'blur', () => {
      setTimeout(() => { const sug = $('#search-suggestions'); if (sug) sug.classList.remove('show'); }, 200);
    });
  }

  /* Place filter */
  on($('#places-filter'), 'change', () => {
    state.placesFilter = $('#places-filter').value;
    state.currentPage = 1;
    applyFilters();
  });

  /* Sort */
  on($('#sort-select'), 'change', () => {
    state.sortOrder   = $('#sort-select').value;
    state.currentPage = 1;
    applyFilters();
  });

  /* View toggle */
  on($('#card-view-btn'), 'click', () => {
    state.viewMode = 'card';
    $('#card-view-btn').classList.add('active');
    $('#card-view-btn').setAttribute('aria-pressed', 'true');
    $('#table-view-btn').classList.remove('active');
    $('#table-view-btn').setAttribute('aria-pressed', 'false');
    renderCurrentView();
  });
  on($('#table-view-btn'), 'click', () => {
    state.viewMode = 'table';
    $('#table-view-btn').classList.add('active');
    $('#table-view-btn').setAttribute('aria-pressed', 'true');
    $('#card-view-btn').classList.remove('active');
    $('#card-view-btn').setAttribute('aria-pressed', 'false');
    renderCurrentView();
  });

  /* Export dropdown */
  on($('#export-btn'), 'click', e => {
    e.stopPropagation();
    const menu = $('#export-menu');
    if (menu) menu.classList.toggle('open');
  });
  on(document, 'click', () => { const menu = $('#export-menu'); if (menu) menu.classList.remove('open'); });
  on($('#export-csv-btn'),   'click', () => exportCSV());
  on($('#export-excel-btn'), 'click', () => exportExcel());
  on($('#export-pdf-btn'),   'click', () => exportPDF());

  /* Image upload zones */
  bindImageZone('front');
  bindImageZone('back');

  /* Contact numbers */
  on($('#add-contact-btn'), 'click', () => { addContactRow(); scheduleAutoSave(); });
  if ($('#contacts-list') && !$('#contacts-list').children.length) addContactRow();

  /* Auto-save */
  $$('#transporter-form input:not([type=hidden]), #transporter-form textarea').forEach(el => {
    on(el, 'input', scheduleAutoSave);
  });

  /* GST uppercase + validate */
  on($('#form-gst'), 'input', () => { $('#form-gst').value = $('#form-gst').value.toUpperCase(); });
  on($('#validate-gst-btn'), 'click', () => {
    const gst = $('#form-gst').value.trim().toUpperCase();
    if (!gst) { showToast('Enter a GST number first.', 'warning'); return; }
    if (validateGST(gst)) showToast('✓ Valid GST format!', 'success');
    else { showToast('✗ Invalid GST format.', 'error'); setFieldError('err-gst', 'Invalid GST format.'); }
  });

  /* Verify transporter on E-Way Bill portal */
  on($('#verify-transporter-btn'), 'click', () => {
    window.open('https://ewaybillgst.gov.in/Others/TransportersSearch.aspx', '_blank', 'noopener,noreferrer');
  });

  /* Keyboard shortcuts */
  on(document, 'keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      const gs = $('#global-search');
      if (gs) { gs.focus(); gs.select(); }
    }
    if (e.key === 'Escape') {
      ['#transporter-modal-overlay', '#detail-modal-overlay', '#confirm-modal-overlay',
       '#admin-login-overlay', '#forgot-password-overlay'].forEach(id => {
        const el = $(id);
        if (el && el.classList.contains('open')) closeModal(id);
      });
      closeZoom();
      const menu = $('#export-menu');
      if (menu) menu.classList.remove('open');
      const sug = $('#search-suggestions');
      if (sug) sug.classList.remove('show');
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
      if (state.isAdmin) { e.preventDefault(); openAddModal(); }
    }
  });
}

function bindImageZone(side) {
  const zone       = $(`#${side}-lr-zone`);
  const input      = $(`#${side}-lr-input`);
  const zoomBtn    = $(`#${side}-lr-zoom`);
  const replaceBtn = $(`#${side}-lr-replace`);
  const deleteBtn  = $(`#${side}-lr-delete`);

  if (!zone || !input) return;

  on(zone, 'click', e => {
    if (e.target.closest('.img-action-btn')) return;
    const preview = $(`#${side}-lr-preview`);
    if (preview && !preview.classList.contains('hidden')) return;
    input.click();
  });
  on(input, 'change', () => { if (input.files?.[0]) handleImageUpload(side, input.files[0]); });

  on(zone, 'dragover',  e => { e.preventDefault(); zone.classList.add('drag-over'); });
  on(zone, 'dragleave', () => zone.classList.remove('drag-over'));
  on(zone, 'drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    const file = e.dataTransfer.files?.[0];
    if (file) handleImageUpload(side, file);
  });

  if (zoomBtn)    on(zoomBtn,    'click', e => { e.stopPropagation(); openZoom($(`#${side}-lr-img`)?.src || ''); });
  if (replaceBtn) on(replaceBtn, 'click', e => { e.stopPropagation(); input.click(); });
  if (deleteBtn)  on(deleteBtn,  'click', e => { e.stopPropagation(); deleteImage(side); });
}

/* ============================================================
   22. INIT
   ============================================================ */
document.addEventListener('DOMContentLoaded', () => {
  initTheme();
  initAdminSession(); // restore Supabase session (calls updateAdminUI internally)
  checkForPasswordRecoveryLink(); // auto-opens reset modal when arriving from a recovery email link
  bindEvents();
  navigateTo('dashboard');
  loadDashboard();
  loadTransporters();
});







