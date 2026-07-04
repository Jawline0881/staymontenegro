// ── Toast Notification System ─────────────────────────────────────────────────
// Usage: toast('Message')  /  toast('Message', 'success')  /  toast('Oops', 'error')
// Types: 'success' | 'error' | 'info' | 'warning'

(function () {
  // Inject styles once
  const style = document.createElement('style');
  style.textContent = `
    #toast-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none;
    }
    .toast {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 13px 18px;
      border-radius: 12px;
      color: white;
      font-size: 14px;
      font-weight: 600;
      font-family: 'Segoe UI', Arial, sans-serif;
      box-shadow: 0 6px 24px rgba(0,0,0,0.18);
      pointer-events: all;
      cursor: pointer;
      max-width: 340px;
      word-break: break-word;
      animation: toastIn 0.3s ease forwards;
      transition: opacity 0.3s ease, transform 0.3s ease;
    }
    .toast.hide {
      animation: toastOut 0.3s ease forwards;
    }
    .toast-success { background: #27ae60; }
    .toast-error   { background: #e74c3c; }
    .toast-info    { background: #2980b9; }
    .toast-warning { background: #e67e22; }
    .toast-icon    { font-size: 18px; flex-shrink: 0; }
    @keyframes toastIn  { from { opacity:0; transform: translateY(16px); } to { opacity:1; transform: translateY(0); } }
    @keyframes toastOut { from { opacity:1; transform: translateY(0);    } to { opacity:0; transform: translateY(16px); } }
    @media (max-width: 500px) {
      #toast-container { bottom: 16px; right: 12px; left: 12px; }
      .toast { max-width: 100%; }
    }
  `;
  document.head.appendChild(style);

  // Create container
  const container = document.createElement('div');
  container.id = 'toast-container';
  document.body.appendChild(container);

  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };

  window.toast = function (message, type = 'info', duration = 3500) {
    const el = document.createElement('div');
    el.className = `toast toast-${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type] || 'ℹ️'}</span><span>${message}</span>`;

    el.addEventListener('click', () => dismiss(el));
    container.appendChild(el);

    const timer = setTimeout(() => dismiss(el), duration);
    el.dataset.timer = timer;

    return el;
  };

  function dismiss(el) {
    clearTimeout(el.dataset.timer);
    el.classList.add('hide');
    setTimeout(() => el.remove(), 320);
  }
})();
