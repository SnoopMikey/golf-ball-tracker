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
  if (!confirm('Strike this entry from the logbook? This cannot be undone.')) return;
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
    showToast('Entry struck from the logbook.');
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

function fileToBase64(file) {
  return new Promise(function(resolve, reject) {
    var reader = new FileReader();
    reader.onload = function() { resolve(reader.result.split(',')[1]); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

async function uploadAttachment(recordId, fieldName, file) {
  var uploadFile = await compressImage(file);
  var b64 = await fileToBase64(uploadFile);

  // Get real field ID; hardcoded fallback is from metadata API for this base
  var KNOWN_FIELD_IDS = { Image: 'fldvFcQcom2ysqkFJ' };
  var fieldIds = await fetchFieldIds();
  var fieldRef = (fieldIds && fieldIds[fieldName])
    ? fieldIds[fieldName]
    : (KNOWN_FIELD_IDS[fieldName] || fieldName);

  var url = UPLOAD_URL + '/' + recordId + '/' + fieldRef + '/uploadAttachment';

  var resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + AIRTABLE_TOKEN,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contentType: uploadFile.type || 'image/jpeg',
      filename: uploadFile.name || 'photo.jpg',
      file: b64
    })
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

var FLIP_MS = 500;
var ROUTE_DEPTH = { home: 0, list: 1, detail: 2, log: 3 };
var currentDepth = 0;

function activateView(name) {
  var newView = document.getElementById('view-' + name);
  var current = document.querySelector('.view.active');
  var newDepth = ROUTE_DEPTH[name] != null ? ROUTE_DEPTH[name] : 0;
  var direction = (current && newDepth < currentDepth) ? 'back' : 'forward';
  currentDepth = newDepth;

  function refreshMaps() {
    if (name === 'home'   && state.homeMap)   state.homeMap.invalidateSize();
    if (name === 'detail' && state.detailMap) state.detailMap.invalidateSize();
  }

  // Re-activating the same view — no flip.
  if (current === newView) {
    requestAnimationFrame(refreshMaps);
    return;
  }

  // First load (no prior view) — just appear.
  if (!current) {
    newView.classList.add('active');
    requestAnimationFrame(refreshMaps);
    setTimeout(refreshMaps, FLIP_MS + 60);
    return;
  }

  // Brass spine glow runs in either direction
  var app = document.getElementById('app');
  if (app) {
    app.classList.add('is-flipping');
    setTimeout(function() { app.classList.remove('is-flipping'); }, FLIP_MS);
  }

  if (direction === 'forward') {
    // Old lifts off the spine and rotates over the top; new is revealed underneath.
    current.classList.remove('active');
    current.classList.add('exiting');
    var leaving = current;
    setTimeout(function() {
      leaving.style.transition = 'none';
      leaving.classList.remove('exiting');
      void leaving.offsetWidth;
      leaving.style.transition = '';
    }, FLIP_MS);

    newView.classList.add('active');
  } else {
    // Back: new view comes up from where it was last "flipped to" — rotateY(-180)
    // — and unfolds back to flat on top of the page being left behind. Old stays
    // in place visible underneath until the flip lands.
    newView.style.transition = 'none';
    newView.style.transform = 'rotateY(-180deg)';
    newView.classList.add('flipping-in');         // visibility + z-index 3
    void newView.offsetWidth;                     // force reflow

    newView.style.transition = '';
    newView.style.transform = '';                 // CSS rotateY(0) takes over → animates
    newView.classList.add('active');

    var landing = newView;
    var leavingBack = current;
    setTimeout(function() {
      leavingBack.classList.remove('active');     // old becomes invisible behind landed new
      landing.classList.remove('flipping-in');    // back to z-index 2
    }, FLIP_MS);
  }

  requestAnimationFrame(refreshMaps);
  setTimeout(refreshMaps, FLIP_MS + 60);
}

/* ── 5. HOME VIEW ────────────────────────────────────────────────────── */
async function showHome() {
  var view = document.getElementById('view-home');
  // Build shell once so the Leaflet map container survives navigations
  if (!document.getElementById('map-home')) {
    view.innerHTML =
      '<div class="app-banner">' +
        '<button type="button" class="app-banner-title-btn" onclick="openSplash()" aria-label="Show splash image">' +
          '<span class="app-banner-title">Mike\'s Balls</span>' +
          '<span class="app-banner-rule" aria-hidden="true">' +
            '<span class="app-banner-ornament">&#10086;</span>' +
          '</span>' +
        '</button>' +
      '</div>' +
      '<div class="stats-bar" id="stats-bar">' +
        '<div class="stat-item"><div class="stat-value">&#8212;</div><div class="stat-label">Total</div></div>' +
        '<div class="stat-item"><div class="stat-value">&#8212;</div><div class="stat-label">This Month</div></div>' +
        '<div class="stat-item"><div class="stat-value">&#8212;</div><div class="stat-label">This Year</div></div>' +
      '</div>' +
      '<div id="map-home"></div>' +
      '<nav class="bottom-nav">' +
        '<button class="btn-nav" onclick="navigate(\'#list\')">' +
          '<span class="btn-nav-text">The Logbook</span>' +
          '<span class="btn-nav-arrow" aria-hidden="true">&#8250;</span>' +
        '</button>' +
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
    marker.bindPopup(buildPopupHtml(record));
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
    iconSize: [26, 26],
    iconAnchor: [13, 13],
    popupAnchor: [0, -14]
  });
}

function buildPopupHtml(record) {
  var f = record.fields;
  return '<div class="popup-card">' +
    '<div class="popup-eyebrow">Brand</div>' +
    '<div class="popup-brand">' + escHtml(f.Brand || 'Unknown') + '</div>' +
    '<div class="popup-rule"><span class="popup-rule-ornament">&#10086;</span></div>' +
    '<div class="popup-date">' + formatDate(f.Date) + '</div>' +
  '</div>';
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
    content.innerHTML =
      '<div class="empty-state">' +
        '<div class="empty-state-headline">The logbook is empty.</div>' +
        '<div class="empty-state-sub">Find a ball.</div>' +
      '</div>';
    return;
  }

  var total = records.length;

  var rowsHtml = records.map(function(record, idx) {
    var fields = record.fields;
    var findNo = total - idx;     // newest record gets highest number
    var noStr  = String(findNo).padStart(3, '0');

    var thumbUrl = fields.Image && fields.Image[0] && fields.Image[0].thumbnails && fields.Image[0].thumbnails.small
      ? fields.Image[0].thumbnails.small.url
      : null;

    var thumbHtml = thumbUrl
      ? '<img class="ball-thumb" src="' + escHtml(thumbUrl) + '" alt="' + escHtml(fields.Brand || 'Ball') + '" loading="lazy">'
      : '<div class="ball-thumb-placeholder"><span>&#8212;</span></div>';

    var brand = fields.Brand || 'Unknown';
    var condition = fields.Condition || '';
    var metaHtml = escHtml(brand);
    if (condition) {
      metaHtml += ' <span class="ball-meta-sep">&middot;</span> ' +
        '<span class="ball-meta-condition">' + escHtml(condition.toLowerCase()) + '</span>';
    }

    return '<div class="ball-row" onclick="navigate(\'#detail/' + record.id + '\')">' +
      thumbHtml +
      '<div class="ball-info">' +
        '<div class="ball-no">No. ' + noStr + '</div>' +
        '<div class="ball-date">' + formatDate(fields.Date) + '</div>' +
        '<div class="ball-meta">' + metaHtml + '</div>' +
      '</div>' +
      '<span class="chevron">&#8250;</span>' +
    '</div>';
  }).join('');

  content.innerHTML = '<div class="register">' + rowsHtml + '</div>';
}

/* ── 7. DETAIL VIEW ──────────────────────────────────────────────────── */
async function showDetail(recordId) {
  var view = document.getElementById('view-detail');
  view.innerHTML =
    '<header class="view-header">' +
      '<button class="btn-back" onclick="navigate(\'#list\')" aria-label="Back">&#8592;</button>' +
      '<h1>Entry</h1>' +
      '<button class="btn-delete" onclick="deleteRecord(\'' + recordId + '\')" aria-label="Delete find">&#x1F5D1;</button>' +
    '</header>' +
    '<div class="detail-scroll"><div id="detail-content"></div></div>';

  activateView('detail');

  if (state.records === null) {
    showLoading();
    try { await fetchAllRecords(); }
    catch (e) { showToast(e.message || 'Failed to load data'); }
    finally { hideLoading(); }
  }

  var record = null;
  var recordIdx = -1;
  var records = state.records || [];
  for (var i = 0; i < records.length; i++) {
    if (records[i].id === recordId) { record = records[i]; recordIdx = i; break; }
  }

  if (!record) {
    document.getElementById('detail-content').innerHTML =
      '<div class="empty-state">' +
        '<div class="empty-state-headline">No such entry.</div>' +
        '<div class="empty-state-sub">Return to logbook</div>' +
      '</div>';
    return;
  }

  var findNo = records.length - recordIdx;
  renderDetailContent(record, findNo);
  renderDetailMap(record);
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

function metaRow(key, valHtml) {
  return '<div class="meta-row">' +
    '<span class="meta-key">' + key + '</span>' +
    '<span class="meta-leader" aria-hidden="true"></span>' +
    '<span class="meta-val">' + valHtml + '</span>' +
  '</div>';
}

function renderDetailContent(record, findNo) {
  var fields = record.fields;
  var noStr = String(findNo).padStart(3, '0');

  var rows = [];
  rows.push(metaRow('Brand', escHtml(fields.Brand || '—')));
  if (fields.Condition) {
    var cls = 'condition-' + fields.Condition.toLowerCase();
    rows.push(metaRow('Condition',
      '<span class="condition-badge ' + cls + '">' + escHtml(fields.Condition.toLowerCase()) + '</span>'));
  } else {
    rows.push(metaRow('Condition', '—'));
  }
  if (fields.Lat != null) {
    rows.push(metaRow('Coordinates',
      '<span class="meta-coord">' + fields.Lat.toFixed(5) + ', ' + fields.Long.toFixed(5) + '</span>'));
  }
  if (fields.Time) {
    rows.push(metaRow('Time', escHtml(fields.Time)));
  }

  var photosHtml = '';
  if (fields.Image && fields.Image.length) {
    var urls = fields.Image.map(function(img) { return img.url; });
    window._detailPhotoUrls = urls;
    photosHtml =
      '<div class="section-label"><span>Photographs</span></div>' +
      '<div class="photo-strip">' +
      fields.Image.map(function(img, idx) {
        var thumb = img.thumbnails && img.thumbnails.large ? img.thumbnails.large.url : img.url;
        return '<img class="photo-strip-item" src="' + escHtml(thumb) + '" ' +
          'onclick="openLightbox(window._detailPhotoUrls, ' + idx + ')" ' +
          'alt="' + escHtml(img.filename || 'Photo') + '" loading="lazy">';
      }).join('') +
      '</div>';
  } else {
    photosHtml =
      '<div class="section-label"><span>Photographs</span></div>' +
      '<p class="no-photos">No photographs on file.</p>';
  }

  document.getElementById('detail-content').innerHTML =
    '<div class="find-header">' +
      '<div class="find-no-eyebrow">Find</div>' +
      '<div class="find-no-number">No.&nbsp;' + noStr + '</div>' +
      '<div class="find-no-date">' + formatDate(fields.Date) + '</div>' +
      '<div class="find-no-rule"><span class="find-no-ornament">&#10086;</span></div>' +
    '</div>' +
    '<div id="map-detail"></div>' +
    '<div class="section-label"><span>Particulars</span></div>' +
    '<div class="meta-list">' + rows.join('') + '</div>' +
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
      '<h1>New Entry</h1>' +
    '</header>' +
    '<div class="log-scroll">' +
    '<form class="log-form" id="log-form" onsubmit="submitLog(event)">' +

    '<div class="section-label"><span>I &middot; Location</span></div>' +
    '<div class="form-section">' +
      '<div class="gps-display" id="gps-display">Acquiring GPS&hellip;</div>' +
    '</div>' +

    '<div class="section-label"><span>II &middot; Photographs</span></div>' +
    '<div class="form-section">' +
      '<div class="photo-inputs">' +
        buildPhotoInput(0, 'Wide Shot') +
        buildPhotoInput(1, 'Close-Up') +
        buildPhotoInput(2, 'In Hand') +
      '</div>' +
    '</div>' +

    '<div class="section-label"><span>III &middot; Particulars</span></div>' +
    '<div class="form-section">' +
      '<div class="form-field">' +
        '<label for="brand">Brand</label>' +
        '<input type="text" id="brand" placeholder="Titleist, Callaway, &hellip;" autocomplete="off">' +
      '</div>' +
      '<div class="form-field">' +
        '<label for="condition">Condition</label>' +
        '<select id="condition">' +
          '<option value="">Select &hellip;</option>' +
          '<option value="Mint">Mint</option>' +
          '<option value="Good">Good</option>' +
          '<option value="Fair">Fair</option>' +
          '<option value="Worn">Worn</option>' +
        '</select>' +
      '</div>' +
    '</div>' +

    '<button type="submit" class="btn-submit" id="submit-btn">Record Entry</button>' +
    '</form></div>';

  activateView('log');
  startGPSWatch();
}

function buildPhotoInput(index, label) {
  var roman = ['I', 'II', 'III'][index] || (index + 1);
  return '<div>' +
    '<label class="photo-label" for="photo-' + index + '">' +
      '<div class="photo-preview-wrap" id="preview-wrap-' + index + '">' +
        '<span class="photo-roman">' + roman + '</span>' +
        '<span class="photo-label-text">' + label + '</span>' +
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
  if (wrap) {
    wrap.innerHTML = '<img class="photo-preview" src="' + url + '" alt="Preview">';
    wrap.classList.add('filled');
  }
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
  btn.textContent = 'Recording\u2026';

  showLoading();

  try {
    var now = new Date();
    var fields = {
      Date: now.toISOString().split('T')[0],
      Time: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
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
    showToast('Entry recorded.');
    navigate('#home');

  } catch (err) {
    hideLoading();
    btn.disabled = false;
    btn.textContent = 'Record Entry';
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

/* ── Lightbox / photo viewer ─────────────────────────────────────────── */
var lb = {
  urls: [],
  index: 0,
  scale: 1, tx: 0, ty: 0,           // active image transform
  startScale: 1, startTx: 0, startTy: 0,
  startDist: 0, startMidX: 0, startMidY: 0,
  swipeStartX: 0, swipeStartY: 0,
  swipeDx: 0,
  mode: 'none',                      // 'none' | 'swipe' | 'pinch' | 'pan'
  lastTap: 0,
  trackEl: null
};

function openLightbox(urls, index) {
  if (!Array.isArray(urls)) urls = [urls];
  lb.urls = urls;
  lb.index = Math.max(0, Math.min(index || 0, urls.length - 1));
  lb.scale = 1; lb.tx = 0; lb.ty = 0;

  var track = document.getElementById('lightbox-track');
  lb.trackEl = track;
  track.innerHTML = urls.map(function(u) {
    return '<div class="lb-slide"><img src="' + escHtml(u) + '" alt="Photo"></div>';
  }).join('');

  document.getElementById('lightbox').classList.remove('hidden');
  updateCounter();
  positionTrack(false);
  applyImgTransform(false);
}

function closeLightbox() {
  document.getElementById('lightbox').classList.add('hidden');
  document.getElementById('lightbox-track').innerHTML = '';
  lb.urls = [];
  lb.mode = 'none';
}

function updateCounter() {
  var el = document.getElementById('lightbox-counter');
  if (!el) return;
  if (lb.urls.length > 1) {
    el.textContent = (lb.index + 1) + ' / ' + lb.urls.length;
    el.style.display = '';
  } else {
    el.style.display = 'none';
  }
}

function positionTrack(animate) {
  if (!lb.trackEl) return;
  lb.trackEl.classList.toggle('animating', !!animate);
  var dx = (lb.mode === 'swipe') ? lb.swipeDx : 0;
  var x = -lb.index * lb.trackEl.clientWidth + dx;
  lb.trackEl.style.transform = 'translate3d(' + x + 'px,0,0)';
}

function activeImg() {
  if (!lb.trackEl) return null;
  return lb.trackEl.children[lb.index] && lb.trackEl.children[lb.index].querySelector('img');
}

function applyImgTransform(animate) {
  // Reset transform on all slides except active
  if (!lb.trackEl) return;
  for (var i = 0; i < lb.trackEl.children.length; i++) {
    var img = lb.trackEl.children[i].querySelector('img');
    if (!img) continue;
    if (i === lb.index) {
      img.classList.toggle('animating', !!animate);
      img.style.transform = 'translate3d(' + lb.tx + 'px,' + lb.ty + 'px,0) scale(' + lb.scale + ')';
    } else {
      img.classList.remove('animating');
      img.style.transform = '';
    }
  }
}

function clampPan() {
  // Allow panning so the image doesn't fly far off-screen at low zoom
  var img = activeImg();
  if (!img) return;
  var slide = img.parentElement;
  var sw = slide.clientWidth, sh = slide.clientHeight;
  var iw = img.clientWidth * lb.scale;
  var ih = img.clientHeight * lb.scale;
  var maxX = Math.max(0, (iw - sw) / 2);
  var maxY = Math.max(0, (ih - sh) / 2);
  if (lb.tx >  maxX) lb.tx =  maxX;
  if (lb.tx < -maxX) lb.tx = -maxX;
  if (lb.ty >  maxY) lb.ty =  maxY;
  if (lb.ty < -maxY) lb.ty = -maxY;
}

function lbTouchStart(e) {
  if (e.touches.length === 2) {
    e.preventDefault();
    lb.mode = 'pinch';
    var t1 = e.touches[0], t2 = e.touches[1];
    var dx = t2.clientX - t1.clientX;
    var dy = t2.clientY - t1.clientY;
    lb.startDist  = Math.sqrt(dx*dx + dy*dy) || 1;
    lb.startScale = lb.scale;
    lb.startTx    = lb.tx;
    lb.startTy    = lb.ty;
    lb.startMidX  = (t1.clientX + t2.clientX) / 2;
    lb.startMidY  = (t1.clientY + t2.clientY) / 2;
  } else if (e.touches.length === 1) {
    var t = e.touches[0];
    lb.swipeStartX = t.clientX;
    lb.swipeStartY = t.clientY;
    lb.swipeDx = 0;
    if (lb.scale > 1.01) {
      lb.mode = 'pan';
      lb.startTx = lb.tx;
      lb.startTy = lb.ty;
    } else {
      lb.mode = 'swipe';
    }

    // Double-tap detection
    var now = Date.now();
    if (now - lb.lastTap < 300) {
      e.preventDefault();
      toggleZoom(t.clientX, t.clientY);
      lb.lastTap = 0;
      lb.mode = 'none';
      return;
    }
    lb.lastTap = now;
  }
}

function lbTouchMove(e) {
  if (lb.mode === 'pinch' && e.touches.length === 2) {
    e.preventDefault();
    var t1 = e.touches[0], t2 = e.touches[1];
    var dx = t2.clientX - t1.clientX;
    var dy = t2.clientY - t1.clientY;
    var dist = Math.sqrt(dx*dx + dy*dy) || 1;
    var newScale = lb.startScale * (dist / lb.startDist);
    newScale = Math.max(1, Math.min(5, newScale));
    lb.scale = newScale;

    // Keep pinch midpoint roughly stable
    var midX = (t1.clientX + t2.clientX) / 2;
    var midY = (t1.clientY + t2.clientY) / 2;
    lb.tx = lb.startTx + (midX - lb.startMidX);
    lb.ty = lb.startTy + (midY - lb.startMidY);

    if (lb.scale <= 1.01) { lb.tx = 0; lb.ty = 0; }
    else clampPan();
    applyImgTransform(false);
  } else if (lb.mode === 'pan' && e.touches.length === 1) {
    e.preventDefault();
    var tp = e.touches[0];
    lb.tx = lb.startTx + (tp.clientX - lb.swipeStartX);
    lb.ty = lb.startTy + (tp.clientY - lb.swipeStartY);
    clampPan();
    applyImgTransform(false);
  } else if (lb.mode === 'swipe' && e.touches.length === 1) {
    var ts = e.touches[0];
    var dxs = ts.clientX - lb.swipeStartX;
    var dys = ts.clientY - lb.swipeStartY;
    // If clearly vertical, ignore — let close-on-tap still work
    if (Math.abs(dys) > Math.abs(dxs) && Math.abs(dys) > 12) return;
    e.preventDefault();
    // Resist at edges
    if ((lb.index === 0 && dxs > 0) || (lb.index === lb.urls.length - 1 && dxs < 0)) {
      dxs *= 0.3;
    }
    lb.swipeDx = dxs;
    positionTrack(false);
  }
}

function lbTouchEnd(e) {
  if (lb.mode === 'pinch') {
    if (lb.scale < 1.05) {
      lb.scale = 1; lb.tx = 0; lb.ty = 0;
      applyImgTransform(true);
    } else {
      clampPan();
      applyImgTransform(true);
    }
    // If still touching with one finger, transition to pan
    if (e.touches.length === 1) {
      lb.mode = (lb.scale > 1.01) ? 'pan' : 'swipe';
      lb.swipeStartX = e.touches[0].clientX;
      lb.swipeStartY = e.touches[0].clientY;
      lb.startTx = lb.tx; lb.startTy = lb.ty;
      lb.swipeDx = 0;
    } else {
      lb.mode = 'none';
    }
  } else if (lb.mode === 'swipe') {
    var w = lb.trackEl ? lb.trackEl.clientWidth : window.innerWidth;
    var threshold = Math.min(80, w * 0.18);
    if (lb.swipeDx <= -threshold && lb.index < lb.urls.length - 1) {
      lb.index++;
    } else if (lb.swipeDx >= threshold && lb.index > 0) {
      lb.index--;
    }
    lb.swipeDx = 0;
    lb.mode = 'none';
    lb.scale = 1; lb.tx = 0; lb.ty = 0;
    updateCounter();
    positionTrack(true);
    applyImgTransform(true);
  } else if (lb.mode === 'pan') {
    lb.mode = 'none';
  }
}

function toggleZoom(px, py) {
  if (lb.scale > 1.01) {
    lb.scale = 1; lb.tx = 0; lb.ty = 0;
  } else {
    lb.scale = 2.5;
    var img = activeImg();
    if (img) {
      var rect = img.getBoundingClientRect();
      var cx = rect.left + rect.width / 2;
      var cy = rect.top + rect.height / 2;
      lb.tx = (cx - px) * (lb.scale - 1) / lb.scale;
      lb.ty = (cy - py) * (lb.scale - 1) / lb.scale;
    }
    clampPan();
  }
  applyImgTransform(true);
}

/* ── Splash overlay ──────────────────────────────────────────────────── */
function openSplash() {
  document.getElementById('splash-overlay').classList.remove('hidden');
}

function closeSplash() {
  document.getElementById('splash-overlay').classList.add('hidden');
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
(function initLightbox() {
  var box = document.getElementById('lightbox');
  var track = document.getElementById('lightbox-track');

  document.getElementById('lightbox-close').addEventListener('click', closeLightbox);

  track.addEventListener('touchstart', lbTouchStart, { passive: false });
  track.addEventListener('touchmove',  lbTouchMove,  { passive: false });
  track.addEventListener('touchend',   lbTouchEnd);
  track.addEventListener('touchcancel', lbTouchEnd);

  // Reposition on resize/orientation
  window.addEventListener('resize', function() {
    if (!box.classList.contains('hidden')) {
      positionTrack(false);
      applyImgTransform(false);
    }
  });
})();

(function initSplash() {
  var splash = document.getElementById('splash-overlay');
  splash.classList.add('hidden');
  splash.addEventListener('click', function(e) {
    if (e.target === splash) closeSplash();
  });
  document.getElementById('splash-close').addEventListener('click', closeSplash);
})();

window.addEventListener('hashchange', router);

window.addEventListener('DOMContentLoaded', function() {
  if (!window.location.hash || window.location.hash === '#') {
    window.location.hash = '#home';
  } else {
    router();
  }
});
