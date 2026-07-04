// ─── Admin Panel Manager ──────────────────────────────────────────────────────
// Shared utilities and functions for all admin pages

class AdminManager {
  constructor() {
    this.token = localStorage.getItem('adminToken');
    this.adminRole = localStorage.getItem('adminRole');
    this.adminId = localStorage.getItem('adminId');
    this.baseUrl = '/api/admin';
  }

  // ─── Auth ──────────────────────────────────────────────────────────────────
  isLoggedIn() {
    return !!this.token;
  }

  ensureLoggedIn() {
    if (!this.isLoggedIn()) {
      window.location.href = '/admin-login.html';
    }
  }

  hasPermission(permission) {
    const rolePermissions = {
      moderator: [
        'view_users', 'ban_users', 'verify_hosts', 'view_bookings', 'cancel_bookings',
        'moderate_content', 'flag_properties', 'view_reviews', 'respond_to_disputes'
      ],
      support: [
        'view_users', 'view_bookings', 'cancel_bookings', 'process_refunds',
        'moderate_content', 'resolve_disputes', 'message_users', 'view_transactions'
      ],
      financial: [
        'view_users', 'view_bookings', 'view_revenue', 'process_payouts',
        'process_refunds', 'view_financial_reports', 'view_transactions', 'export_reports'
      ],
      super_admin: [] // All permissions
    };

    if (this.adminRole === 'super_admin') return true;
    const permissions = rolePermissions[this.adminRole] || [];
    return permissions.includes(permission);
  }

  // ─── API Calls ─────────────────────────────────────────────────────────────
  async fetch(method, endpoint, body = null) {
    const options = {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': this.token
      }
    };

    if (body) {
      options.body = JSON.stringify(body);
    }

    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, options);

      if (response.status === 401) {
        localStorage.removeItem('adminToken');
        window.location.href = '/admin-login.html';
        return null;
      }

      if (response.status === 403) {
        this.showError('You do not have permission to perform this action');
        return null;
      }

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Request failed');
      }

      return data;
    } catch (err) {
      console.error('API Error:', err);
      throw err;
    }
  }

  get(endpoint) {
    return this.fetch('GET', endpoint);
  }

  post(endpoint, body) {
    return this.fetch('POST', endpoint, body);
  }

  patch(endpoint, body) {
    return this.fetch('PATCH', endpoint, body);
  }

  delete(endpoint) {
    return this.fetch('DELETE', endpoint);
  }

  // ─── Users ────────────────────────────────────────────────────────────────
  getUsers(page = 1, limit = 50, search = '', filters = {}) {
    const params = new URLSearchParams({
      page,
      limit,
      search,
      ...filters
    });
    return this.fetch('GET', `/users?${params}`);
  }

  getUserDetails(userId) {
    return this.fetch('GET', `/users/${userId}`);
  }

  banUser(userId, reason) {
    return this.patch(`/users/${userId}/ban`, { reason });
  }

  verifyUser(userId) {
    return this.patch(`/users/${userId}/verify`, {});
  }

  // ─── Properties ────────────────────────────────────────────────────────────
  getProperties(page = 1, limit = 50, search = '', filters = {}) {
    const params = new URLSearchParams({
      page,
      limit,
      search,
      ...filters
    });
    return this.fetch('GET', `/properties?${params}`);
  }

  getPropertyDetails(propertyId) {
    return this.fetch('GET', `/properties/${propertyId}`);
  }

  removeProperty(propertyId, reason) {
    return this.patch(`/properties/${propertyId}/remove`, { reason });
  }

  flagProperty(propertyId, reason) {
    return this.patch(`/properties/${propertyId}/flag`, { reason });
  }

  // ─── Bookings ────────────────────────────────────────────────────────────
  getBookings(page = 1, limit = 50, filters = {}) {
    const params = new URLSearchParams({
      page,
      limit,
      ...filters
    });
    return this.fetch('GET', `/bookings?${params}`);
  }

  getBookingDetails(bookingId) {
    return this.fetch('GET', `/bookings/${bookingId}`);
  }

  cancelBooking(bookingId, reason) {
    return this.patch(`/bookings/${bookingId}/cancel`, { reason });
  }

  processRefund(bookingId, amount, reason) {
    return this.post(`/bookings/${bookingId}/refund`, { amount, reason });
  }

  // ─── Disputes ────────────────────────────────────────────────────────────
  getDisputes(page = 1, limit = 50, filters = {}) {
    const params = new URLSearchParams({
      page,
      limit,
      ...filters
    });
    return this.fetch('GET', `/disputes?${params}`);
  }

  getDisputeDetails(disputeId) {
    return this.fetch('GET', `/disputes/${disputeId}`);
  }

  createDispute(disputableType, disputableId, reason, description, priority) {
    return this.post('/disputes', {
      disputableType,
      disputableId,
      reason,
      description,
      priority
    });
  }

  assignDispute(disputeId, assignedTo) {
    return this.patch(`/disputes/${disputeId}/assign`, { assignedTo });
  }

  resolveDispute(disputeId, resolution, resolutionNotes) {
    return this.patch(`/disputes/${disputeId}/resolve`, {
      resolution,
      resolutionNotes
    });
  }

  // ─── Financial ────────────────────────────────────────────────────────────
  getFinancialOverview() {
    return this.fetch('GET', '/financials/overview');
  }

  getPayouts(page = 1, limit = 50, status = 'pending') {
    const params = new URLSearchParams({ page, limit, status });
    return this.fetch('GET', `/financials/payouts?${params}`);
  }

  approvePayout(payoutId) {
    return this.patch(`/payouts/${payoutId}/approve`, {});
  }

  processPayout(payoutId) {
    return this.patch(`/payouts/${payoutId}/process`, {});
  }

  // ─── Moderation ────────────────────────────────────────────────────────────
  getFlaggedReviews() {
    return this.fetch('GET', '/moderation/reviews');
  }

  getFlaggedMessages() {
    return this.fetch('GET', '/moderation/messages');
  }

  // ─── Logs ────────────────────────────────────────────────────────────────
  getLogs(page = 1, limit = 100, filters = {}) {
    const params = new URLSearchParams({
      page,
      limit,
      ...filters
    });
    return this.fetch('GET', `/logs?${params}`);
  }

  exportLogs() {
    window.open(`${this.baseUrl}/logs/export?token=${this.token}`);
  }

  // ─── Dashboard ────────────────────────────────────────────────────────────
  getDashboardOverview() {
    return this.fetch('GET', '/dashboard/overview');
  }

  getChartData(type) {
    return this.fetch('GET', `/dashboard/charts/${type}`);
  }

  // ─── UI Helpers ────────────────────────────────────────────────────────────
  showError(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #fee;
      color: #c33;
      padding: 16px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 9999;
      font-size: 14px;
      max-width: 400px;
      animation: slideIn 0.3s ease;
    `;
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
  }

  showSuccess(message) {
    const toast = document.createElement('div');
    toast.style.cssText = `
      position: fixed;
      top: 20px;
      right: 20px;
      background: #efe;
      color: #3a3;
      padding: 16px 20px;
      border-radius: 8px;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
      z-index: 9999;
      font-size: 14px;
      max-width: 400px;
      animation: slideIn 0.3s ease;
    `;
    toast.innerText = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  formatDate(date) {
    if (!date) return '-';
    return new Date(date).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  formatCurrency(amount) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'EUR'
    }).format(amount);
  }

  truncate(text, length = 50) {
    if (!text) return '-';
    return text.length > length ? text.slice(0, length) + '...' : text;
  }

  // ─── Modal Helpers ────────────────────────────────────────────────────────
  createModal(title, content, actions = []) {
    const modal = document.createElement('div');
    modal.style.cssText = `
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px;
    `;

    const modalContent = document.createElement('div');
    modalContent.style.cssText = `
      background: white;
      border-radius: 12px;
      padding: 30px;
      max-width: 500px;
      width: 100%;
      max-height: 80vh;
      overflow-y: auto;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
    `;

    let html = `<h2 style="margin-bottom: 20px; font-size: 18px;">${title}</h2>`;
    html += `<div style="margin-bottom: 20px; color: #666; line-height: 1.6;">${content}</div>`;

    if (actions.length > 0) {
      html += '<div style="display: flex; gap: 10px; justify-content: flex-end;">';
      actions.forEach(action => {
        html += `<button data-action="${action.id}" style="padding: 10px 16px; border: none; border-radius: 6px; cursor: pointer; font-size: 14px; ${
          action.primary ? 'background: #667eea; color: white;' : 'background: #f0f0f0; color: #333;'
        }">${action.label}</button>`;
      });
      html += '</div>';
    }

    modalContent.innerHTML = html;
    modal.appendChild(modalContent);

    // Add event listeners
    actions.forEach(action => {
      const btn = modalContent.querySelector(`[data-action="${action.id}"]`);
      if (btn) {
        btn.addEventListener('click', () => {
          action.callback?.();
          modal.remove();
        });
      }
    });

    // Close on background click
    modal.addEventListener('click', (e) => {
      if (e.target === modal) modal.remove();
    });

    document.body.appendChild(modal);
    return modal;
  }

  // ─── Table Builder ────────────────────────────────────────────────────────
  createTable(columns, rows, options = {}) {
    let html = '<table style="width: 100%; border-collapse: collapse;">';

    // Header
    html += '<thead><tr style="background: #f8f8f8; border-bottom: 2px solid #e0e0e0;">';
    columns.forEach(col => {
      html += `<th style="padding: 12px; text-align: left; font-weight: 600; font-size: 13px; color: #666;">${col.label}</th>`;
    });
    html += '</tr></thead>';

    // Body
    html += '<tbody>';
    rows.forEach((row, idx) => {
      html += `<tr style="border-bottom: 1px solid #e0e0e0; ${idx % 2 === 0 ? 'background: #fff;' : 'background: #fafafa;'}">`;
      columns.forEach(col => {
        const value = col.render ? col.render(row) : (row[col.key] || '-');
        html += `<td style="padding: 12px; font-size: 13px;">${value}</td>`;
      });
      html += '</tr>';
    });
    html += '</tbody>';
    html += '</table>';

    return html;
  }
}

// Global instance
const adminManager = new AdminManager();

// CSS for animations
const style = document.createElement('style');
style.innerHTML = `
  @keyframes slideIn {
    from {
      transform: translateX(400px);
      opacity: 0;
    }
    to {
      transform: translateX(0);
      opacity: 1;
    }
  }
`;
document.head.appendChild(style);
