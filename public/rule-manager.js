/**
 * House Rules Manager - Frontend Logic
 * Handles host rule management, editing, and deletion
 */

let currentListingId = null;
let currentRuleId = null;
let isEditingRule = false;

// Category suggestions for quick rule creation
const CATEGORY_SUGGESTIONS = {
  pets: [
    'No pets allowed',
    'Pets allowed (with €20/night fee)',
    'Cats only',
    'Small dogs only (under 10kg)',
    'Service animals only',
  ],
  smoking: [
    'No smoking indoors',
    'Smoking only on balcony',
    'No smoking at all',
    'Smoking allowed',
  ],
  noise: [
    'Quiet hours 10pm-8am',
    'Quiet hours 11pm-8am',
    'No parties or large groups',
    'No loud music after 11pm',
    'No amplified instruments',
  ],
  guests: [
    'No additional guests',
    'Maximum 2 guests',
    'Maximum 4 guests',
    'Maximum 6 guests',
    'No parties allowed',
    'Must register all guests',
    'No guests after midnight',
  ],
  parking: [
    'No parking available',
    '1 assigned spot',
    'Street parking only',
    'Guest responsible for parking fees',
    'Driveway use only',
  ],
  'check-in': [
    'Check-in after 3pm',
    'Check-in after 4pm',
    'Key pickup at front desk',
    'Smart lock code provided',
    'Keypad entry',
  ],
  'check-out': [
    'Check-out before 11am',
    'Check-out before 10am',
    'Late checkout available (€25)',
    'Keys must be returned to desk',
    'Flexible checkout available',
  ],
  kitchen: [
    'Furnished fridge only',
    'Full kitchen available',
    'No cooking allowed',
    'Dishwasher safe only',
    'Bring own utensils',
  ],
  general: [
    'Respect neighbors',
    'Keep property clean',
    'Report damage immediately',
    'Return keys same day',
    'No subleasing allowed',
    'Be respectful of neighbors',
    'Guests must be 21+',
  ],
};

// Load host's properties
async function loadHostProperties() {
  try {
    const token = localStorage.getItem('token');
    if (!token) {
      window.location.href = 'auth.html';
      return;
    }

    const res = await fetch('/api/listings', {
      headers: { 'Authorization': token }
    });

    if (!res.ok) throw new Error('Failed to fetch listings');

    const listings = await res.json();
    const select = document.getElementById('propertySelect');

    if (listings.length === 0) {
      select.innerHTML = '<option value="">You have no listings</option>';
      document.getElementById('statsContainer').style.display = 'none';
      document.getElementById('actionButtons').style.display = 'none';
      return;
    }

    select.innerHTML = '<option value="">-- Select a property --</option>' + 
      listings.map(l => `<option value="${l._id}">${l.title}, ${l.city}</option>`).join('');
  } catch (err) {
    console.error('Error loading properties:', err);
    showAlert('Failed to load properties', 'error');
  }
}

// Load rules for selected property
async function loadRulesForProperty() {
  const select = document.getElementById('propertySelect');
  const listingId = select.value;

  if (!listingId) {
    document.getElementById('emptyState').style.display = 'block';
    document.getElementById('rulesList').style.display = 'none';
    document.getElementById('statsContainer').style.display = 'none';
    document.getElementById('actionButtons').style.display = 'none';
    return;
  }

  currentListingId = listingId;
  await fetchAndDisplayRules(listingId);
}

// Fetch rules from API
async function fetchAndDisplayRules(listingId) {
  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api/listings/${listingId}/rules`, {
      headers: { 'Authorization': token }
    });

    if (!res.ok) throw new Error('Failed to fetch rules');

    const data = await res.json();
    displayRules(data.rules, data.meta);

    // Update stats
    document.getElementById('totalRulesNum').textContent = data.meta.total;
    document.getElementById('requiredRulesNum').textContent = data.meta.requiredCount || 0;
    document.getElementById('statsContainer').style.display = 'grid';
    document.getElementById('actionButtons').style.display = 'flex';
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('rulesList').style.display = 'block';
  } catch (err) {
    console.error('Error fetching rules:', err);
    showAlert('Failed to load rules', 'error');
  }
}

// Display rules grouped by category
function displayRules(rules, meta) {
  const container = document.getElementById('rulesContent');

  if (rules.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; padding: 40px 20px; color: #777;">
        <p>No rules yet. Add your first rule or load a template.</p>
      </div>
    `;
    return;
  }

  // Group rules by category
  const grouped = {};
  Object.keys(meta).forEach(cat => {
    grouped[cat] = rules.filter(r => r.category === cat);
  });

  // Build HTML
  let html = '';
  Object.entries(grouped).forEach(([category, categoryRules]) => {
    if (categoryRules.length === 0) return;

    const icon = meta[category]?.icon || '📋';
    const categoryName = meta[category]?.name || category;

    html += `
      <div class="category-group">
        <div class="category-header" onclick="toggleCategory(this)">
          <span class="expand-icon">▶</span>
          <span>${icon} ${categoryName}</span>
          <span style="margin-left: auto; font-size: 12px; color: #999;">${categoryRules.length} rule${categoryRules.length !== 1 ? 's' : ''}</span>
        </div>
        <div class="category-body">
          ${categoryRules.map(rule => `
            <div class="rule-item">
              <div class="rule-info">
                <div class="rule-title">
                  ${rule.title}
                  ${rule.required ? '<span class="required-badge">REQUIRED</span>' : ''}
                </div>
                ${rule.description ? `<div class="rule-description">${rule.description}</div>` : ''}
              </div>
              <div class="rule-actions">
                <button class="icon-btn" onclick="editRule('${rule.ruleId}')" title="Edit">✏️</button>
                <button class="icon-btn" onclick="deleteRule('${rule.ruleId}')" title="Delete">🗑️</button>
              </div>
            </div>
          `).join('')}
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

// Toggle category expansion
function toggleCategory(header) {
  header.classList.toggle('collapsed');
  const body = header.nextElementSibling;
  body.classList.toggle('hidden');
}

// Open add rule modal
function openRuleModal() {
  if (!currentListingId) {
    showAlert('Please select a property first', 'error');
    return;
  }
  isEditingRule = false;
  currentRuleId = null;
  document.getElementById('ruleModalTitle').textContent = 'Add New Rule';
  document.getElementById('ruleForm').reset();
  document.getElementById('ruleErrors').innerHTML = '';
  document.getElementById('ruleModal').classList.add('active');
}

// Close rule modal
function closeRuleModal() {
  document.getElementById('ruleModal').classList.remove('active');
  isEditingRule = false;
  currentRuleId = null;
}

// Update rule title suggestions based on category
function updateRuleSuggestions() {
  const category = document.getElementById('ruleCategory').value;
  const suggestionsDiv = document.getElementById('titleSuggestions');

  if (!category || !CATEGORY_SUGGESTIONS[category]) {
    suggestionsDiv.innerHTML = '';
    return;
  }

  const suggestions = CATEGORY_SUGGESTIONS[category];
  suggestionsDiv.innerHTML = `
    <div style="font-size: 12px; color: #777; margin-bottom: 8px;">💡 Suggestions:</div>
    <div style="display: flex; flex-wrap: wrap; gap: 6px;">
      ${suggestions.map(s => `
        <button type="button" class="suggestion-btn" style="
          padding: 4px 10px;
          border: 1px solid #ddd;
          border-radius: 4px;
          background: white;
          cursor: pointer;
          font-size: 12px;
        " onclick="setSuggestion('${s.replace(/'/g, "\\'")}')">
          ${s}
        </button>
      `).join('')}
    </div>
  `;
}

// Set suggestion as title
function setSuggestion(text) {
  document.getElementById('ruleTitle').value = text;
}

// Handle rule form submission
document.getElementById('ruleForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();

  const category = document.getElementById('ruleCategory').value;
  const title = document.getElementById('ruleTitle').value;
  const description = document.getElementById('ruleDescription').value;
  const required = document.getElementById('ruleRequired').checked;

  // Validation
  const errorsDiv = document.getElementById('ruleErrors');
  const errors = [];

  if (!category) errors.push('Category is required');
  if (!title) errors.push('Title is required');

  if (errors.length > 0) {
    errorsDiv.innerHTML = errors.map(e => `<div class="error">❌ ${e}</div>`).join('');
    return;
  }

  try {
    const token = localStorage.getItem('token');

    let res;
    if (isEditingRule) {
      // Update existing rule
      res = await fetch(`/api/listings/${currentListingId}/rules/${currentRuleId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ title, description, required })
      });
    } else {
      // Create new rule
      res = await fetch(`/api/listings/${currentListingId}/rules`, {
        method: 'POST',
        headers: {
          'Authorization': token,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ category, title, description, required })
      });
    }

    if (!res.ok) {
      const error = await res.json();
      throw new Error(error.errors?.join(', ') || error.error || 'Failed to save rule');
    }

    await fetchAndDisplayRules(currentListingId);
    closeRuleModal();
    showAlert(isEditingRule ? 'Rule updated' : 'Rule created', 'success');
  } catch (err) {
    console.error('Error saving rule:', err);
    errorsDiv.innerHTML = `<div class="error">❌ ${err.message}</div>`;
  }
});

// Edit rule
async function editRule(ruleId) {
  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api/listings/${currentListingId}/rules`, {
      headers: { 'Authorization': token }
    });

    if (!res.ok) throw new Error('Failed to fetch rules');

    const data = await res.json();
    const rule = data.rules.find(r => r.ruleId === ruleId);

    if (!rule) throw new Error('Rule not found');

    isEditingRule = true;
    currentRuleId = ruleId;
    document.getElementById('ruleModalTitle').textContent = 'Edit Rule';
    document.getElementById('ruleCategory').value = rule.category;
    document.getElementById('ruleTitle').value = rule.title;
    document.getElementById('ruleDescription').value = rule.description || '';
    document.getElementById('ruleRequired').checked = rule.required;
    document.getElementById('ruleErrors').innerHTML = '';
    document.getElementById('ruleModal').classList.add('active');

    // Disable category dropdown when editing
    document.getElementById('ruleCategory').disabled = true;
  } catch (err) {
    console.error('Error editing rule:', err);
    showAlert('Failed to load rule', 'error');
  }
}

// Delete rule
async function deleteRule(ruleId) {
  if (!confirm('Are you sure you want to delete this rule?')) return;

  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api/listings/${currentListingId}/rules/${ruleId}`, {
      method: 'DELETE',
      headers: { 'Authorization': token }
    });

    if (!res.ok) throw new Error('Failed to delete rule');

    await fetchAndDisplayRules(currentListingId);
    showAlert('Rule deleted', 'success');
  } catch (err) {
    console.error('Error deleting rule:', err);
    showAlert('Failed to delete rule', 'error');
  }
}

// Open templates modal
function openTemplatesModal() {
  if (!currentListingId) {
    showAlert('Please select a property first', 'error');
    return;
  }
  document.getElementById('templatesModal').classList.add('active');
}

// Close templates modal
function closeTemplatesModal() {
  document.getElementById('templatesModal').classList.remove('active');
}

// Load template
async function loadTemplate(templateType) {
  if (!confirm('This will add new rules to your property. Continue?')) return;

  try {
    const token = localStorage.getItem('token');
    const res = await fetch(`/api/listings/${currentListingId}/rules/template`, {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ templateType })
    });

    if (!res.ok) throw new Error('Failed to load template');

    await fetchAndDisplayRules(currentListingId);
    closeTemplatesModal();
    showAlert(`${templateType} template loaded!`, 'success');
  } catch (err) {
    console.error('Error loading template:', err);
    document.getElementById('templateErrors').innerHTML = `<div class="error">❌ ${err.message}</div>`;
  }
}

// Helper: Show alert
function showAlert(message, type = 'info') {
  const alerts = document.getElementById('alerts') || createAlertsContainer();
  const alert = document.createElement('div');
  alert.style.cssText = `
    background: ${type === 'error' ? '#fee' : type === 'success' ? '#efe' : '#eef'};
    border-left: 4px solid ${type === 'error' ? '#f44' : type === 'success' ? '#4f4' : '#44f'};
    padding: 12px;
    margin-bottom: 10px;
    border-radius: 4px;
    color: ${type === 'error' ? '#c22' : type === 'success' ? '#2c2' : '#222'};
    font-size: 14px;
  `;
  alert.textContent = message;
  alerts.appendChild(alert);

  setTimeout(() => alert.remove(), 3000);
}

function createAlertsContainer() {
  const container = document.createElement('div');
  container.id = 'alerts';
  container.style.cssText = `
    position: fixed;
    top: 60px;
    right: 20px;
    z-index: 10000;
    max-width: 400px;
  `;
  document.body.appendChild(container);
  return container;
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
  loadHostProperties();
});
