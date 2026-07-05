// nav.js — shared nav helpers: messages unread badge + favorites helper.
// Include AFTER toast.js. Safe to include on any page (no-ops if elements absent).
(function () {
  const token = localStorage.getItem('token');

  // Reveal auth-only nav links if logged in
  if (token) {
    document.querySelectorAll('[data-auth-only]').forEach(el => el.style.display = '');
    const ml = document.getElementById('messagesLink');
    if (ml) ml.style.display = '';
  }

  // Poll unread message count -> badge
  async function refreshUnread() {
    if (!token) return;
    const badge = document.getElementById('msgBadge');
    if (!badge) return;
    try {
      const res = await fetch('/api/messages/unread-count', { headers: { Authorization: token } });
      const { count } = await res.json();
      if (count > 0) {
        badge.textContent = count;
        badge.style.cssText = 'display:inline-block;background:#A6192E;color:#fff;border-radius:10px;padding:1px 7px;font-size:11px;font-weight:700;margin-left:2px;';
      } else {
        badge.textContent = '';
        badge.style.display = 'none';
      }
    } catch {}
  }
  refreshUnread();
  if (token) setInterval(refreshUnread, 30000);

  // Expose a favorites toggle helper for grids
  window.favHelper = {
    ids: new Set(),
    async loadIds() {
      if (!token) return this.ids;
      try {
        const res = await fetch('/api/favorites/ids', { headers: { Authorization: token } });
        const arr = await res.json();
        this.ids = new Set(arr.map(String));
      } catch {}
      return this.ids;
    },
    async toggle(listingId) {
      if (!token) { toast('Please login to save listings', 'warning'); setTimeout(() => location.href = '/auth.html', 900); return null; }
      const has = this.ids.has(String(listingId));
      const method = has ? 'DELETE' : 'POST';
      try {
        const res = await fetch(`/api/favorites/${listingId}`, { method, headers: { Authorization: token } });
        if (!res.ok) throw new Error();
        if (has) { this.ids.delete(String(listingId)); } else { this.ids.add(String(listingId)); }
        return !has;
      } catch { toast('Failed to update saved', 'error'); return null; }
    },
  };
})();
