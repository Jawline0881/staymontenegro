/**
 * Notification Center - Frontend Manager
 * Real-time notification display and management
 */

class NotificationCenter {
  constructor() {
    this.notifications = [];
    this.currentPage = 1;
    this.pageSize = 20;
    this.totalPages = 1;
    this.filters = {
      type: '',
      status: ['unread', 'read'],
      priority: '',
      sort: '-createdAt',
    };
    this.searchQuery = '';
    this.init();
  }

  init() {
    this.setupEventListeners();
    this.loadNotifications();
    this.setupAutoRefresh();
  }

  setupEventListeners() {
    // Mark all as read
    document.getElementById('mark-all-read-btn')?.addEventListener('click', () => this.markAllAsRead());

    // Filter toggle
    document.getElementById('filter-toggle-btn')?.addEventListener('click', () => this.toggleFiltersPanel());

    // Filters
    document.getElementById('filter-type')?.addEventListener('change', (e) => {
      this.filters.type = e.target.value;
      this.currentPage = 1;
      this.loadNotifications();
    });

    document.getElementById('filter-priority')?.addEventListener('change', (e) => {
      this.filters.priority = e.target.value;
      this.currentPage = 1;
      this.loadNotifications();
    });

    document.getElementById('filter-sort')?.addEventListener('change', (e) => {
      this.filters.sort = e.target.value;
      this.currentPage = 1;
      this.loadNotifications();
    });

    document.getElementById('clear-filters-btn')?.addEventListener('click', () => this.clearFilters());

    // Search
    document.getElementById('search-input')?.addEventListener('input', (e) => {
      this.searchQuery = e.target.value;
      if (this.searchQuery.length > 2) {
        this.searchNotifications();
      } else if (this.searchQuery.length === 0) {
        this.currentPage = 1;
        this.loadNotifications();
      }
    });

    // Pagination
    document.getElementById('prev-page-btn')?.addEventListener('click', () => this.previousPage());
    document.getElementById('next-page-btn')?.addEventListener('click', () => this.nextPage());

    // Status checkboxes
    document.querySelectorAll('input[name="filter-status"]').forEach(checkbox => {
      checkbox.addEventListener('change', () => this.updateStatusFilter());
    });

    // Modal close
    document.getElementById('modal-close-btn')?.addEventListener('click', () => this.closeModal());
    document.getElementById('modal-overlay')?.addEventListener('click', () => this.closeModal());
  }

  async loadNotifications() {
    try {
      const params = new URLSearchParams({
        page: this.currentPage,
        limit: this.pageSize,
        sort: this.filters.sort,
      });

      if (this.filters.type) params.append('type', this.filters.type);
      if (this.filters.priority) params.append('priority', this.filters.priority);

      const response = await fetch(`/api/notifications?${params}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}` },
      });

      if (!response.ok) throw new Error('Failed to load notifications');

      const data = await response.json();
      this.notifications = data.notifications;
      this.currentPage = data.page;
      this.totalPages = data.totalPages;

      this.renderNotifications();
      this.updatePagination();
    } catch (err) {
      console.error('Error loading notifications:', err);
      this.showError('Failed to load notifications');
    }
  }

  renderNotifications() {
    const container = document.getElementById('notifications-list');
    const emptyState = document.getElementById('empty-state');
    const loadingState = document.getElementById('loading-state');

    if (!container) return;

    loadingState.style.display = 'none';

    if (this.notifications.length === 0) {
      container.innerHTML = '';
      emptyState.style.display = 'flex';
      return;
    }

    emptyState.style.display = 'none';
    container.innerHTML = this.notifications.map(notif => this.renderNotificationItem(notif)).join('');

    // Add event listeners
    this.notifications.forEach(notif => {
      document.querySelector(`[data-notification-id="${notif._id}"]`)?.addEventListener('click', () => {
        this.openNotificationDetail(notif);
      });

      document.querySelector(`[data-notification-id="${notif._id}"] .mark-read-btn`)?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.markAsRead(notif._id);
      });

      document.querySelector(`[data-notification-id="${notif._id}"] .archive-btn`)?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.archiveNotification(notif._id);
      });

      document.querySelector(`[data-notification-id="${notif._id}"] .delete-btn`)?.addEventListener('click', (e) => {
        e.stopPropagation();
        this.deleteNotification(notif._id);
      });
    });
  }

  renderNotificationItem(notif) {
    const timeAgo = this.getTimeAgo(new Date(notif.createdAt));
    const priorityColor = {
      urgent: '#d32f2f',
      high: '#f57c00',
      medium: '#1976d2',
      low: '#388e3c',
    };

    const unreadClass = !notif.isRead ? 'unread' : '';
    const priorityDot = `<span class="priority-dot" style="background-color: ${priorityColor[notif.priority] || '#1976d2'};"></span>`;

    return `
      <div class="notification-item ${unreadClass}" data-notification-id="${notif._id}">
        <div class="notification-icon">${notif.icon}</div>
        <div class="notification-content">
          <div class="notification-title">
            ${priorityDot}
            <span>${this.escapeHtml(notif.title)}</span>
            ${!notif.isRead ? '<span class="unread-badge">New</span>' : ''}
          </div>
          <p class="notification-preview">${this.escapeHtml(notif.message.substring(0, 100))}${notif.message.length > 100 ? '...' : ''}</p>
          <div class="notification-footer">
            <span class="notification-time">${timeAgo}</span>
            <span class="notification-type">${this.formatType(notif.type)}</span>
          </div>
        </div>
        <div class="notification-actions">
          <button class="icon-btn mark-read-btn" title="Mark as read/unread">
            ${notif.isRead ? '✓' : '○'}
          </button>
          <button class="icon-btn archive-btn" title="Archive">📦</button>
          <button class="icon-btn delete-btn" title="Delete">🗑️</button>
        </div>
      </div>
    `;
  }

  openNotificationDetail(notif) {
    const modal = document.getElementById('notification-modal');
    const overlay = document.getElementById('modal-overlay');

    document.getElementById('modal-title').textContent = notif.title;
    document.getElementById('modal-message').textContent = notif.message;
    document.getElementById('modal-priority').textContent = `Priority: ${notif.priority.toUpperCase()}`;
    document.getElementById('modal-priority').className = `priority-badge priority-${notif.priority}`;

    // Action button
    const actionBtn = document.getElementById('modal-action-btn');
    if (notif.actionUrl) {
      actionBtn.textContent = notif.actionText || 'View';
      actionBtn.href = notif.actionUrl;
      actionBtn.style.display = 'inline-block';
    } else {
      actionBtn.style.display = 'none';
    }

    // Modal actions
    document.getElementById('modal-archive-btn').onclick = () => {
      this.archiveNotification(notif._id);
      this.closeModal();
    };

    document.getElementById('modal-delete-btn').onclick = () => {
      this.deleteNotification(notif._id);
      this.closeModal();
    };

    modal.style.display = 'flex';
    overlay.style.display = 'block';

    // Mark as read when viewing
    if (!notif.isRead) {
      this.markAsRead(notif._id);
    }
  }

  closeModal() {
    document.getElementById('notification-modal').style.display = 'none';
    document.getElementById('modal-overlay').style.display = 'none';
  }

  async markAsRead(notificationId) {
    try {
      const response = await fetch(`/api/notifications/${notificationId}/read`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}` },
      });

      if (response.ok) {
        this.loadNotifications();
        this.updateUnreadBadge();
      }
    } catch (err) {
      console.error('Error marking as read:', err);
    }
  }

  async markAllAsRead() {
    try {
      const response = await fetch('/api/notifications/read-all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}` },
      });

      if (response.ok) {
        this.loadNotifications();
        this.updateUnreadBadge();
      }
    } catch (err) {
      console.error('Error marking all as read:', err);
    }
  }

  async archiveNotification(notificationId) {
    try {
      const response = await fetch(`/api/notifications/${notificationId}/archive`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}` },
      });

      if (response.ok) {
        this.loadNotifications();
      }
    } catch (err) {
      console.error('Error archiving notification:', err);
    }
  }

  async deleteNotification(notificationId) {
    if (!confirm('Are you sure you want to delete this notification?')) return;

    try {
      const response = await fetch(`/api/notifications/${notificationId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}` },
      });

      if (response.ok) {
        this.loadNotifications();
      }
    } catch (err) {
      console.error('Error deleting notification:', err);
    }
  }

  async searchNotifications() {
    if (!this.searchQuery) {
      this.loadNotifications();
      return;
    }

    try {
      const response = await fetch(`/api/notifications/search?q=${encodeURIComponent(this.searchQuery)}`, {
        headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}` },
      });

      if (!response.ok) throw new Error('Search failed');

      this.notifications = await response.json();
      this.renderNotifications();
      document.getElementById('pagination-container').style.display = 'none';
    } catch (err) {
      console.error('Error searching:', err);
      this.showError('Search failed');
    }
  }

  async updateUnreadBadge() {
    try {
      const response = await fetch('/api/notifications/unread-count', {
        headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}` },
      });
      const data = await response.json();
      this.updateNotificationBell(data.unreadCount);
    } catch (err) {
      console.error('Error updating badge:', err);
    }
  }

  updateNotificationBell(count) {
    const badge = document.getElementById('notification-badge');
    if (badge) {
      badge.textContent = count;
      badge.style.display = count > 0 ? 'flex' : 'none';
    }
  }

  updatePagination() {
    const container = document.getElementById('pagination-container');
    if (!container) return;

    if (this.totalPages <= 1) {
      container.style.display = 'none';
      return;
    }

    container.style.display = 'flex';
    document.getElementById('page-info').textContent = `Page ${this.currentPage} of ${this.totalPages}`;
    document.getElementById('prev-page-btn').disabled = this.currentPage === 1;
    document.getElementById('next-page-btn').disabled = this.currentPage === this.totalPages;
  }

  previousPage() {
    if (this.currentPage > 1) {
      this.currentPage--;
      this.loadNotifications();
    }
  }

  nextPage() {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
      this.loadNotifications();
    }
  }

  updateStatusFilter() {
    const checkboxes = document.querySelectorAll('input[name="filter-status"]:checked');
    this.filters.status = Array.from(checkboxes).map(cb => cb.value);
    this.currentPage = 1;
    this.loadNotifications();
  }

  clearFilters() {
    this.filters = {
      type: '',
      status: ['unread', 'read'],
      priority: '',
      sort: '-createdAt',
    };
    document.getElementById('filter-type').value = '';
    document.getElementById('filter-priority').value = '';
    document.getElementById('filter-sort').value = '-createdAt';
    document.querySelectorAll('input[name="filter-status"]').forEach(cb => cb.checked = true);
    document.getElementById('search-input').value = '';
    this.searchQuery = '';
    this.currentPage = 1;
    this.loadNotifications();
  }

  toggleFiltersPanel() {
    const panel = document.querySelector('.filters-panel');
    if (panel) {
      panel.classList.toggle('open');
    }
  }

  setupAutoRefresh() {
    // Refresh notifications every 30 seconds
    setInterval(() => this.updateUnreadBadge(), 30000);
  }

  getTimeAgo(date) {
    const seconds = Math.floor((new Date() - date) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  formatType(type) {
    return type.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  }

  escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  showError(message) {
    const errorEl = document.createElement('div');
    errorEl.className = 'alert alert-danger';
    errorEl.textContent = message;
    document.body.insertBefore(errorEl, document.body.firstChild);
    setTimeout(() => errorEl.remove(), 5000);
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.notificationCenter = new NotificationCenter();
  });
} else {
  window.notificationCenter = new NotificationCenter();
}
