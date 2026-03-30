/* ── 1. CONSTANTS ────────────────────────────────────────────────────── */
var AIRTABLE_TOKEN = 'patvUZhofHmUxBdGQ.de96f3bd149257e66c7995c7ee58c31f4eb390a3b51f5c8fcfb4792a44514f64';
var AIRTABLE_BASE  = 'app3SuYCUnfvGghu5';
var AIRTABLE_TABLE = 'Balls';
var API_URL        = 'https://api.airtable.com/v0/' + AIRTABLE_BASE + '/' + encodeURIComponent(AIRTABLE_TABLE);
var UPLOAD_URL     = 'https://content.airtable.com/v0/' + AIRTABLE_BASE;

/* ── 2. STATE ────────────────────────────────────────────────────────── */
var state = {
  records:       null,        // null = not yet loaded
  fieldIds:      undefined,   // undefined = not fetched; null = failed; obj = success
  mapsCreated:   { home: false, detail: false },
  homeMap:       null,
  homeMarkers:   null,
  detailMap:     null,
  gpsCoords:     null,
  gpsWatchId:    null
};

/* ── 3. AIRTABLE API ─────────────────────────────────────────────────── */
async function fetchAllRecords() {
  var allRecords = [];
  var offset = null;

  do {
    var url = API_URL + '?sort[0][field]=Date&sort[0][direction]=desc&pageSize=100';
    if (offset) url += '&offset=' + encodeURIComponent(offset);

    var resp = await fetch(url, {
      headers: { 'Authorization': 'Bearer ' + AIRTABLE_TOKEN }
    });

    if (resp.status === 429) throw new Error('Too many requests — please wait a moment and try again.');
    if (!resp.ok) throw new Error('Failed to load data (' + resp.status + ')');

    var data = await resp.json();
    allRecords = allRecords.concat(data.records || []);
    offset = data.offset || null;
  } while (offset);

  state.records = allRecords;
  return allRecords;
}

async function createRecord(fields) {
  var clean = {};
  Object.keys(fields).forEach(function(k) {
    if (fields[k] !== undefined && fields[k] !== '') clean[k] = fields[k];
  });

  var resp = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + AIRTABLE_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ records: [{ fields: clean }] })
  });

  if (!resp.ok) {
    var err = await resp.json().catch(function() { return {}; });
    throw new Error((err.error && err.error.message) || 'Failed to save record (' + resp.status + ')');
  }

  var data = await resp.json();
  return data.records[0];
}

async function deleteRecord(recordId) {
  if (!confirm('Delete this find? This cannot be undone.')) return;
  showLoading();
  try {
    var resp = await fetch(API_URL + '/' + recordId, {
      method: 'DELETE',
      headers: { 'Authorization': 'Bearer ' + AIRTABLE_TOKEN }
    });
    if (!resp.ok) throw new Error('Delete failed (' + resp.status + ')');
    // Remove from local cache
    if (state.records) {
      state.records = state.records.filter(function(r) { return r.id !== recordId; });
    }
    hideLoading();
    showToast('Find deleted');
    navigate('#list');
  } catch (e) {
    hideLoading();
    showToast(e.message || 'Delete failed — try again');
  }
}

// Resolve the attachment field ID — content.airtable.com requires the real
// field ID (fldXXXXXX), not the field name.
// Method 1: Metadata API (needs schema.bases:read scope on token).
// Method 2: Fetch recent records with returnFieldsByFieldId=true and identify
//           the attachment field by its value structure (array of objects with url).
async function fetchFieldIds() {
  if (state.fieldIds !== undefined) return state.fieldIds;

  // Method 1 — metadata API
  try {
    var resp = await fetch(
      'https://api.airtable.com/v0/meta/bases/' + AIRTABLE_BASE + '/tables',
      { headers: { 'Authorization': 'Bearer ' + AIRTABLE_TOKEN } }
    );
    if (resp.ok) {
      var data = await resp.json();
      var table = null;
      for (var i = 0; i < data.tables.length; i++) {
        if (data.tables[i].name === AIRTABLE_TABLE) { table = data.tables[i]; break; }
      }
      if (table) {
        state.fieldIds = {};
        table.fields.forEach(function(f) { state.fieldIds[f.name] = f.id; });
        return state.fieldIds;
      }
    }
  } catch (e) {}

  // Method 2 — inspect record values to find attachment field ID
  try {
    var url2 = API_URL + '?maxRecords=10&returnFieldsByFieldId=true&sort[0][field]=Date&sort[0][direction]=desc';
    var resp2 = await fetch(url2, { headers: { 'Authorization': 'Bearer ' + AIRTABLE_TOKEN } });
    if (resp2.ok) {
      var data2 = await resp2.json();
      var records = data2.records || [];
      var imageFieldId = null;
      for (var j = 0; j < records.length && !imageFieldId; j++) {
        var fieldKeys = Object.keys(records[j].fields);
        for (var k = 0; k < fieldKeys.length; k++) {
          var val = records[j].fields[fieldKeys[k]];
          if (Array.isArray(val) && val.length > 0 && val[0] && typeof val[0].url === 'string') {
            imageFieldId = fieldKeys[k];
            break;
          }
        }
      }
      if (imageFieldId) {
        state.fieldIds = { Image: imageFieldId };
        return state.fieldIds;
      }
    }
  } catch (e) {}

  state.fieldIds = null;
  return null;
}

// Compress an image file using Canvas to keep it well under Airtable's 5 MB limit.
function compressImage(file) {
  return new Promise(function(resolve) {
    var img = new Image();
    var objUrl = URL.createObjectURL(file);
    img.onload = function() {
      URL.revokeObjectURL(objUrl);
      var MAX = 1600;
      var w = img.naturalWidth, h = img.naturalHeight;
      if (w > MAX || h > MAX) {
        if (w > h) { h = Math.round(h * MAX / w); w = MAX; }
        else       { w = Math.round(w * MAX / h); h = MAX; }
      }
      var canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(function(blob) {
        resolve(new File([blob], file.name || 'photo.jpg', { type: 'image/jpeg' }));
      }, 'image/jpeg', 0.85);
    };
    img.onerror = function() { resolve(file); }; // fallback: use original
    img.src = objUrl;
  });
}

async function uploadAttachment(recordId, fieldName, file) {
  // Compress before upload
  var uploadFile = await compressImage(file);

  // Get real field ID; fall back to field name if lookup fails
  var fieldIds = await fetchFieldIds();
  var fieldRef = (fieldIds && fieldIds[fieldName]) ? fieldIds[fieldName] : fieldName;

  var url = UPLOAD_URL + '/' + recordId + '/' + fieldRef + '/uploadAttachment';
  var fd = new FormData();
  fd.append('file', uploadFile, uploadFile.name || 'photo.jpg');
  // NOTE: do NOT set Content-Type — the browser sets multipart/form-data with boundary

  var resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + AIRTABLE_TOKEN },
    body: fd
  });

  if (!resp.ok) {
    var errText = await resp.text().catch(function() { return ''; });
    throw new Error('Photo upload failed (' + resp.status + '): ' + errText);
  }
  return resp.json();
}

/* ── 4. ROUTER ───────────────────────────────────────────────────────── */
function router() {
  var hash = window.location.hash || '#home';
  var parts = hash.replace('#', '').split('/');
  var route = parts[0];
  var param = parts[1];

  switch (route) {
    case 'home':   showHome();         break;
    case 'list':   showList();         break;
    case 'detail': showDetail(param);  break;
    case 'log':    showLog();          break;
    default:       window.location.hash = '#home';
  }
}

function navigate(hash) {
  window.location.hash = hash;
}

function activateView(name) {
  document.querySelectorAll('.view').forEach(function(v) {
    v.classList.remove('active');
  });
  var view = document.getElementById('view-' + name);
  view.classList.add('active');

  requestAnimationFrame(function() {
    if (name === 'home'   && state.homeMap)   state.homeMap.invalidateSize();
    if (name === 'detail' && state.detailMap) state.detailMap.invalidateSize();
  });
}

/* ── 5. HOME VIEW ────────────────────────────────────────────────────── */
async function showHome() {
  var view = document.getElementById('view-home');
  // Build shell once so the Leaflet map container survives navigations
  if (!document.getElementById('map-home')) {
    view.innerHTML =
      '<div class="app-banner">' +
        '<span class="app-banner-icon">&#x26F3;</span>' +
        '<span class="app-banner-title">Mike\'s Balls</span>' +
      '</div>' +
      '<div class="stats-bar" id="stats-bar">' +
        '<div class="stat-item"><div class="stat-value">&#8212;</div><div class="stat-label">Total</div></div>' +
        '<div class="stat-item"><div class="stat-value">&#8212;</div><div class="stat-label">This Month</div></div>' +
        '<div class="stat-item"><div class="stat-value">&#8212;</div><div class="stat-label">This Year</div></div>' +
      '</div>' +
      '<div id="map-home"></div>' +
      '<nav class="bottom-nav">' +
        '<button class="btn-nav" onclick="navigate(\'#list\')"><span class="nav-icon">&#9776;</span>All Finds</button>' +
        '<button class="btn-fab" onclick="navigate(\'#log\')" aria-label="Log a find">+</button>' +
      '</nav>';
  }

  activateView('home');

  if (state.records === null) {
    showLoading();
    try {
      await fetchAllRecords();
    } catch (e) {
      showToast(e.message || 'Failed to load data');
    } finally {
      hideLoading();
    }
  }

  renderStats();
  initHomeMap();
}

function renderStats() {
  var records = state.records || [];
  var now = new Date();
  var yr  = now.getFullYear();
  var mo  = now.getMonth();

  var thisMonth = 0;
  var thisYear  = 0;

  records.forEach(function(r) {
    var d = r.fields.Date;
    if (d) {
      var parts = d.split('-');
      var ry = parseInt(parts[0], 10);
      var rm = parseInt(parts[1], 10) - 1;
      if (ry === yr) thisYear++;
      if (ry === yr && rm === mo) thisMonth++;
    }
  });

  var bar = document.getElementById('stats-bar');
  if (!bar) return;
  bar.innerHTML =
    '<div class="stat-item"><div class="stat-value">' + records.length + '</div><div class="stat-label">Total</div></div>' +
    '<div class="stat-item"><div class="stat-value">' + thisMonth + '</div><div class="stat-label">This Month</div></div>' +
    '<div class="stat-item"><div class="stat-value">' + thisYear  + '</div><div class="stat-label">This Year</div></div>';
}

function initHomeMap() {
  var mapEl = document.getElementById('map-home');
  if (!mapEl) return;

  if (!state.mapsCreated.home) {
    state.homeMap = L.map('map-home', { zoomControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(state.homeMap);
    state.homeMarkers = L.layerGroup().addTo(state.homeMap);
    state.mapsCreated.home = true;
  }

  state.homeMarkers.clearLayers();
  var records = state.records || [];
  var bounds = [];

  records.forEach(function(record) {
    var lat = record.fields.Lat;
    var lng = record.fields.Long;
    if (lat == null || lng == null) return;

    var marker = L.marker([lat, lng], { icon: createBallIcon() });
    marker.bindPopup('<b>' + escHtml(record.fields.Brand || 'Unknown') + '</b><br>' + formatDate(record.fields.Date));
    marker.on('click', (function(id) {
      return function() { navigate('#detail/' + id); };
    })(record.id));
    state.homeMarkers.addLayer(marker);
    bounds.push([lat, lng]);
  });

  if (bounds.length === 0) {
    state.homeMap.setView([39.8283, -98.5795], 4);
  } else if (bounds.length === 1) {
    state.homeMap.setView(bounds[0], 14);
  } else {
    state.homeMap.fitBounds(bounds, { padding: [30, 30] });
  }

  state.homeMap.invalidateSize();
}

function createBallIcon(isNew) {
  return L.divIcon({
    className: '',
    html: '<div class="ball-pin' + (isNew ? ' ball-pin-new' : '') + '"></div>',
    iconSize: [24, 24],
    iconAnchor: [12, 24],
    popupAnchor: [0, -26]
  });
}

/* ── 6. LIST VIEW ────────────────────────────────────────────────────── */
async function showList() {
  var view = document.getElementById('view-list');
  if (!document.getElementById('list-content')) {
    view.innerHTML =
      '<header class="view-header">' +
        '<button class="btn-back" onclick="navigate(\'#home\')" aria-label="Back">&#8592;</button>' +
        '<h1>All Finds</h1>' +
      '</header>' +
      '<div class="list-scroll" id="list-content"></div>';
  }

  activateView('list');

  if (state.records === null) {
    showLoading();
    try { await fetchAllRecords(); }
    catch (e) { showToast(e.message || 'Failed to load data'); }
    finally { hideLoading(); }
  }

  renderList();
}

function renderList() {
  var content = document.getElementById('list-content');
  if (!content) return;
  var records = state.records || [];

  if (records.length === 0) {
    content.innerHTML = '<p class="empty-state">No finds yet — go log one!</p>';
    return;
  }

  content.innerHTML = records.map(function(record) {
    var fields = record.fields;
    var thumbUrl = fields.Image && fields.Image[0] && fields.Image[0].thumbnails && fields.Image[0].thumbnails.small
      ? fields.Image[0].thumbnails.small.url
      : null;

    var thumbHtml = thumbUrl
      ? '<img class="ball-thumb" src="' + escHtml(thumbUrl) + '" alt="' + escHtml(fields.Brand || 'Ball') + '" loading="lazy">'
      : '<div class="ball-thumb-placeholder">&#x26F3;</div>';

    return '<div class="ball-row" onclick="navigate(\'#detail/' + record.id + '\')">' +
      thumbHtml +
      '<div class="ball-info">' +
        '<div class="ball-date">' + formatDate(fields.Date) + '</div>' +
        '<div class="ball-meta">' + escHtml(fields.Brand || 'Unknown Brand') + (fields.Condition ? ' &middot; ' + escHtml(fields.Condition) : '') + '</div>' +
      '</div>' +
      '<span class="chevron">&#8250;</span>' +
    '</div>';
  }).join('');
}

/* ── 7. DETAIL VIEW ──────────────────────────────────────────────────── */
async function showDetail(recordId) {
  var view = document.getElementById('view-detail');
  view.innerHTML =
    '<header class="view-header">' +
      '<button class="btn-back" onclick="navigate(\'#list\')" aria-label="Back">&#8592;</button>' +
      '<h1>Find Details</h1>' +
      '<button class="btn-delete" onclick="deleteRecord(\'' + recordId + '\')" aria-label="Delete find">&#x1F5D1;</button>' +
    '</header>' +
    '<div id="map-detail"></div>' +
    '<div class="detail-scroll"><div id="detail-content"></div></div>';

  activateView('detail');

  if (state.records === null) {
    showLoading();
    try { await fetchAllRecords(); }
    catch (e) { showToast(e.message || 'Failed to load data'); }
    finally { hideLoading(); }
  }

  var record = null;
  var records = state.records || [];
  for (var i = 0; i < records.length; i++) {
    if (records[i].id === recordId) { record = records[i]; break; }
  }

  if (!record) {
    document.getElementById('detail-content').innerHTML = '<p class="empty-state">Record not found.</p>';
    return;
  }

  renderDetailMap(record);
  renderDetailContent(record);
}

function renderDetailMap(record) {
  var lat = record.fields.Lat;
  var lng = record.fields.Long;

  // Always destroy and recreate — showDetail always rebuilds the container
  if (state.detailMap) {
    state.detailMap.remove();
    state.detailMap = null;
  }

  state.detailMap = L.map('map-detail', { zoomControl: true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19
  }).addTo(state.detailMap);

  if (lat != null && lng != null) {
    state.detailMap.setView([lat, lng], 16);
    L.marker([lat, lng], { icon: createBallIcon() }).addTo(state.detailMap);
  } else {
    state.detailMap.setView([39.8283, -98.5795], 4);
  }

  state.detailMap.invalidateSize();
}

function renderDetailContent(record) {
  var fields = record.fields;
  var condClass = fields.Condition ? 'condition-' + fields.Condition.toLowerCase() : '';

  var photosHtml = '';
  if (fields.Image && fields.Image.length) {
    photosHtml =
      '<div class="photo-strip-header">Photos (' + fields.Image.length + ')</div>' +
      '<div class="photo-strip">' +
      fields.Image.map(function(img) {
        var thumb = img.thumbnails && img.thumbnails.large ? img.thumbnails.large.url : img.url;
        return '<img class="photo-strip-item" src="' + escHtml(thumb) + '" ' +
          'onclick="openLightbox(\'' + escHtml(img.url) + '\')" ' +
          'alt="' + escHtml(img.filename || 'Photo') + '" loading="lazy">';
      }).join('') +
      '</div>';
  } else {
    photosHtml = '<p class="no-photos">No photos for this find.</p>';
  }

  document.getElementById('detail-content').innerHTML =
    '<div class="detail-meta">' +
      '<div class="meta-row"><span class="meta-key">Date</span><span>' + formatDate(fields.Date) + '</span></div>' +
      '<div class="meta-row"><span class="meta-key">Brand</span><span>' + escHtml(fields.Brand || '&#8212;') + '</span></div>' +
      '<div class="meta-row"><span class="meta-key">Condition</span>' +
        '<span class="condition-badge ' + condClass + '">' + escHtml(fields.Condition || '&#8212;') + '</span>' +
      '</div>' +
      (fields.Lat != null ? '<div class="meta-row"><span class="meta-key">Location</span><span style="font-family:monospace;font-size:12px">' + fields.Lat.toFixed(5) + ', ' + fields.Long.toFixed(5) + '</span></div>' : '') +
    '</div>' +
    photosHtml;
}

/* ── 8. LOG VIEW ─────────────────────────────────────────────────────── */
function showLog() {
  if (state.gpsWatchId !== null) {
    navigator.geolocation.clearWatch(state.gpsWatchId);
    state.gpsWatchId = null;
  }
  state.gpsCoords = null;

  var view = document.getElementById('view-log');
  view.innerHTML =
    '<header class="view-header">' +
      '<button class="btn-back" onclick="abortLog()" aria-label="Back">&#8592;</button>' +
      '<h1>Log a Find</h1>' +
    '</header>' +
    '<div class="log-scroll">' +
    '<form class="log-form" id="log-form" onsubmit="submitLog(event)">' +

    '<div class="form-section">' +
      '<h2>Step 1 &middot; Location</h2>' +
      '<div class="gps-display" id="gps-display">Acquiring GPS&hellip;</div>' +
    '</div>' +

    '<div class="form-section">' +
      '<h2>Step 2 &middot; Photos</h2>' +
      '<div class="photo-inputs">' +
        buildPhotoInput(0, 'Wide Shot') +
        buildPhotoInput(1, 'Close-Up') +
        buildPhotoInput(2, 'In Hand') +
      '</div>' +
    '</div>' +

    '<div class="form-section">' +
      '<h2>Step 3 &middot; Details</h2>' +
      '<div class="form-field">' +
        '<label for="brand">Brand</label>' +
        '<input type="text" id="brand" placeholder="e.g. Titleist, Callaway" autocomplete="off">' +
      '</div>' +
      '<div class="form-field">' +
        '<label for="condition">Condition</label>' +
        '<select id="condition">' +
          '<option value="">Select condition&hellip;</option>' +
          '<option value="Mint">Mint</option>' +
          '<option value="Good">Good</option>' +
          '<option value="Fair">Fair</option>' +
          '<option value="Worn">Worn</option>' +
        '</select>' +
      '</div>' +
    '</div>' +

    '<button type="submit" class="btn-submit" id="submit-btn">Save Find</button>' +
    '</form></div>';

  activateView('log');
  startGPSWatch();
}

function buildPhotoInput(index, label) {
  return '<div>' +
    '<label class="photo-label" for="photo-' + index + '">' +
      '<div class="photo-preview-wrap" id="preview-wrap-' + index + '">' +
        '<span class="camera-icon">&#128247;</span>' +
        '<span>' + label + '</span>' +
      '</div>' +
    '</label>' +
    '<input type="file" id="photo-' + index + '" accept="image/*" capture="environment" ' +
      'class="photo-input" onchange="previewPhoto(this, ' + index + ')">' +
  '</div>';
}

function startGPSWatch() {
  if (!navigator.geolocation) {
    var el = document.getElementById('gps-display');
    if (el) { el.textContent = 'GPS not supported on this device.'; el.classList.add('gps-error'); }
    return;
  }

  state.gpsWatchId = navigator.geolocation.watchPosition(
    function(pos) {
      state.gpsCoords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      var acc = Math.round(pos.coords.accuracy);
      var el = document.getElementById('gps-display');
      if (el) {
        el.classList.remove('gps-error');
        el.innerHTML =
          'Lat: ' + state.gpsCoords.lat.toFixed(6) + '<br>' +
          'Lng: ' + state.gpsCoords.lng.toFixed(6) + '<br>' +
          '<small style="opacity:0.7">&plusmn;' + acc + 'm accuracy</small>';
      }
    },
    function(err) {
      var messages = {
        1: 'Location permission denied. Enable in browser/device settings.',
        2: 'Location unavailable. Try again outside.',
        3: 'GPS timed out. Move to open sky and retry.'
      };
      var el = document.getElementById('gps-display');
      if (el) {
        el.textContent = messages[err.code] || 'GPS error.';
        el.classList.add('gps-error');
      }
    },
    { enableHighAccuracy: true, timeout: 30000, maximumAge: 10000 }
  );
}

function abortLog() {
  if (state.gpsWatchId !== null) {
    navigator.geolocation.clearWatch(state.gpsWatchId);
    state.gpsWatchId = null;
  }
  navigate('#home');
}

function previewPhoto(input, index) {
  if (!input.files || !input.files[0]) return;
  var url = URL.createObjectURL(input.files[0]);
  var wrap = document.getElementById('preview-wrap-' + index);
  if (wrap) wrap.innerHTML = '<img class="photo-preview" src="' + url + '" alt="Preview">';
}

async function submitLog(event) {
  event.preventDefault();

  if (!state.gpsCoords) {
    showToast('Waiting for GPS — please wait');
    return;
  }

  var brand     = document.getElementById('brand').value.trim();
  var condition = document.getElementById('condition').value;
  var photos    = [0, 1, 2].map(function(i) {
    var el = document.getElementById('photo-' + i);
    return (el && el.files && el.files[0]) ? el.files[0] : null;
  });

  var btn = document.getElementById('submit-btn');
  btn.disabled = true;
  btn.textContent = 'Saving\u2026';

  showLoading();

  try {
    var fields = {
      Date: new Date().toISOString().split('T')[0],
      Lat:  parseFloat(state.gpsCoords.lat),
      Long: parseFloat(state.gpsCoords.lng)
    };
    if (brand)     fields.Brand     = brand;
    if (condition) fields.Condition = condition;

    var record = await createRecord(fields);
    var recordId = record.id;

    var photoFiles = photos.filter(function(f) { return f !== null; });
    for (var i = 0; i < photoFiles.length; i++) {
      try {
        await uploadAttachment(recordId, 'Image', photoFiles[i]);
      } catch (uploadErr) {
        console.error('Photo upload failed:', uploadErr);
        showToast('Photo ' + (i + 1) + ' failed: ' + uploadErr.message, 5000);
      }
    }

    state.records = null;

    if (state.gpsWatchId !== null) {
      navigator.geolocation.clearWatch(state.gpsWatchId);
      state.gpsWatchId = null;
    }

    hideLoading();
    showToast('Find logged!');
    navigate('#home');

  } catch (err) {
    hideLoading();
    btn.disabled = false;
    btn.textContent = 'Save Find';
    showToast(err.message || 'Failed to save — please try again');
  }
}

/* ── 9. UTILITIES ────────────────────────────────────────────────────── */
var loadingCount = 0;

function showLoading() {
  loadingCount++;
  document.getElementById('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0) {
    document.getElementById('loading-overlay').classList.add('hidden');
  }
}

var toastTimer = null;

function showToast(message, duration) {
  duration = duration || 3000;
  var toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(function() {
    toast.classList.add('hidden');
  }, duration);
}

function openLightbox(url) {
  document.getElementById('lightbox-img').src = url;
  document.getElementById('lightbox').classList.remove('hidden');
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lightbox-img').src = '';
}

function formatDate(dateStr) {
  if (!dateStr) return '&#8212;';
  var parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  var d = new Date(Date.UTC(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10)));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function escHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ── 10. INIT ────────────────────────────────────────────────────────── */
document.getElementById('lightbox').addEventListener('click', function(e) {
  if (e.target === e.currentTarget) closeLightbox();
});
document.getElementById('lightbox-close').addEventListener('click', closeLightbox);

window.addEventListener('hashchange', router);

window.addEventListener('DOMContentLoaded', function() {
  if (!window.location.hash || window.location.hash === '#') {
    window.location.hash = '#home';
  } else {
    router();
  }
});
