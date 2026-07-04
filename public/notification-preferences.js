/**
 * Notification Preferences - Frontend Manager
 * User preference management
 */

class NotificationPreferences {
  constructor() {
    this.preferences = null;
    this.init();
  }

  init() {
    this.loadPreferences();
    this.setupEventListeners();
  }

  setupEventListeners() {
    const form = document.getElementById('preferences-form');
    form?.addEventListener('submit', (e) => this.handleSubmit(e));

    document.getElementById('reset-btn')?.addEventListener('click', (e) => {
      e.preventDefault();
      this.resetToDefaults();
    });
  }

  async loadPreferences() {
    try {
      const response = await fetch('/api/preferences/notifications', {
        headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}` },
      });

      if (!response.ok) throw new Error('Failed to load preferences');

      this.preferences = await response.json();
      this.populateForm();
    } catch (err) {
      console.error('Error loading preferences:', err);
      this.showError('Failed to load preferences');
    }
  }

  populateForm() {
    if (!this.preferences) return;

    // Channels
    document.getElementById('channels-inApp').checked = this.preferences.channels.inApp !== false;
    document.getElementById('channels-email').checked = this.preferences.channels.email !== false;
    document.getElementById('channels-sms').checked = this.preferences.channels.sms !== false;
    document.getElementById('channels-push').checked = this.preferences.channels.push !== false;

    // Email digest
    document.getElementById('emailDigest').value = this.preferences.emailDigest || 'daily';
    document.getElementById('unsubscribeAllMarketing').checked = this.preferences.unsubscribeAllMarketing || false;

    // Quiet hours
    document.getElementById('quietHours-start').value = this.preferences.quietHours.start || '22:00';
    document.getElementById('quietHours-end').value = this.preferences.quietHours.end || '08:00';
    document.getElementById('timezone').value = this.preferences.timezone || 'UTC';

    // Notification type toggles
    const typeToggles = {
      booking_request: 'booking',
      booking_confirmed: 'booking',
      booking_cancelled: 'booking',
      booking_modified: 'booking',
      checkin_reminder: 'booking',
      checkout_reminder: 'booking',
      new_message: 'messaging',
      message_reply: 'messaging',
      message_digest: 'messaging',
      payment_received: 'payments',
      payment_pending: 'payments',
      payment_failed: 'payments',
      payout_processed: 'payments',
      invoice_ready: 'payments',
      review_left: 'reviews',
      host_reply_review: 'reviews',
      account_verified: 'account',
      superhost_achieved: 'account',
      security_alert: 'account',
      support_response: 'support',
      dispute_raised: 'admin',
    };

    for (const [notificationType, category] of Object.entries(typeToggles)) {
      const checkbox = document.querySelector(`input[name="type-${notificationType}"]`);
      if (checkbox) {
        const categoryPrefs = this.preferences.types[category] || {};
        const enabled = categoryPrefs.email !== false || categoryPrefs.inApp !== false;
        checkbox.checked = enabled;
      }
    }
  }

  async handleSubmit(e) {
    e.preventDefault();

    const preferences = {
      channels: {
        inApp: document.getElementById('channels-inApp').checked,
        email: document.getElementById('channels-email').checked,
        sms: document.getElementById('channels-sms').checked,
        push: document.getElementById('channels-push').checked,
      },
      emailDigest: document.getElementById('emailDigest').value,
      unsubscribeAllMarketing: document.getElementById('unsubscribeAllMarketing').checked,
      quietHours: {
        start: document.getElementById('quietHours-start').value,
        end: document.getElementById('quietHours-end').value,
      },
      timezone: document.getElementById('timezone').value,
    };

    try {
      const response = await fetch('/api/preferences/notifications', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${localStorage.getItem('authToken')}`,
        },
        body: JSON.stringify(preferences),
      });

      if (!response.ok) throw new Error('Failed to save preferences');

      this.preferences = await response.json();
      this.showSuccess('Preferences saved successfully!');
    } catch (err) {
      console.error('Error saving preferences:', err);
      this.showError('Failed to save preferences');
    }
  }

  async resetToDefaults() {
    if (!confirm('Are you sure you want to reset to default preferences?')) return;

    try {
      const response = await fetch('/api/preferences/notifications/reset', {
        method: 'POST',
        headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}` },
      });

      if (!response.ok) throw new Error('Failed to reset preferences');

      this.preferences = await response.json();
      this.populateForm();
      this.showSuccess('Preferences reset to defaults!');
    } catch (err) {
      console.error('Error resetting preferences:', err);
      this.showError('Failed to reset preferences');
    }
  }

  showSuccess(message) {
    const successEl = document.getElementById('success-message');
    const errorEl = document.getElementById('error-message');

    if (errorEl) errorEl.style.display = 'none';
    if (successEl) {
      successEl.textContent = '✅ ' + message;
      successEl.style.display = 'block';
      setTimeout(() => {
        successEl.style.display = 'none';
      }, 5000);
    }
  }

  showError(message) {
    const errorEl = document.getElementById('error-message');
    const successEl = document.getElementById('success-message');

    if (successEl) successEl.style.display = 'none';
    if (errorEl) {
      errorEl.textContent = '❌ ' + message;
      errorEl.style.display = 'block';
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    window.notificationPreferences = new NotificationPreferences();
  });
} else {
  window.notificationPreferences = new NotificationPreferences();
}
