// app.js — shared helpers (optional, used by pages that include this script)

const listingsContainer = document.getElementById('listings');
const searchInput       = document.getElementById('search');

async function loadListings(query = '') {
  listingsContainer.innerHTML = '<div class="spinner"></div>';

  try {
    const res  = await fetch(`/api/listings?city=${encodeURIComponent(query)}`);
    const data = await res.json();

    listingsContainer.innerHTML = '';

    if (!data.length) {
      listingsContainer.innerHTML = '<div class="empty-state"><div class="emoji">🏠</div><p>No listings found.</p></div>';
      return;
    }

    data.forEach(item => {
      const a = document.createElement('a');
      a.className = 'card';
      a.href = `/listing.html?id=${item._id}`;   // fixed: was item.id

      a.innerHTML = `
        <img src="${item.image || 'https://via.placeholder.com/400x250?text=No+Image'}" alt="${item.title}" loading="lazy">
        <div class="card-content">
          <h3>${item.title}</h3>
          <p class="card-city">📍 ${item.city}</p>
          <p class="card-desc">${item.description || ''}</p>
          <p class="card-price">€${item.price} <span>/ night</span></p>
        </div>`;

      listingsContainer.appendChild(a);
    });
  } catch {
    listingsContainer.innerHTML = '<div class="empty-state"><p>Failed to load listings.</p></div>';
  }
}

if (searchInput) {
  searchInput.addEventListener('input', e => loadListings(e.target.value));
}
