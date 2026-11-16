/**
 * BioDent Tomografías - Sistema Offline-First de Gestión de Radiología Odontológica y Comisiones
 * Almacenamiento 100% Local: LocalStorage + Espejo en IndexedDB sin dependencias externas
 */

const STORAGE_KEYS = {
  RECORDS: 'biodent_records_v2',
  SAFEGUARD_RECORDS: 'biodent_records_safeguard_v2',
  DOCTORS: 'biodent_doctors_v2',
  PROVINCES: 'biodent_provinces_v2',
  TARIFFS: 'biodent_tariffs_v2',
  CLOUD_UPDATED_AT: 'biodent_cloud_updated_at_v2'
};

const FIREBASE_DB_URL = 'https://biodent-sistema-default-rtdb.firebaseio.com/biodent_cloud_v2.json';
let isSyncingCloud = false;
let pendingCloudPush = false;

const DEFAULT_DOCTORS = [];

const DEFAULT_PROVINCES = [
  'Chota',
  'Cutervo',
  'Jaén',
  'Piura',
  'Bambamarca',
  'Cajamarca',
  'San Ignacio',
  'Santa Cruz',
  'Celendín',
  'Chiclayo'
];

const DEFAULT_TARIFFS = {
  'Panorámica': { price: 80, commission: 20 },
  'Cefalométrica': { price: 80, commission: 20 },
  'Periapical': { price: 25, commission: 0 },
  'Tomografía Cone Beam': { price: 180, commission: 40 }
};

let state = {
  records: [],
  doctors: [],
  provinces: [],
  tariffs: { ...DEFAULT_TARIFFS },
  selectedPlates: ['Panorámica'],
  editSelectedPlates: ['Panorámica'],
  dateFilterMode: 'month', // 'today' | 'week' | 'month' | 'all' | 'custom'
  customStartDate: '',
  customEndDate: '',
  pendingDeleteId: null
};

/* ==========================================================================
   1. PERSISTENCIA LOCAL (LocalStorage + Respaldo Asíncrono en IndexedDB)
   ========================================================================== */

function initIndexedDBMirror() {
  if (!window.indexedDB) return;
  const req = window.indexedDB.open('BioDentOfflineDB', 1);
  req.onupgradeneeded = (e) => {
    const db = e.target.result;
    if (!db.objectStoreNames.contains('snapshots')) {
      db.createObjectStore('snapshots', { keyPath: 'id' });
    }
  };
}

function mirrorToIndexedDB() {
  if (!window.indexedDB) return;
  try {
    const req = window.indexedDB.open('BioDentOfflineDB', 1);
    req.onsuccess = (e) => {
      const db = e.target.result;
      const tx = db.transaction('snapshots', 'readwrite');
      const store = tx.objectStore('snapshots');
      const payload = {
        updatedAt: new Date().toISOString(),
        records: state.records,
        doctors: state.doctors,
        provinces: state.provinces,
        tariffs: state.tariffs
      };
      store.put({ id: 'latest_backup', ...payload });
      if (Array.isArray(state.records) && state.records.length > 0) {
        store.put({ id: 'last_non_empty_backup', ...payload });
      }
    };
  } catch (_) {
    // Fallback silencioso a LocalStorage
  }
}

function tryRecoverFromIndexedDB() {
  if (!window.indexedDB) return;
  try {
    const req = window.indexedDB.open('BioDentOfflineDB', 1);
    req.onsuccess = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('snapshots')) return;
      const tx = db.transaction('snapshots', 'readonly');
      const store = tx.objectStore('snapshots');
      const getNonEmpty = store.get('last_non_empty_backup');
      getNonEmpty.onsuccess = () => {
        const snap = getNonEmpty.result;
        if (snap && Array.isArray(snap.records) && snap.records.length > 0 && state.records.length === 0) {
          state.records = snap.records;
          if (Array.isArray(snap.doctors) && snap.doctors.length > 0) state.doctors = snap.doctors;
          if (Array.isArray(snap.provinces) && snap.provinces.length > 0) state.provinces = snap.provinces;
          saveStateToStorage();
          populateDatalists();
          renderAll();
        } else {
          const getLatest = store.get('latest_backup');
          getLatest.onsuccess = () => {
            const latest = getLatest.result;
            if (latest && Array.isArray(latest.records) && latest.records.length > 0 && state.records.length === 0) {
              state.records = latest.records;
              if (Array.isArray(latest.doctors) && latest.doctors.length > 0) state.doctors = latest.doctors;
              if (Array.isArray(latest.provinces) && latest.provinces.length > 0) state.provinces = latest.provinces;
              saveStateToStorage();
              populateDatalists();
              renderAll();
            }
          };
        }
      };
    };
  } catch (_) {}
}

function loadStateFromStorage() {
  try {
    // Limpiar claves antiguas de prueba v1 si existieran
    localStorage.removeItem('biodent_records_v1');
    localStorage.removeItem('biodent_doctors_v1');
    localStorage.removeItem('biodent_initialized_v1');

    const savedDoctors = localStorage.getItem(STORAGE_KEYS.DOCTORS);
    const savedProvinces = localStorage.getItem(STORAGE_KEYS.PROVINCES);
    const savedTariffs = localStorage.getItem(STORAGE_KEYS.TARIFFS);
    const savedRecords = localStorage.getItem(STORAGE_KEYS.RECORDS);
    const safeguardRecords = localStorage.getItem(STORAGE_KEYS.SAFEGUARD_RECORDS);

    state.doctors = savedDoctors ? JSON.parse(savedDoctors) : [...DEFAULT_DOCTORS];
    state.provinces = savedProvinces ? JSON.parse(savedProvinces) : [...DEFAULT_PROVINCES];
    state.tariffs = savedTariffs ? { ...DEFAULT_TARIFFS, ...JSON.parse(savedTariffs) } : { ...DEFAULT_TARIFFS };
    if (state.tariffs['Periapical']) {
      state.tariffs['Periapical'].commission = 0;
    }

    let parsedRecords = savedRecords ? JSON.parse(savedRecords) : [];
    if ((!Array.isArray(parsedRecords) || parsedRecords.length === 0) && safeguardRecords) {
      const parsedSafe = JSON.parse(safeguardRecords);
      if (Array.isArray(parsedSafe) && parsedSafe.length > 0) {
        parsedRecords = parsedSafe;
      }
    }
    state.records = Array.isArray(parsedRecords) ? parsedRecords : [];

    if (state.records.length === 0) {
      tryRecoverFromIndexedDB();
    }
  } catch (err) {
    console.error('Error cargando LocalStorage:', err);
    state.doctors = [...DEFAULT_DOCTORS];
    state.provinces = [...DEFAULT_PROVINCES];
    state.tariffs = { ...DEFAULT_TARIFFS };
    state.records = [];
  }
}

function updateCloudBadgeUI(status, text) {
  const badge = document.getElementById('cloud-sync-badge');
  if (!badge) return;
  if (status === 'online') {
    badge.style.background = '#ecfdf5';
    badge.style.borderColor = '#6ee7b7';
    badge.style.color = '#065f46';
    badge.textContent = text || '☁️ Nube Sincronizada';
  } else if (status === 'syncing') {
    badge.style.background = '#f0f9ff';
    badge.style.borderColor = '#7dd3fc';
    badge.style.color = '#0369a1';
    badge.textContent = text || '🔄 Sincronizando...';
  } else {
    badge.style.background = '#fffbeb';
    badge.style.borderColor = '#fcd34d';
    badge.style.color = '#92400e';
    badge.textContent = text || '📴 Modo Local (Offline)';
  }
}

async function pushToCloudDatabase(isExplicitClear = false) {
  if (!navigator.onLine) {
    pendingCloudPush = true;
    updateCloudBadgeUI('offline');
    return;
  }
  try {
    updateCloudBadgeUI('syncing');
    const nowTs = Date.now();
    localStorage.setItem(STORAGE_KEYS.CLOUD_UPDATED_AT, String(nowTs));
    const payload = {
      updatedAt: nowTs,
      clearedAt: isExplicitClear ? nowTs : Number(localStorage.getItem('biodent_cleared_at_v2') || 0),
      records: state.records,
      doctors: state.doctors,
      provinces: state.provinces,
      tariffs: state.tariffs
    };
    const res = await fetch(FIREBASE_DB_URL, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (res.ok) {
      pendingCloudPush = false;
      updateCloudBadgeUI('online');
    } else {
      updateCloudBadgeUI('offline');
    }
  } catch (_) {
    pendingCloudPush = true;
    updateCloudBadgeUI('offline');
  }
}

async function pullFromCloudDatabase(isInitialBoot = false) {
  if (!navigator.onLine || isSyncingCloud) {
    if (!navigator.onLine) updateCloudBadgeUI('offline');
    return;
  }
  isSyncingCloud = true;
  try {
    const res = await fetch(FIREBASE_DB_URL, { cache: 'no-store' });
    if (!res.ok) {
      updateCloudBadgeUI('offline');
      isSyncingCloud = false;
      return;
    }
    const cloudData = await res.json();

    // Si la nube aún está vacía pero esta PC tiene datos, subirlos a la nube
    if (!cloudData) {
      if (state.records.length > 0 || state.doctors.length > 0) {
        await pushToCloudDatabase(false);
      } else {
        updateCloudBadgeUI('online');
      }
      isSyncingCloud = false;
      return;
    }

    const cloudUpdatedAt = Number(cloudData.updatedAt || 0);
    const localUpdatedAt = Number(localStorage.getItem(STORAGE_KEYS.CLOUD_UPDATED_AT) || 0);
    const cloudClearedAt = Number(cloudData.clearedAt || 0);
    const localClearedAt = Number(localStorage.getItem('biodent_cleared_at_v2') || 0);

    // Si en otro dispositivo se dio clic en "Dejar en Cero" más recientemente
    if (cloudClearedAt > localClearedAt && (!Array.isArray(cloudData.records) || cloudData.records.length === 0)) {
      localStorage.setItem('biodent_cleared_at_v2', String(cloudClearedAt));
      localStorage.setItem(STORAGE_KEYS.CLOUD_UPDATED_AT, String(cloudUpdatedAt));
      localStorage.removeItem(STORAGE_KEYS.SAFEGUARD_RECORDS);
      state.records = [];
      state.doctors = Array.isArray(cloudData.doctors) ? cloudData.doctors : [];
      state.provinces = Array.isArray(cloudData.provinces) ? cloudData.provinces : [...DEFAULT_PROVINCES];
      if (cloudData.tariffs) state.tariffs = { ...DEFAULT_TARIFFS, ...cloudData.tariffs };
      saveStateToStorage(false);
      populateDatalists();
      renderAll();
      updateCloudBadgeUI('online');
      isSyncingCloud = false;
      return;
    }

    const cloudRecords = Array.isArray(cloudData.records) ? cloudData.records : [];

    // En el arranque inicial, o si la nube tiene cambios más recientes, sincronizar
    if (isInitialBoot || cloudUpdatedAt > localUpdatedAt || state.records.length === 0) {
      if (cloudUpdatedAt >= localUpdatedAt) {
        state.records = cloudRecords;
      } else {
        // Combinar si hubiera algún registro local creado sin internet
        const mergedMap = new Map();
        cloudRecords.forEach((r) => {
          if (r && r.id) mergedMap.set(r.id, r);
        });
        state.records.forEach((r) => {
          if (r && r.id && !mergedMap.has(r.id)) mergedMap.set(r.id, r);
        });
        state.records = Array.from(mergedMap.values()).sort((a, b) =>
          (b.datetime || '').localeCompare(a.datetime || '')
        );
      }

      if (Array.isArray(cloudData.doctors)) {
        cloudData.doctors.forEach((d) => ensureCatalogEntry(state.doctors, d));
      }
      if (Array.isArray(cloudData.provinces)) {
        cloudData.provinces.forEach((p) => ensureCatalogEntry(state.provinces, p));
      }
      if (cloudData.tariffs) {
        state.tariffs = { ...DEFAULT_TARIFFS, ...cloudData.tariffs };
        if (state.tariffs['Periapical']) state.tariffs['Periapical'].commission = 0;
      }

      localStorage.setItem(STORAGE_KEYS.CLOUD_UPDATED_AT, String(Math.max(cloudUpdatedAt, localUpdatedAt)));
      saveStateToStorage(false);
      populateDatalists();
      renderAll();

      if (pendingCloudPush || state.records.length > cloudRecords.length) {
        await pushToCloudDatabase(false);
      }
    }
    updateCloudBadgeUI('online');
  } catch (_) {
    updateCloudBadgeUI('offline');
  } finally {
    isSyncingCloud = false;
  }
}

function forceCloudSyncNow() {
  if (pendingCloudPush) {
    pushToCloudDatabase(false);
  } else {
    pullFromCloudDatabase(true);
  }
}

function saveStateToStorage(syncCloud = true) {
  localStorage.setItem(STORAGE_KEYS.RECORDS, JSON.stringify(state.records));
  if (Array.isArray(state.records) && state.records.length > 0) {
    localStorage.setItem(STORAGE_KEYS.SAFEGUARD_RECORDS, JSON.stringify(state.records));
  }
  localStorage.setItem(STORAGE_KEYS.DOCTORS, JSON.stringify(state.doctors));
  localStorage.setItem(STORAGE_KEYS.PROVINCES, JSON.stringify(state.provinces));
  localStorage.setItem(STORAGE_KEYS.TARIFFS, JSON.stringify(state.tariffs));
  mirrorToIndexedDB();
  if (syncCloud) {
    pushToCloudDatabase(false);
  }
}

function resetAllDataToZero() {
  if (!confirm('¿Está seguro de dejar todo el sistema en CERO (eliminar todos los registros y doctores de prueba)?')) {
    return;
  }
  state.records = [];
  state.doctors = [];
  state.provinces = [...DEFAULT_PROVINCES];
  const nowTs = Date.now();
  localStorage.setItem('biodent_cleared_at_v2', String(nowTs));
  localStorage.removeItem(STORAGE_KEYS.SAFEGUARD_RECORDS);
  saveStateToStorage(false);
  pushToCloudDatabase(true);
  populateDatalists();
  renderAll();
  showToast('Sistema reiniciado en CERO en este equipo y en la nube.');
}

/* ==========================================================================
   2. UTILIDADES DE FECHA Y MONEDA
   ========================================================================== */

function formatCurrency(val) {
  const num = Number(val) || 0;
  return 'S/ ' + num.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getLocalNowISOString() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
}

function setNowToDateTimeInput(inputId) {
  const el = document.getElementById(inputId);
  if (el) {
    el.value = getLocalNowISOString();
    syncDmyFromInput(inputId);
  }
}

function formatYMDToDMY(ymdStr) {
  if (!ymdStr || typeof ymdStr !== 'string') return '...';
  const parts = ymdStr.slice(0, 10).split('-');
  if (parts.length !== 3) return ymdStr;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function getDaysInMonth(year, month) {
  return new Date(Number(year), Number(month), 0).getDate();
}

function initDmyControls() {
  document.querySelectorAll('.dmy-control').forEach((ctrl) => {
    const targetId = ctrl.dataset.target;
    if (targetId) {
      syncDmyFromInput(targetId);
    }
  });
}

function syncDmyFromInput(inputId) {
  const inputEl = document.getElementById(inputId);
  const ctrl = document.querySelector(`.dmy-control[data-target="${inputId}"]`);
  if (!inputEl || !ctrl) return;

  let val = inputEl.value;
  if (!val) {
    val = getLocalNowISOString();
    inputEl.value = ctrl.dataset.hasTime === 'true' ? val : val.slice(0, 10);
  }

  const datePart = val.slice(0, 10);
  const timePart = val.length >= 16 ? val.slice(11, 16) : '08:00';
  const [yStr, mStr, dStr] = datePart.split('-');
  const pad = (n) => String(n).padStart(2, '0');
  const year = Number(yStr) || new Date().getFullYear();
  const month = pad(Number(mStr) || 1);
  const day = pad(Number(dStr) || 1);

  const textInp = ctrl.querySelector('.dmy-text-input');
  const timeInp = ctrl.querySelector('.dmy-time');

  if (textInp) {
    textInp.value = `${day}/${month}/${year}`;
  }
  if (timeInp) {
    timeInp.value = timePart;
  }
}

function applyDmyDateToHiddenInput(inputId, dayNum, monthNum, yearNum, updateTextInput = false) {
  const inputEl = document.getElementById(inputId);
  const ctrl = document.querySelector(`.dmy-control[data-target="${inputId}"]`);
  if (!inputEl || !ctrl) return;

  const year = Math.min(Math.max(2000, Number(yearNum) || new Date().getFullYear()), 2100);
  const month = Math.min(Math.max(1, Number(monthNum) || 1), 12);
  const maxDays = getDaysInMonth(year, month);
  const day = Math.min(Math.max(1, Number(dayNum) || 1), maxDays);
  const pad = (n) => String(n).padStart(2, '0');

  const ymd = `${year}-${pad(month)}-${pad(day)}`;
  const textInp = ctrl.querySelector('.dmy-text-input');
  const timeInp = ctrl.querySelector('.dmy-time');

  if (updateTextInput && textInp) {
    textInp.value = `${pad(day)}/${pad(month)}/${year}`;
  }

  if (ctrl.dataset.hasTime === 'true') {
    const hm = timeInp?.value || '08:00';
    inputEl.value = `${ymd}T${hm}`;
  } else {
    inputEl.value = ymd;
  }

  if (inputId === 'filter-date-start' || inputId === 'filter-date-end') {
    applyCustomDateRange();
  }
}

function onDmyTextInput(inputId) {
  const ctrl = document.querySelector(`.dmy-control[data-target="${inputId}"]`);
  if (!ctrl) return;
  const textInp = ctrl.querySelector('.dmy-text-input');
  if (!textInp) return;

  const digits = textInp.value.replace(/\D/g, '').slice(0, 8);
  let formatted = '';
  if (digits.length <= 2) {
    formatted = digits;
  } else if (digits.length <= 4) {
    formatted = `${digits.slice(0, 2)}/${digits.slice(2)}`;
  } else {
    formatted = `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`;
  }

  textInp.value = formatted;

  // Cuando completa los 8 dígitos (DDMMAAAA), aplica y valida de inmediato
  if (digits.length === 8) {
    const d = Number(digits.slice(0, 2));
    const m = Number(digits.slice(2, 4));
    const y = Number(digits.slice(4, 8));
    applyDmyDateToHiddenInput(inputId, d, m, y, true);
  }
}

function onDmyTextBlur(inputId) {
  const ctrl = document.querySelector(`.dmy-control[data-target="${inputId}"]`);
  if (!ctrl) return;
  const textInp = ctrl.querySelector('.dmy-text-input');
  if (!textInp) return;

  const digits = textInp.value.replace(/\D/g, '');
  if (digits.length === 8) {
    applyDmyDateToHiddenInput(
      inputId,
      Number(digits.slice(0, 2)),
      Number(digits.slice(2, 4)),
      Number(digits.slice(4, 8)),
      true
    );
  } else if (digits.length === 6) {
    // Permite escribir DDMMAA (ej. 161126 -> 16/11/2026)
    applyDmyDateToHiddenInput(
      inputId,
      Number(digits.slice(0, 2)),
      Number(digits.slice(2, 4)),
      2000 + Number(digits.slice(4, 6)),
      true
    );
  } else {
    // Si quedó incompleto, restaura la fecha válida actual del campo oculto
    syncDmyFromInput(inputId);
  }
}

function onDmyTimeChange(inputId) {
  const inputEl = document.getElementById(inputId);
  const ctrl = document.querySelector(`.dmy-control[data-target="${inputId}"]`);
  if (!inputEl || !ctrl) return;
  const timeInp = ctrl.querySelector('.dmy-time');
  const datePart = (inputEl.value || getLocalNowISOString()).slice(0, 10);
  const hm = timeInp?.value || '08:00';
  inputEl.value = `${datePart}T${hm}`;
}

function openNativePicker(inputId) {
  const inputEl = document.getElementById(inputId);
  if (!inputEl) return;
  try {
    if (typeof inputEl.showPicker === 'function') {
      inputEl.showPicker();
    } else {
      inputEl.focus();
      inputEl.click();
    }
  } catch (_) {
    inputEl.focus();
  }
}

function formatReadableDateTime(isoStr) {
  if (!isoStr) return '-';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  const pad = (n) => String(n).padStart(2, '0');
  const day = pad(d.getDate());
  const month = pad(d.getMonth() + 1);
  const year = d.getFullYear();
  let hours = d.getHours();
  const mins = pad(d.getMinutes());
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${day}/${month}/${year} ${pad(hours)}:${mins} ${ampm}`;
}

function escapeHTML(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ==========================================================================
   3. FILTRADO POR RANGO DE FECHAS Y BÚSQUEDA EN TIEMPO REAL
   ========================================================================== */

function setDateRangeFilter(mode) {
  state.dateFilterMode = mode;
  document.querySelectorAll('.chip-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.range === mode);
  });

  const customBox = document.getElementById('custom-date-box');
  if (mode === 'custom') {
    customBox.style.display = 'flex';
    if (!state.customStartDate) {
      const todayStr = getLocalNowISOString().slice(0, 10);
      state.customStartDate = todayStr;
      state.customEndDate = todayStr;
      document.getElementById('filter-date-start').value = todayStr;
      document.getElementById('filter-date-end').value = todayStr;
    }
    syncDmyFromInput('filter-date-start');
    syncDmyFromInput('filter-date-end');
  } else {
    customBox.style.display = 'none';
  }

  renderAll();
}

function applyCustomDateRange() {
  state.customStartDate = document.getElementById('filter-date-start').value;
  state.customEndDate = document.getElementById('filter-date-end').value;
  renderAll();
}

function isRecordWithinSelectedDateRange(rec) {
  if (state.dateFilterMode === 'all') return true;
  if (!rec.datetime) return false;

  const recDateStr = rec.datetime.slice(0, 10); // YYYY-MM-DD
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const todayStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  if (state.dateFilterMode === 'today') {
    return recDateStr === todayStr;
  }

  if (state.dateFilterMode === 'week') {
    const startOfWeek = new Date(now);
    const dayOfWeek = startOfWeek.getDay() || 7; // Lunes = 1 ... Domingo = 7
    startOfWeek.setDate(startOfWeek.getDate() - dayOfWeek + 1);
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(endOfWeek.getDate() + 6);
    endOfWeek.setHours(23, 59, 59, 999);
    const recDate = new Date(rec.datetime);
    return recDate >= startOfWeek && recDate <= endOfWeek;
  }

  if (state.dateFilterMode === 'month') {
    const currentYearMonth = todayStr.slice(0, 7);
    return recDateStr.slice(0, 7) === currentYearMonth;
  }

  if (state.dateFilterMode === 'custom') {
    if (state.customStartDate && recDateStr < state.customStartDate) return false;
    if (state.customEndDate && recDateStr > state.customEndDate) return false;
    return true;
  }

  return true;
}

function getRecordsForPeriod() {
  return state.records
    .filter(isRecordWithinSelectedDateRange)
    .sort((a, b) => (b.datetime || '').localeCompare(a.datetime || ''));
}

function getPaymentSplit(r) {
  const amt = Number(r.amount) || 0;
  if (r.paymentMethod === 'Mixto') {
    const ef = Number(r.amountEfectivo) || 0;
    const yp = Number(r.amountYape) || 0;
    return { efectivo: ef, yape: yp };
  }
  if (r.paymentMethod === 'Yape') {
    return { efectivo: 0, yape: amt };
  }
  return { efectivo: amt, yape: 0 };
}

const CANONICAL_PLATES_ORDER = [
  'Panorámica',
  'Cefalométrica',
  'Periapical',
  'Tomografía Cone Beam'
];

function getRecordPlatesList(r) {
  if (!r) return ['Panorámica'];
  if (Array.isArray(r.plateTypes) && r.plateTypes.length > 0) {
    return r.plateTypes.map((p) => String(p).trim()).filter(Boolean);
  }
  const raw = String(r.plateType || 'Panorámica');
  const list = raw
    .split(/\s*\+\s*|\s*,\s*/)
    .map((p) => p.trim())
    .filter(Boolean);
  return list.length > 0 ? list : ['Panorámica'];
}

function isPlateListOnlyPeriapical(platesList) {
  return Array.isArray(platesList) && platesList.length > 0 && platesList.every((p) => p === 'Periapical');
}

function isRecordOnlyPeriapical(r) {
  return isPlateListOnlyPeriapical(getRecordPlatesList(r));
}

function getRecordPlateShares(r) {
  const plates = getRecordPlatesList(r);
  const totalAmt = Number(r.amount) || 0;
  const totalComm = isRecordOnlyPeriapical(r) ? 0 : Number(r.commission) || 0;

  if (plates.length <= 1) {
    return [{ plate: plates[0] || 'Panorámica', amount: totalAmt, comm: totalComm }];
  }

  let sumTariffPrice = 0;
  let sumTariffComm = 0;
  plates.forEach((p) => {
    const t = state.tariffs[p] || { price: 0, commission: 0 };
    sumTariffPrice += Number(t.price) || 0;
    if (p !== 'Periapical') {
      sumTariffComm += Number(t.commission) || 0;
    }
  });

  let accAmt = 0;
  let accComm = 0;
  const nonPeriapicalCount = plates.filter((p) => p !== 'Periapical').length;

  return plates.map((p, idx) => {
    const isLast = idx === plates.length - 1;
    const t = state.tariffs[p] || { price: 0, commission: 0 };
    let shareAmt = 0;
    if (isLast) {
      shareAmt = Math.max(0, Math.round((totalAmt - accAmt) * 100) / 100);
    } else if (sumTariffPrice > 0) {
      shareAmt = Math.round(((Number(t.price) || 0) / sumTariffPrice) * totalAmt * 100) / 100;
      accAmt += shareAmt;
    } else {
      shareAmt = Math.round((totalAmt / plates.length) * 100) / 100;
      accAmt += shareAmt;
    }

    let shareComm = 0;
    if (p === 'Periapical') {
      shareComm = 0;
    } else if (isLast || (nonPeriapicalCount === 1)) {
      shareComm = Math.max(0, Math.round((totalComm - accComm) * 100) / 100);
      accComm += shareComm;
    } else if (sumTariffComm > 0) {
      shareComm = Math.round(((Number(t.commission) || 0) / sumTariffComm) * totalComm * 100) / 100;
      accComm += shareComm;
    } else {
      shareComm = Math.round((totalComm / Math.max(1, nonPeriapicalCount)) * 100) / 100;
      accComm += shareComm;
    }

    return { plate: p, amount: shareAmt, comm: shareComm };
  });
}

function getFilteredRecordsForTable() {
  const periodRecords = getRecordsForPeriod();
  const q = (document.getElementById('search-input')?.value || '').trim().toLowerCase();
  const docFilter = document.getElementById('filter-doctor')?.value || 'ALL';
  const commFilter = document.getElementById('filter-comm-status')?.value || 'ALL';
  const plateFilter = document.getElementById('filter-plate')?.value || 'ALL';
  const payFilter = document.getElementById('filter-payment')?.value || 'ALL';
  const provFilter = document.getElementById('filter-province')?.value || 'ALL';

  return periodRecords.filter((r) => {
    if (docFilter !== 'ALL' && r.doctor !== docFilter) return false;
    if (commFilter === 'PENDING' && ((Number(r.commission) || 0) <= 0 || r.commissionPaid)) return false;
    if (commFilter === 'PAID' && ((Number(r.commission) || 0) <= 0 || !r.commissionPaid)) return false;
    if (plateFilter !== 'ALL' && !getRecordPlatesList(r).includes(plateFilter)) return false;
    if (payFilter !== 'ALL' && r.paymentMethod !== payFilter) return false;
    if (provFilter !== 'ALL' && r.province !== provFilter) return false;
    if (q) {
      const hay = `${r.patient} ${r.doctor} ${r.province} ${r.plateType}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function filterByDoctorQuick(doctorName) {
  switchView('view-operations');
  const sel = document.getElementById('filter-doctor');
  if (sel) {
    sel.value = doctorName;
  }
  renderAll();
}

function clearDoctorFilter() {
  const sel = document.getElementById('filter-doctor');
  if (sel) sel.value = 'ALL';
  const searchEl = document.getElementById('search-input');
  if (searchEl) searchEl.value = '';
  renderAll();
}

/* ==========================================================================
   4. FORMULARIO DE REGISTRO Y EVENTOS INTERACTIVOS (SELECCIÓN MÚLTIPLE)
   ========================================================================== */

function applySelectedPlatesToForm() {
  if (!Array.isArray(state.selectedPlates) || state.selectedPlates.length === 0) {
    state.selectedPlates = ['Panorámica'];
  }

  // Ordenar según orden canónico
  state.selectedPlates.sort(
    (a, b) => CANONICAL_PLATES_ORDER.indexOf(a) - CANONICAL_PLATES_ORDER.indexOf(b)
  );

  const combinedString = state.selectedPlates.join(' + ');
  const hiddenInp = document.getElementById('inp-plate-type');
  if (hiddenInp) hiddenInp.value = combinedString;

  document.querySelectorAll('#plate-selector-cards .plate-option').forEach((card) => {
    card.classList.toggle('selected', state.selectedPlates.includes(card.dataset.plate));
  });

  let totalPrice = 0;
  let totalComm = 0;
  state.selectedPlates.forEach((p) => {
    const t = state.tariffs[p] || { price: 0, commission: 0 };
    totalPrice += Number(t.price) || 0;
    if (p !== 'Periapical') {
      totalComm += Number(t.commission) || 0;
    }
  });

  document.getElementById('inp-amount').value = totalPrice;

  const commInput = document.getElementById('inp-commission');
  const commGroup = document.getElementById('commission-input-group');
  const priceCommRow = document.getElementById('price-comm-row');
  const statusGroup = document.getElementById('form-comm-status-group');

  const onlyPeriapical = isPlateListOnlyPeriapical(state.selectedPlates);
  if (onlyPeriapical) {
    commInput.value = 0;
    if (commGroup) commGroup.style.display = 'none';
    if (priceCommRow) priceCommRow.style.gridTemplateColumns = '1fr';
    if (statusGroup) statusGroup.style.display = 'none';
  } else {
    commInput.value = totalComm;
    if (commGroup) commGroup.style.display = 'block';
    if (priceCommRow) priceCommRow.style.gridTemplateColumns = '1fr 1fr';
    if (statusGroup) statusGroup.style.display = 'block';
  }

  handleTotalAmountChange();
}

function selectPlateType(plateType, forceSingle = false) {
  if (forceSingle) {
    state.selectedPlates = [plateType];
  } else {
    const idx = state.selectedPlates.indexOf(plateType);
    if (idx !== -1) {
      if (state.selectedPlates.length > 1) {
        state.selectedPlates.splice(idx, 1);
      } else {
        // Si hace clic en la única seleccionada, se mantiene seleccionada
        return;
      }
    } else {
      state.selectedPlates.push(plateType);
    }
  }
  applySelectedPlatesToForm();
}

function selectFormCommissionStatus(isPaid) {
  document.getElementById('inp-comm-paid').value = isPaid ? 'true' : 'false';
  document.getElementById('comm-opt-pending')?.classList.toggle('selected', !isPaid);
  document.getElementById('comm-opt-paid')?.classList.toggle('selected', isPaid);
}

function selectPaymentMethod(method) {
  document.getElementById('inp-payment-method').value = method;
  document.getElementById('pay-opt-efectivo')?.classList.toggle('selected', method === 'Efectivo');
  document.getElementById('pay-opt-yape')?.classList.toggle('selected', method === 'Yape');
  document.getElementById('pay-opt-mixto')?.classList.toggle('selected', method === 'Mixto');

  const mixBox = document.getElementById('mixed-payment-box');
  if (mixBox) {
    if (method === 'Mixto') {
      mixBox.style.display = 'block';
      const total = parseFloat(document.getElementById('inp-amount').value) || 0;
      const half = Math.round((total / 2) * 2) / 2;
      document.getElementById('inp-mix-efectivo').value = half.toFixed(2);
      document.getElementById('inp-mix-yape').value = Math.max(0, total - half).toFixed(2);
    } else {
      mixBox.style.display = 'none';
    }
  }
}

function handleTotalAmountChange() {
  const method = document.getElementById('inp-payment-method')?.value;
  if (method === 'Mixto') {
    const total = parseFloat(document.getElementById('inp-amount').value) || 0;
    const ef = parseFloat(document.getElementById('inp-mix-efectivo').value) || 0;
    const newYape = Math.max(0, total - ef);
    document.getElementById('inp-mix-yape').value = newYape.toFixed(2);
  }
  updateNetPreview();
}

function handleMixSplitInput(changedField) {
  const total = parseFloat(document.getElementById('inp-amount').value) || 0;
  if (changedField === 'efectivo') {
    let ef = parseFloat(document.getElementById('inp-mix-efectivo').value) || 0;
    if (ef > total) {
      ef = total;
      document.getElementById('inp-mix-efectivo').value = ef;
    }
    document.getElementById('inp-mix-yape').value = Math.max(0, total - ef).toFixed(2);
  } else {
    let yp = parseFloat(document.getElementById('inp-mix-yape').value) || 0;
    if (yp > total) {
      yp = total;
      document.getElementById('inp-mix-yape').value = yp;
    }
    document.getElementById('inp-mix-efectivo').value = Math.max(0, total - yp).toFixed(2);
  }
}

function applyCommissionPercent(pct) {
  const plateType = document.getElementById('inp-plate-type').value;
  if (plateType === 'Periapical') return;
  const amount = parseFloat(document.getElementById('inp-amount').value) || 0;
  const comm = Math.round(amount * (pct / 100) * 2) / 2;
  document.getElementById('inp-commission').value = comm.toFixed(2);
  updateNetPreview();
}

function updateNetPreview() {
  const amount = parseFloat(document.getElementById('inp-amount').value) || 0;
  const onlyPeriapical = isPlateListOnlyPeriapical(state.selectedPlates);
  const comm = onlyPeriapical ? 0 : parseFloat(document.getElementById('inp-commission').value) || 0;
  const net = amount - comm;
  const el = document.getElementById('order-net-preview');
  if (el) {
    el.textContent = formatCurrency(net);
    el.style.color = net >= 0 ? 'var(--brand-emerald-700)' : 'var(--danger-600)';
  }
}

function resetOrderForm() {
  setNowToDateTimeInput('inp-datetime');
  document.getElementById('inp-patient').value = '';
  document.getElementById('inp-doctor').value = '';
  document.getElementById('inp-province').value = '';
  selectPlateType('Panorámica', true);
  selectPaymentMethod('Efectivo');
  selectFormCommissionStatus(false);
}

function ensureCatalogEntry(list, val) {
  const clean = val.trim();
  if (!clean) return;
  const exists = list.some((item) => item.toLowerCase() === clean.toLowerCase());
  if (!exists) {
    list.push(clean);
  }
}

function handleSaveOrder(e) {
  e.preventDefault();

  const datetime = document.getElementById('inp-datetime').value || getLocalNowISOString();
  const patient = document.getElementById('inp-patient').value.trim();
  const doctor = document.getElementById('inp-doctor').value.trim();
  const province = document.getElementById('inp-province').value.trim();
  const plateTypes = Array.isArray(state.selectedPlates) && state.selectedPlates.length > 0
    ? [...state.selectedPlates]
    : ['Panorámica'];
  const plateType = plateTypes.join(' + ');
  const onlyPeriapical = isPlateListOnlyPeriapical(plateTypes);
  const amount = parseFloat(document.getElementById('inp-amount').value) || 0;
  const commission = onlyPeriapical ? 0 : parseFloat(document.getElementById('inp-commission').value) || 0;
  const paymentMethod = document.getElementById('inp-payment-method').value;
  const commissionPaid =
    onlyPeriapical || commission <= 0
      ? false
      : document.getElementById('inp-comm-paid').value === 'true';

  if (!patient || !doctor || !province) {
    showToast('Por favor complete todos los campos obligatorios.', true);
    return;
  }

  let amountEfectivo = 0;
  let amountYape = 0;
  if (paymentMethod === 'Mixto') {
    amountEfectivo = parseFloat(document.getElementById('inp-mix-efectivo').value) || 0;
    amountYape = parseFloat(document.getElementById('inp-mix-yape').value) || 0;
    if (Math.abs(amountEfectivo + amountYape - amount) > 0.05) {
      showToast('En Pago Mixto, la suma de Efectivo + Yape debe coincidir con el Monto Total.', true);
      return;
    }
  } else if (paymentMethod === 'Yape') {
    amountYape = amount;
  } else {
    amountEfectivo = amount;
  }

  ensureCatalogEntry(state.doctors, doctor);
  ensureCatalogEntry(state.provinces, province);

  const newRecord = {
    id: 'ORD-' + Date.now(),
    datetime,
    patient,
    doctor,
    province,
    plateType,
    plateTypes,
    amount,
    commission,
    paymentMethod,
    amountEfectivo,
    amountYape,
    commissionPaid
  };

  state.records.unshift(newRecord);
  saveStateToStorage();
  populateDatalists();
  resetOrderForm();
  renderAll();

  showToast(`Orden registrada: ${patient} (${plateType})`);
}

/* ==========================================================================
   5. EDICIÓN, ELIMINACIÓN Y LIQUIDACIÓN DE COMISIONES
   ========================================================================== */

function syncEditPlatesUI(recalculateTotals = false) {
  if (!Array.isArray(state.editSelectedPlates) || state.editSelectedPlates.length === 0) {
    state.editSelectedPlates = ['Panorámica'];
  }
  state.editSelectedPlates.sort(
    (a, b) => CANONICAL_PLATES_ORDER.indexOf(a) - CANONICAL_PLATES_ORDER.indexOf(b)
  );

  const combined = state.editSelectedPlates.join(' + ');
  const editPlateInp = document.getElementById('edit-plate');
  if (editPlateInp) editPlateInp.value = combined;

  document.querySelectorAll('#edit-plate-selector-cards .plate-option').forEach((card) => {
    card.classList.toggle('selected', state.editSelectedPlates.includes(card.dataset.plate));
  });

  if (recalculateTotals) {
    let totalPrice = 0;
    let totalComm = 0;
    state.editSelectedPlates.forEach((p) => {
      const t = state.tariffs[p] || { price: 0, commission: 0 };
      totalPrice += Number(t.price) || 0;
      if (p !== 'Periapical') {
        totalComm += Number(t.commission) || 0;
      }
    });
    document.getElementById('edit-amount').value = totalPrice;
    document.getElementById('edit-commission').value = totalComm;
    handleEditAmountChange();
  }

  handleEditPlateChange();
}

function toggleEditPlateType(plateType) {
  const idx = state.editSelectedPlates.indexOf(plateType);
  if (idx !== -1) {
    if (state.editSelectedPlates.length > 1) {
      state.editSelectedPlates.splice(idx, 1);
    } else {
      return;
    }
  } else {
    state.editSelectedPlates.push(plateType);
  }
  syncEditPlatesUI(true);
}

function handleEditPlateChange() {
  const onlyPeriapical = isPlateListOnlyPeriapical(state.editSelectedPlates);
  const commInp = document.getElementById('edit-commission');
  const statusGroup = document.getElementById('edit-comm-status-group');
  if (onlyPeriapical) {
    commInp.value = 0;
    commInp.disabled = true;
    commInp.style.background = 'var(--slate-100)';
    if (statusGroup) statusGroup.style.display = 'none';
  } else {
    commInp.disabled = false;
    commInp.style.background = '#ffffff';
    if (statusGroup) statusGroup.style.display = 'block';
  }
}

function handleEditPaymentChange() {
  const method = document.getElementById('edit-payment').value;
  const mixBox = document.getElementById('edit-mixed-box');
  if (method === 'Mixto') {
    mixBox.style.display = 'block';
    const amt = parseFloat(document.getElementById('edit-amount').value) || 0;
    const half = Math.round((amt / 2) * 2) / 2;
    document.getElementById('edit-mix-efectivo').value = half.toFixed(2);
    document.getElementById('edit-mix-yape').value = Math.max(0, amt - half).toFixed(2);
  } else {
    mixBox.style.display = 'none';
  }
}

function handleEditAmountChange() {
  const method = document.getElementById('edit-payment').value;
  if (method === 'Mixto') {
    const total = parseFloat(document.getElementById('edit-amount').value) || 0;
    const ef = parseFloat(document.getElementById('edit-mix-efectivo').value) || 0;
    document.getElementById('edit-mix-yape').value = Math.max(0, total - ef).toFixed(2);
  }
}

function handleEditMixSplit(changedField) {
  const total = parseFloat(document.getElementById('edit-amount').value) || 0;
  if (changedField === 'efectivo') {
    let ef = parseFloat(document.getElementById('edit-mix-efectivo').value) || 0;
    if (ef > total) ef = total;
    document.getElementById('edit-mix-yape').value = Math.max(0, total - ef).toFixed(2);
  } else {
    let yp = parseFloat(document.getElementById('edit-mix-yape').value) || 0;
    if (yp > total) yp = total;
    document.getElementById('edit-mix-efectivo').value = Math.max(0, total - yp).toFixed(2);
  }
}

function openEditModal(id) {
  const rec = state.records.find((r) => r.id === id);
  if (!rec) return;

  state.editSelectedPlates = getRecordPlatesList(rec);

  document.getElementById('edit-id').value = rec.id;
  document.getElementById('edit-datetime').value = rec.datetime;
  syncDmyFromInput('edit-datetime');
  document.getElementById('edit-patient').value = rec.patient;
  document.getElementById('edit-doctor').value = rec.doctor;
  document.getElementById('edit-province').value = rec.province;
  document.getElementById('edit-payment').value = rec.paymentMethod;
  document.getElementById('edit-amount').value = rec.amount;
  document.getElementById('edit-commission').value = isRecordOnlyPeriapical(rec) ? 0 : rec.commission;
  document.getElementById('edit-comm-paid').value = String(Boolean(rec.commissionPaid));

  syncEditPlatesUI(false);

  const mixBox = document.getElementById('edit-mixed-box');
  if (rec.paymentMethod === 'Mixto') {
    mixBox.style.display = 'block';
    const split = getPaymentSplit(rec);
    document.getElementById('edit-mix-efectivo').value = split.efectivo.toFixed(2);
    document.getElementById('edit-mix-yape').value = split.yape.toFixed(2);
  } else {
    mixBox.style.display = 'none';
  }

  document.getElementById('edit-modal').classList.add('open');
}

function handleUpdateOrder(e) {
  e.preventDefault();
  const id = document.getElementById('edit-id').value;
  const idx = state.records.findIndex((r) => r.id === id);
  if (idx === -1) return;

  const doctor = document.getElementById('edit-doctor').value.trim();
  const province = document.getElementById('edit-province').value.trim();
  const plateTypes = Array.isArray(state.editSelectedPlates) && state.editSelectedPlates.length > 0
    ? [...state.editSelectedPlates]
    : ['Panorámica'];
  const plateType = plateTypes.join(' + ');
  const onlyPeriapical = isPlateListOnlyPeriapical(plateTypes);
  const paymentMethod = document.getElementById('edit-payment').value;
  const amount = parseFloat(document.getElementById('edit-amount').value) || 0;
  const commission = onlyPeriapical ? 0 : parseFloat(document.getElementById('edit-commission').value) || 0;

  let amountEfectivo = 0;
  let amountYape = 0;
  if (paymentMethod === 'Mixto') {
    amountEfectivo = parseFloat(document.getElementById('edit-mix-efectivo').value) || 0;
    amountYape = parseFloat(document.getElementById('edit-mix-yape').value) || 0;
    if (Math.abs(amountEfectivo + amountYape - amount) > 0.05) {
      showToast('En Pago Mixto, la suma de Efectivo + Yape debe ser igual al Monto Total.', true);
      return;
    }
  } else if (paymentMethod === 'Yape') {
    amountYape = amount;
  } else {
    amountEfectivo = amount;
  }

  ensureCatalogEntry(state.doctors, doctor);
  ensureCatalogEntry(state.provinces, province);

  state.records[idx] = {
    ...state.records[idx],
    datetime: document.getElementById('edit-datetime').value,
    patient: document.getElementById('edit-patient').value.trim(),
    doctor,
    province,
    plateType,
    plateTypes,
    paymentMethod,
    amount,
    amountEfectivo,
    amountYape,
    commission,
    commissionPaid: onlyPeriapical || commission <= 0 ? false : document.getElementById('edit-comm-paid').value === 'true'
  };

  saveStateToStorage();
  populateDatalists();
  closeModal('edit-modal');
  renderAll();
  showToast('Registro actualizado correctamente.');
}

function openDeleteModal(id) {
  const rec = state.records.find((r) => r.id === id);
  if (!rec) return;
  state.pendingDeleteId = id;
  document.getElementById('delete-modal-text').innerHTML =
    `¿Está seguro de eliminar el registro de <strong>${escapeHTML(rec.patient)}</strong> (${escapeHTML(rec.plateType)} - ${formatCurrency(rec.amount)})?`;
  document.getElementById('delete-modal').classList.add('open');
}

document.getElementById('confirm-delete-btn').addEventListener('click', () => {
  if (!state.pendingDeleteId) return;
  state.records = state.records.filter((r) => r.id !== state.pendingDeleteId);
  state.pendingDeleteId = null;
  saveStateToStorage();
  closeModal('delete-modal');
  renderAll();
  showToast('Registro eliminado.');
});

function toggleCommissionStatus(id) {
  const rec = state.records.find((r) => r.id === id);
  if (!rec || isRecordOnlyPeriapical(rec) || (Number(rec.commission) || 0) <= 0) return;
  rec.commissionPaid = !rec.commissionPaid;
  saveStateToStorage();
  renderAll();
  showToast(
    rec.commissionPaid
      ? `Comisión marcada como CANCELADA / PAGADA (${rec.doctor})`
      : `Comisión marcada como PENDIENTE (${rec.doctor})`
  );
}

function markAllDoctorCommissionsPaid(doctorName) {
  const periodRecords = getRecordsForPeriod();
  let count = 0;
  periodRecords.forEach((r) => {
    if (r.doctor === doctorName && !r.commissionPaid && r.commission > 0) {
      r.commissionPaid = true;
      count++;
    }
  });
  if (count > 0) {
    saveStateToStorage();
    renderAll();
    showToast(`Se marcaron como CANCELADAS ${count} comisiones para ${doctorName}.`);
  } else {
    showToast(`No hay comisiones pendientes para ${doctorName} en este periodo.`);
  }
}

/* ==========================================================================
   6. RENDERIZADO GENERAL DE VISTAS Y REPORTES
   ========================================================================== */

function populateDatalists() {
  const allDocs = Array.from(
    new Set([...state.doctors, ...state.records.map((r) => r.doctor).filter(Boolean)])
  ).sort();

  const docList = document.getElementById('doctors-datalist');
  if (docList) {
    docList.innerHTML = allDocs.map((d) => `<option value="${escapeHTML(d)}"></option>`).join('');
  }

  const filterDoc = document.getElementById('filter-doctor');
  if (filterDoc) {
    const currentDoc = filterDoc.value || 'ALL';
    filterDoc.innerHTML =
      `<option value="ALL">👨‍⚕️ Todos los Doctores</option>` +
      allDocs.map((d) => `<option value="${escapeHTML(d)}">👨‍⚕️ ${escapeHTML(d)}</option>`).join('');
    filterDoc.value = allDocs.includes(currentDoc) ? currentDoc : 'ALL';
  }

  const provList = document.getElementById('provinces-datalist');
  if (provList) {
    provList.innerHTML = state.provinces
      .slice()
      .sort()
      .map((p) => `<option value="${escapeHTML(p)}"></option>`)
      .join('');
  }

  const filterProv = document.getElementById('filter-province');
  if (filterProv) {
    const currentVal = filterProv.value || 'ALL';
    const allProvs = Array.from(
      new Set([...state.provinces, ...state.records.map((r) => r.province).filter(Boolean)])
    ).sort();
    filterProv.innerHTML =
      `<option value="ALL">Todas las Provincias</option>` +
      allProvs.map((p) => `<option value="${escapeHTML(p)}">${escapeHTML(p)}</option>`).join('');
    filterProv.value = allProvs.includes(currentVal) ? currentVal : 'ALL';
  }

  // Actualizar hints de precios en tarjetas de tipo de placa
  const tPan = state.tariffs['Panorámica'] || { price: 80, commission: 20 };
  const tCef = state.tariffs['Cefalométrica'] || { price: 80, commission: 20 };
  const tPer = state.tariffs['Periapical'] || { price: 25, commission: 0 };
  const tCon = state.tariffs['Tomografía Cone Beam'] || { price: 180, commission: 40 };

  document.getElementById('hint-panoramica').textContent = `S/ ${tPan.price} · Com: S/ ${tPan.commission}`;
  const hintCef = document.getElementById('hint-cefalometrica');
  if (hintCef) hintCef.textContent = `S/ ${tCef.price} · Com: S/ ${tCef.commission}`;
  document.getElementById('hint-periapical').textContent = `S/ ${tPer.price}`;
  document.getElementById('hint-conebeam').textContent = `S/ ${tCon.price} · Com: S/ ${tCon.commission}`;

  // Rellenar formulario de configuración de tarifas
  const cfgPanP = document.getElementById('cfg-price-panoramica');
  if (cfgPanP) {
    cfgPanP.value = tPan.price;
    document.getElementById('cfg-comm-panoramica').value = tPan.commission;
    const cfgCefP = document.getElementById('cfg-price-cefalometrica');
    if (cfgCefP) {
      cfgCefP.value = tCef.price;
      document.getElementById('cfg-comm-cefalometrica').value = tCef.commission;
    }
    document.getElementById('cfg-price-periapical').value = tPer.price;
    document.getElementById('cfg-price-conebeam').value = tCon.price;
    document.getElementById('cfg-comm-conebeam').value = tCon.commission;
  }
}

function getPeriodLabelText() {
  const labels = {
    today: 'Hoy',
    week: 'Esta Semana',
    month: 'Este Mes',
    all: 'Todos los Registros Históricos',
    custom: `Personalizado (${formatYMDToDMY(state.customStartDate)} al ${formatYMDToDMY(state.customEndDate)})`
  };
  return labels[state.dateFilterMode] || 'Periodo Seleccionado';
}

function renderAll() {
  const periodRecords = getRecordsForPeriod();
  const tableRecords = getFilteredRecordsForTable();

  document.getElementById('nav-count-records').textContent = periodRecords.length;
  document.getElementById('active-period-label').textContent = `Mostrando: ${getPeriodLabelText()}`;

  renderKPIs(periodRecords);
  renderDoctorFilterBanner(periodRecords);
  renderMainTable(tableRecords);
  renderCashClosing(periodRecords);
  renderAnalyticsDashboard(periodRecords);
  renderDoctorsCommissionsView(periodRecords);
}

function renderDoctorFilterBanner(periodRecords) {
  const banner = document.getElementById('doctor-filter-banner');
  if (!banner) return;

  const selectedDoc = document.getElementById('filter-doctor')?.value || 'ALL';
  if (selectedDoc === 'ALL') {
    banner.style.display = 'none';
    return;
  }

  const docRecords = periodRecords.filter((r) => r.doctor === selectedDoc);
  let totalAmt = 0;
  let pendingComm = 0;
  let paidComm = 0;

  docRecords.forEach((r) => {
    totalAmt += Number(r.amount) || 0;
    const com = Number(r.commission) || 0;
    if (com > 0) {
      if (r.commissionPaid) paidComm += com;
      else pendingComm += com;
    }
  });

  banner.style.display = 'flex';
  banner.innerHTML = `
    <div>
      <div style="font-size: 0.92rem; font-weight: 800; color: var(--slate-900);">
        👨‍⚕️ Órdenes enviadas por: <span style="color: var(--med-blue-700);">${escapeHTML(selectedDoc)}</span>
      </div>
      <div style="font-size: 0.8rem; color: var(--slate-600); margin-top: 2px;">
        <strong>${docRecords.length}</strong> orden(es) en el periodo · Producción: <strong>${formatCurrency(totalAmt)}</strong> ·
        <span style="color: #b45309; font-weight: 700;">⏳ Pendiente: ${formatCurrency(pendingComm)}</span> ·
        <span style="color: var(--brand-emerald-700); font-weight: 700;">✅ Cancelado: ${formatCurrency(paidComm)}</span>
      </div>
    </div>
    <div style="display: flex; gap: 0.5rem; align-items: center;">
      ${
        pendingComm > 0
          ? `<button class="btn btn-emerald btn-sm" onclick="markAllDoctorCommissionsPaid('${escapeHTML(selectedDoc)}')">✅ Marcar Todo Cancelado (${formatCurrency(pendingComm)})</button>`
          : ''
      }
      <button class="btn btn-outline btn-sm" onclick="clearDoctorFilter()">✕ Ver Todos los Doctores</button>
    </div>
  `;
}

function renderKPIs(records) {
  let totalProd = 0;
  let totalComm = 0;
  let pendingComm = 0;
  let paidComm = 0;
  let totalEfectivo = 0;
  let totalYape = 0;
  let countEfectivo = 0;
  let countYape = 0;
  let countMixto = 0;

  let totalStudiesCount = 0;

  records.forEach((r) => {
    const amt = Number(r.amount) || 0;
    const com = isRecordOnlyPeriapical(r) ? 0 : Number(r.commission) || 0;
    totalProd += amt;
    totalComm += com;
    totalStudiesCount += getRecordPlatesList(r).length;
    if (com > 0) {
      if (r.commissionPaid) paidComm += com;
      else pendingComm += com;
    }

    const split = getPaymentSplit(r);
    totalEfectivo += split.efectivo;
    totalYape += split.yape;

    if (r.paymentMethod === 'Mixto') countMixto++;
    else if (r.paymentMethod === 'Yape') countYape++;
    else countEfectivo++;
  });

  const netProfit = totalProd - totalComm;
  const marginPct = totalProd > 0 ? ((netProfit / totalProd) * 100).toFixed(1) : '0.0';

  document.getElementById('kpi-total-prod').textContent = formatCurrency(totalProd);
  document.getElementById('kpi-studies-count').textContent = `${totalStudiesCount} estudios (${records.length} órdenes)`;
  document.getElementById('kpi-pay-split').textContent = `Efec: ${formatCurrency(totalEfectivo)} | Yape: ${formatCurrency(totalYape)}`;
  document.getElementById('kpi-pay-counts').textContent = `${countEfectivo} Efec · ${countYape} Yape · ${countMixto} Mixto`;
  document.getElementById('kpi-total-comm').textContent = formatCurrency(totalComm);
  document.getElementById('kpi-comm-status').textContent = `Pendiente: ${formatCurrency(pendingComm)} | Cancelado: ${formatCurrency(paidComm)}`;
  document.getElementById('kpi-net-profit').textContent = formatCurrency(netProfit);
  document.getElementById('kpi-profit-margin').textContent = `Utilidad Neta (${marginPct}% de margen)`;
}

function getPlateBadgeClass(plateType) {
  if (plateType === 'Panorámica') return 'badge-panoramica';
  if (plateType === 'Cefalométrica') return 'badge-cefalometrica';
  if (plateType === 'Periapical') return 'badge-periapical';
  return 'badge-conebeam';
}

function renderRecordPlatesBadges(r) {
  const plates = getRecordPlatesList(r);
  return `<div style="display: inline-flex; flex-wrap: wrap; gap: 0.28rem;">${plates
    .map((p) => {
      const label = p === 'Panorámica' ? 'P. Panorámica' : p;
      return `<span class="badge ${getPlateBadgeClass(p)}">${escapeHTML(label)}</span>`;
    })
    .join('')}</div>`;
}

function getSmartReportTitle() {
  const titlesByMode = {
    today: 'INFORME DEL DÍA',
    week: 'INFORME DE LA SEMANA',
    month: 'INFORME DEL MES',
    custom: 'INFORME POR PERIODO',
    all: 'INFORME GENERAL'
  };
  return titlesByMode[state.dateFilterMode] || 'INFORME DEL PERIODO';
}

function renderMainTable(records) {
  const tbody = document.getElementById('records-tbody');
  const tfoot = document.getElementById('records-tfoot');
  document.getElementById('table-results-subtitle').textContent =
    `${records.length} registro(s) encontrados en "${getPeriodLabelText()}"`;

  if (records.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="10">
          <div class="empty-state">
            <strong>No se encontraron órdenes radiológicas para este filtro</strong>
            <p>Registre una nueva placa en el formulario o cambie el filtro superior.</p>
          </div>
        </td>
      </tr>
    `;
    tfoot.innerHTML = '';
    return;
  }

  let sumAmount = 0;
  let sumComm = 0;

  tbody.innerHTML = records
    .map((r) => {
      const amt = Number(r.amount) || 0;
      const onlyPer = isRecordOnlyPeriapical(r);
      const com = onlyPer ? 0 : Number(r.commission) || 0;
      const net = amt - com;
      sumAmount += amt;
      sumComm += com;

      let commBadge = '';
      if (onlyPer || com <= 0) {
        commBadge = `<span class="badge" style="background: var(--slate-100); color: var(--slate-500);">Sin comisión</span>`;
      } else {
        commBadge = `<span class="badge ${r.commissionPaid ? 'badge-paid' : 'badge-pending'}" onclick="toggleCommissionStatus('${r.id}')" title="Clic para cambiar entre Pendiente y Cancelado">
          ${formatCurrency(com)} · ${r.commissionPaid ? '✅ Cancelado' : '⏳ Pendiente'}
        </span>`;
      }

      let payBadge = '';
      if (r.paymentMethod === 'Mixto') {
        const split = getPaymentSplit(r);
        payBadge = `<span class="badge badge-mixto" title="Efectivo: ${formatCurrency(split.efectivo)} + Yape: ${formatCurrency(split.yape)}">
          🔀 Mixto (Ef: S/ ${split.efectivo} | Yp: S/ ${split.yape})
        </span>`;
      } else if (r.paymentMethod === 'Yape') {
        payBadge = `<span class="badge badge-yape">📱 Yape</span>`;
      } else {
        payBadge = `<span class="badge badge-efectivo">💵 Efectivo</span>`;
      }

      return `
        <tr>
          <td style="white-space: nowrap; font-size: 0.8rem; color: var(--slate-600);">${formatReadableDateTime(r.datetime)}</td>
          <td><strong>${escapeHTML(r.patient)}</strong></td>
          <td>
            <span style="cursor: pointer; color: var(--med-blue-800); font-weight: 700; text-decoration: underline dotted;" onclick="filterByDoctorQuick('${escapeHTML(r.doctor)}')" title="Clic para ver todas las órdenes de este doctor">
              ${escapeHTML(r.doctor)}
            </span>
          </td>
          <td><span class="badge" style="background: var(--slate-100); color: var(--slate-700);">${escapeHTML(r.province)}</span></td>
          <td>${renderRecordPlatesBadges(r)}</td>
          <td>${payBadge}</td>
          <td style="text-align: right; font-weight: 700;">${formatCurrency(amt)}</td>
          <td style="text-align: right;">${commBadge}</td>
          <td style="text-align: right; font-weight: 800; color: var(--brand-emerald-700);">${formatCurrency(net)}</td>
          <td style="text-align: center;">
            <div class="row-actions" style="justify-content: center;">
              <button class="icon-btn edit" onclick="openEditModal('${r.id}')" title="Editar registro">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              <button class="icon-btn delete" onclick="openDeleteModal('${r.id}')" title="Eliminar registro">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
          </td>
        </tr>
      `;
    })
    .join('');

  const sumNet = sumAmount - sumComm;
  tfoot.innerHTML = `
    <tr>
      <td colspan="6" style="text-align: right;">TOTALES DE LA TABLA FILTRADA (${records.length} estudios):</td>
      <td style="text-align: right; color: var(--slate-900);">${formatCurrency(sumAmount)}</td>
      <td style="text-align: right; color: var(--amber-600);">${formatCurrency(sumComm)}</td>
      <td style="text-align: right; color: var(--brand-emerald-700);">${formatCurrency(sumNet)}</td>
      <td></td>
    </tr>
  `;
}

/* ==========================================================================
   7. MÓDULO 3: CIERRE DE CAJA Y PRODUCCIÓN TOTAL DEL DÍA / PERIODO
   ========================================================================== */

function renderCashClosing(records) {
  const reportTitleEl = document.getElementById('cash-report-title');
  if (reportTitleEl) {
    reportTitleEl.textContent = getSmartReportTitle();
  }

  let totalProd = 0;
  let totalComm = 0;
  let paidComm = 0;
  let pendingComm = 0;
  let efectivoAmt = 0;
  let efectivoCnt = 0;
  let yapeAmt = 0;
  let yapeCnt = 0;
  let mixtoCnt = 0;
  let totalPlatesCount = 0;

  const byPlate = {
    'Tomografía Cone Beam': { label: 'Tomografía', count: 0, amount: 0, comm: 0, color: 'var(--brand-emerald-700)', bg: 'var(--brand-emerald-50)' },
    'Panorámica': { label: 'P. Panorámica', count: 0, amount: 0, comm: 0, color: 'var(--med-blue-700)', bg: 'var(--med-blue-50)' },
    'Cefalométrica': { label: 'Cefalométrica', count: 0, amount: 0, comm: 0, color: '#0f766e', bg: '#f0fdfa' },
    'Periapical': { label: 'Periapical', count: 0, amount: 0, comm: 0, color: '#4338ca', bg: '#eef2ff' }
  };

  const byDoctor = {};

  records.forEach((r) => {
    const amt = Number(r.amount) || 0;
    const com = isRecordOnlyPeriapical(r) ? 0 : Number(r.commission) || 0;
    totalProd += amt;
    totalComm += com;
    if (com > 0) {
      if (r.commissionPaid) paidComm += com;
      else pendingComm += com;
    }

    const split = getPaymentSplit(r);
    efectivoAmt += split.efectivo;
    yapeAmt += split.yape;

    if (r.paymentMethod === 'Mixto') mixtoCnt++;
    else if (r.paymentMethod === 'Yape') yapeCnt++;
    else efectivoCnt++;

    const shares = getRecordPlateShares(r);
    shares.forEach((sh) => {
      if (!byPlate[sh.plate]) {
        byPlate[sh.plate] = { label: sh.plate, count: 0, amount: 0, comm: 0, color: 'var(--slate-800)', bg: 'var(--slate-50)' };
      }
      byPlate[sh.plate].count++;
      byPlate[sh.plate].amount += sh.amount;
      byPlate[sh.plate].comm += sh.comm;
      totalPlatesCount++;
    });

    const doc = r.doctor || 'Sin Especificar';
    if (!byDoctor[doc]) {
      byDoctor[doc] = { count: 0, amount: 0, comm: 0 };
    }
    byDoctor[doc].count++;
    byDoctor[doc].amount += amt;
    byDoctor[doc].comm += com;
  });

  document.getElementById('cash-period-subtitle').textContent =
    `Periodo evaluado: ${getPeriodLabelText()} · Total de estudios: ${totalPlatesCount}`;

  // Resumen superior destacado de cantidades de exámenes (Tomografía, P. Panorámica, Cefalométrica, Periapical)
  const countsStrip = document.getElementById('cash-exam-counts-strip');
  if (countsStrip) {
    const orderedKeys = ['Tomografía Cone Beam', 'Panorámica', 'Cefalométrica', 'Periapical'];
    countsStrip.innerHTML = orderedKeys
      .map((key) => {
        const item = byPlate[key] || { label: key, count: 0, amount: 0, color: 'var(--slate-800)', bg: 'var(--slate-50)' };
        return `
          <div class="report-exam-count-card" style="background: ${item.bg};">
            <div>
              <span class="exam-label" style="color: ${item.color};">${escapeHTML(item.label)}</span>
              <div class="exam-sub">Total: ${formatCurrency(item.amount)}</div>
            </div>
            <div class="exam-qty" style="color: ${item.color};">${item.count}</div>
          </div>
        `;
      })
      .join('');
  }

  const netProfit = totalProd - totalComm;

  // 1. Balance Financiero
  document.getElementById('cash-financial-summary').innerHTML = `
    <div class="breakdown-item">
      <span><strong>Producción Total Cobrada</strong></span>
      <strong style="font-size: 1.1rem; color: var(--med-blue-800);">${formatCurrency(totalProd)}</strong>
    </div>
    <div class="breakdown-item">
      <span><strong>(-) Total Comisiones a Doctores</strong><br><small style="color: var(--slate-500);">Canceladas: ${formatCurrency(paidComm)} | Pendientes: ${formatCurrency(pendingComm)}</small></span>
      <strong style="font-size: 1.05rem; color: var(--amber-600);">- ${formatCurrency(totalComm)}</strong>
    </div>
    <div class="breakdown-item" style="background: var(--brand-emerald-50); border-color: var(--brand-emerald-100);">
      <span><strong style="color: var(--brand-emerald-900);">(=) Utilidad Neta (Producción - Comisiones)</strong></span>
      <strong style="font-size: 1.25rem; color: var(--brand-emerald-700);">${formatCurrency(netProfit)}</strong>
    </div>
  `;

  // 2. Desglose por Método de Pago (incluyendo proporción de pagos mixtos)
  const efecPct = totalProd > 0 ? Math.round((efectivoAmt / totalProd) * 100) : 0;
  const yapePct = totalProd > 0 ? Math.round((yapeAmt / totalProd) * 100) : 0;

  document.getElementById('cash-payment-breakdown').innerHTML = `
    <div class="breakdown-item" style="flex-direction: column; align-items: stretch;">
      <div style="display: flex; justify-content: space-between;">
        <span><strong>💵 Total en Efectivo</strong> (${efectivoCnt} directos + ${mixtoCnt} mixtos)</span>
        <strong style="color: var(--brand-emerald-700);">${formatCurrency(efectivoAmt)} (${efecPct}%)</strong>
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width: ${efecPct}%; background: var(--brand-emerald-600);"></div>
      </div>
    </div>

    <div class="breakdown-item" style="flex-direction: column; align-items: stretch;">
      <div style="display: flex; justify-content: space-between;">
        <span><strong>📱 Total en Yape</strong> (${yapeCnt} directos + ${mixtoCnt} mixtos)</span>
        <strong style="color: var(--yape-purple);">${formatCurrency(yapeAmt)} (${yapePct}%)</strong>
      </div>
      <div class="progress-bar-wrap">
        <div class="progress-bar-fill" style="width: ${yapePct}%; background: var(--yape-purple);"></div>
      </div>
    </div>

    <div class="breakdown-item">
      <span><strong>Efectivo Físico Neto en Caja</strong><br><small style="color: var(--slate-500);">Efectivo - Comisiones Canceladas</small></span>
      <strong style="white-space: nowrap; font-size: 1.05rem; color: var(--slate-900);">${formatCurrency(efectivoAmt - paidComm)}</strong>
    </div>
  `;

  // 3. Estudios Realizados por Tipo de Placa
  document.getElementById('cash-plate-breakdown').innerHTML =
    Object.entries(byPlate)
      .map(
        ([plate, info]) => `
        <div class="breakdown-item">
          <div>
            <strong>${escapeHTML(info.label || plate)}</strong>
            <div style="font-size: 0.78rem; color: var(--slate-500);">Cantidad: <strong>${info.count}</strong> estudio(s)</div>
          </div>
          <div style="text-align: right;">
            <strong>${formatCurrency(info.amount)}</strong>
            <div style="font-size: 0.75rem; color: var(--amber-600);">Com: ${formatCurrency(info.comm)}</div>
          </div>
        </div>
      `
      )
      .join('') +
    `
    <div class="breakdown-item" style="background: var(--med-blue-50); border-color: var(--med-blue-100);">
      <strong>Total de Estudios Realizados</strong>
      <strong style="font-size: 1.1rem; color: var(--med-blue-800);">${totalPlatesCount} placas</strong>
    </div>
  `;

  // 4. Tabla de Doctores en el Cierre (si existiera en el DOM)
  const docRows = Object.entries(byDoctor).sort((a, b) => b[1].amount - a[1].amount);
  const cashDocsTbody = document.getElementById('cash-doctors-tbody');
  if (cashDocsTbody) {
    if (docRows.length === 0) {
      cashDocsTbody.innerHTML = `<tr><td colspan="5" style="text-align:center; padding: 1.5rem; color: var(--slate-500);">Sin registros en este periodo.</td></tr>`;
    } else {
      cashDocsTbody.innerHTML = docRows
        .map(
          ([doc, d]) => `
          <tr>
            <td><strong>${escapeHTML(doc)}</strong></td>
            <td style="text-align: center;">${d.count}</td>
            <td style="text-align: right;">${formatCurrency(d.amount)}</td>
            <td style="text-align: right; color: var(--amber-600); font-weight: 700;">${formatCurrency(d.comm)}</td>
            <td style="text-align: right; color: var(--brand-emerald-700); font-weight: 700;">${formatCurrency(d.amount - d.comm)}</td>
          </tr>
        `
        )
        .join('');
    }
  }
}

/* ==========================================================================
   8. MÓDULO 4: REPORTES AVANZADOS Y ESTADÍSTICAS (DASHBOARD ANALÍTICO)
   ========================================================================== */

function renderAnalyticsDashboard(records) {
  // 1. Ranking de Doctores
  const docMap = {};
  records.forEach((r) => {
    const doc = r.doctor || 'Sin especificar';
    if (!docMap[doc]) docMap[doc] = { count: 0, amount: 0, comm: 0 };
    docMap[doc].count++;
    docMap[doc].amount += Number(r.amount) || 0;
    docMap[doc].comm += Number(r.commission) || 0;
  });

  const docRanking = Object.entries(docMap).sort((a, b) => b[1].count - a[1].count || b[1].amount - a[1].amount);
  const maxDocCount = docRanking.length > 0 ? docRanking[0][1].count : 1;

  const docContainer = document.getElementById('analytics-doctors-ranking');
  if (docRanking.length === 0) {
    docContainer.innerHTML = `<div class="empty-state">No hay datos de doctores en este rango de fechas.</div>`;
  } else {
    docContainer.innerHTML = docRanking
      .map(([doc, info], idx) => {
        const pct = Math.round((info.count / maxDocCount) * 100);
        return `
          <div class="ranking-item">
            <div class="ranking-top">
              <div>
                <span class="rank-number ${idx === 0 ? 'top-1' : ''}">${idx + 1}</span>
                <strong>${escapeHTML(doc)}</strong>
              </div>
              <div style="text-align: right;">
                <span class="badge badge-panoramica">${info.count} placas</span>
                <strong style="margin-left: 0.4rem;">${formatCurrency(info.amount)}</strong>
              </div>
            </div>
            <div class="progress-bar-wrap">
              <div class="progress-bar-fill" style="width: ${pct}%; background: linear-gradient(90deg, var(--med-blue-600), var(--brand-emerald-500));"></div>
            </div>
            <div style="font-size: 0.74rem; color: var(--slate-500); margin-top: 0.25rem; display: flex; justify-content: space-between;">
              <span>Comisión generada: ${formatCurrency(info.comm)}</span>
              <span>Aporte Neto BioDent: ${formatCurrency(info.amount - info.comm)}</span>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // 2. Tipo de Placa más Vendida (Gráfico Donut SVG + Leyenda)
  const plateColors = {
    'Panorámica': '#0284c7',
    'Cefalométrica': '#0d9488',
    'Periapical': '#4f46e5',
    'Tomografía Cone Beam': '#059669'
  };

  const plateCounts = {
    'Panorámica': { count: 0, amount: 0 },
    'Cefalométrica': { count: 0, amount: 0 },
    'Periapical': { count: 0, amount: 0 },
    'Tomografía Cone Beam': { count: 0, amount: 0 }
  };

  let totalPlates = 0;
  records.forEach((r) => {
    const shares = getRecordPlateShares(r);
    shares.forEach((sh) => {
      if (!plateCounts[sh.plate]) plateCounts[sh.plate] = { count: 0, amount: 0 };
      plateCounts[sh.plate].count++;
      plateCounts[sh.plate].amount += sh.amount;
      totalPlates++;
    });
  });
  let cumulativePercent = 0;
  const radius = 60;
  const circumference = 2 * Math.PI * radius;

  const circlesSvg = Object.entries(plateCounts)
    .map(([plate, data]) => {
      const pct = totalPlates > 0 ? data.count / totalPlates : 0;
      const strokeDasharray = `${pct * circumference} ${circumference}`;
      const strokeDashoffset = -cumulativePercent * circumference;
      cumulativePercent += pct;
      return `<circle r="${radius}" cx="80" cy="80" fill="transparent" stroke="${plateColors[plate] || '#64748b'}" stroke-width="24" stroke-dasharray="${strokeDasharray}" stroke-dashoffset="${strokeDashoffset}" transform="rotate(-90 80 80)" />`;
    })
    .join('');

  document.getElementById('analytics-plates-chart').innerHTML = `
    <div class="donut-layout">
      <div style="position: relative; width: 160px; height: 160px; display: flex; align-items: center; justify-content: center;">
        <svg width="160" height="160" viewBox="0 0 160 160">
          <circle r="${radius}" cx="80" cy="80" fill="transparent" stroke="#e2e8f0" stroke-width="24" />
          ${circlesSvg}
        </svg>
        <div style="position: absolute; text-align: center;">
          <div style="font-size: 1.35rem; font-weight: 800; color: var(--slate-900); line-height: 1;">${totalPlates}</div>
          <div style="font-size: 0.7rem; color: var(--slate-500); font-weight: 700; text-transform: uppercase;">Estudios</div>
        </div>
      </div>

      <div class="donut-legend">
        ${Object.entries(plateCounts)
          .map(([plate, data]) => {
            const pct = totalPlates > 0 ? ((data.count / totalPlates) * 100).toFixed(1) : '0.0';
            return `
              <div class="legend-item">
                <div>
                  <span class="legend-dot" style="background: ${plateColors[plate] || '#64748b'};"></span>
                  <strong>${escapeHTML(plate)}</strong>
                  <div style="font-size: 0.75rem; color: var(--slate-500); margin-left: 1.25rem;">${data.count} vendidos (${pct}%)</div>
                </div>
                <strong style="color: var(--slate-800);">${formatCurrency(data.amount)}</strong>
              </div>
            `;
          })
          .join('')}
      </div>
    </div>
  `;

  // 3. Distribución Geográfica por Provincias
  const provMap = {};
  records.forEach((r) => {
    const p = r.province || 'No especificada';
    if (!provMap[p]) provMap[p] = { count: 0, amount: 0 };
    provMap[p].count++;
    provMap[p].amount += Number(r.amount) || 0;
  });

  const provList = Object.entries(provMap).sort((a, b) => b[1].count - a[1].count);
  const provContainer = document.getElementById('analytics-provinces-chart');

  if (provList.length === 0) {
    provContainer.innerHTML = `<div class="empty-state">Sin datos de provincias en este rango.</div>`;
  } else {
    provContainer.innerHTML = provList
      .map(([prov, info]) => {
        const pct = totalPlates > 0 ? Math.round((info.count / totalPlates) * 100) : 0;
        return `
          <div class="ranking-item">
            <div class="ranking-top">
              <strong>📍 ${escapeHTML(prov)}</strong>
              <span><strong>${info.count} pac.</strong> (${pct}%) · ${formatCurrency(info.amount)}</span>
            </div>
            <div class="progress-bar-wrap">
              <div class="progress-bar-fill" style="width: ${pct}%; background: var(--med-blue-600);"></div>
            </div>
          </div>
        `;
      })
      .join('');
  }

  // 4. Métricas Financieras de Rendimiento
  let totalAmt = 0;
  let totalComm = 0;
  const byDay = {};

  records.forEach((r) => {
    const amt = Number(r.amount) || 0;
    const com = Number(r.commission) || 0;
    totalAmt += amt;
    totalComm += com;
    const dayKey = (r.datetime || '').slice(0, 10);
    if (dayKey) {
      if (!byDay[dayKey]) byDay[dayKey] = { prod: 0, net: 0, count: 0 };
      byDay[dayKey].prod += amt;
      byDay[dayKey].net += amt - com;
      byDay[dayKey].count++;
    }
  });

  const avgTicket = totalPlates > 0 ? totalAmt / totalPlates : 0;
  const dayEntries = Object.entries(byDay).sort((a, b) => b[0].localeCompare(a[0])).slice(0, 7);

  document.getElementById('analytics-financial-metrics').innerHTML = `
    <div class="form-row" style="margin-bottom: 1rem;">
      <div class="breakdown-item">
        <div>
          <span style="font-size: 0.76rem; color: var(--slate-500);">Ticket Promedio por Estudio</span>
          <div style="font-size: 1.15rem; font-weight: 800; color: var(--med-blue-800);">${formatCurrency(avgTicket)}</div>
        </div>
      </div>
      <div class="breakdown-item">
        <div>
          <span style="font-size: 0.76rem; color: var(--slate-500);">Retención Neta (Post-Comisión)</span>
          <div style="font-size: 1.15rem; font-weight: 800; color: var(--brand-emerald-700);">
            ${totalAmt > 0 ? (((totalAmt - totalComm) / totalAmt) * 100).toFixed(1) : '0.0'}%
          </div>
        </div>
      </div>
    </div>
    <h4 style="font-size: 0.8rem; text-transform: uppercase; color: var(--slate-500); margin-bottom: 0.6rem;">Rendimiento por Fecha (Últimos días activos)</h4>
    ${
      dayEntries.length === 0
        ? `<div class="empty-state">Sin movimientos registrados.</div>`
        : dayEntries
            .map(
              ([day, d]) => `
              <div class="breakdown-item" style="margin-bottom: 0.5rem;">
                <div>
                  <strong>📅 ${formatYMDToDMY(day)}</strong>
                  <span style="font-size: 0.78rem; color: var(--slate-500); margin-left: 0.5rem;">(${d.count} estudios)</span>
                </div>
                <div style="text-align: right;">
                  <span style="font-size: 0.8rem; color: var(--slate-600);">Bruto: ${formatCurrency(d.prod)}</span> ·
                  <strong style="color: var(--brand-emerald-700);">Neto: ${formatCurrency(d.net)}</strong>
                </div>
              </div>
            `
            )
            .join('')
    }
  `;
}

/* ==========================================================================
   9. VISTA DE COMISIONES Y DIRECTORIO DE DOCTORES
   ========================================================================== */

function renderDoctorsCommissionsView(records) {
  const map = {};
  state.doctors.forEach((d) => {
    map[d] = { count: 0, pan: 0, cef: 0, per: 0, cone: 0, prod: 0, paid: 0, pending: 0 };
  });

  records.forEach((r) => {
    const doc = r.doctor || 'Sin especificar';
    if (!map[doc]) {
      map[doc] = { count: 0, pan: 0, cef: 0, per: 0, cone: 0, prod: 0, paid: 0, pending: 0 };
    }
    map[doc].count++;
    getRecordPlatesList(r).forEach((p) => {
      if (p === 'Panorámica') map[doc].pan++;
      else if (p === 'Cefalométrica') map[doc].cef++;
      else if (p === 'Periapical') map[doc].per++;
      else map[doc].cone++;
    });

    map[doc].prod += Number(r.amount) || 0;
    const com = isRecordOnlyPeriapical(r) ? 0 : Number(r.commission) || 0;
    if (com > 0) {
      if (r.commissionPaid) map[doc].paid += com;
      else map[doc].pending += com;
    }
  });

  const rows = Object.entries(map).sort((a, b) => b[1].pending - a[1].pending || b[1].count - a[1].count);
  const tbody = document.getElementById('doctors-commissions-tbody');

  if (rows.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="7">
          <div class="empty-state">
            <strong>Aún no hay doctores ni comisiones registradas</strong>
            <p>Al registrar la primera orden radiológica o agregar un doctor, aparecerá aquí automáticamente.</p>
          </div>
        </td>
      </tr>
    `;
    return;
  }

  tbody.innerHTML = rows
    .map(
      ([doc, info]) => `
      <tr>
        <td><strong>${escapeHTML(doc)}</strong></td>
        <td style="text-align: center;"><strong>${info.count}</strong></td>
        <td style="font-size: 0.8rem; color: var(--slate-600);">
          Pan: ${info.pan} · Cef: ${info.cef} · Per: ${info.per} · Tomo: ${info.cone}
        </td>
        <td style="text-align: right; font-weight: 700;">${formatCurrency(info.prod)}</td>
        <td style="text-align: right; color: var(--brand-emerald-700); font-weight: 700;">${formatCurrency(info.paid)}</td>
        <td style="text-align: right; color: var(--amber-600); font-weight: 800;">${formatCurrency(info.pending)}</td>
        <td style="text-align: center;">
          <div style="display: inline-flex; gap: 0.4rem; align-items: center;">
            <button class="btn btn-outline btn-sm" onclick="filterByDoctorQuick('${escapeHTML(doc)}')">🔍 Ver Órdenes</button>
            ${
              info.pending > 0
                ? `<button class="btn btn-emerald btn-sm" onclick="markAllDoctorCommissionsPaid('${escapeHTML(doc)}')">✅ Cancelar S/ ${info.pending.toFixed(2)}</button>`
                : `<span class="badge badge-paid">✅ Cancelado</span>`
            }
          </div>
        </td>
      </tr>
    `
    )
    .join('');
}

/* ==========================================================================
   10. MÓDULO 5: PORTABILIDAD OFFLINE (BACKUP JSON, RESTORE JSON, EXCEL CSV)
   ========================================================================== */

function exportBackupJSON() {
  if (!Array.isArray(state.records) || state.records.length === 0) {
    loadStateFromStorage();
  }

  const payload = {
    system: 'BioDent Tomografías - Control de Radiología y Comisiones',
    author: 'By. Carlos Neira',
    version: '1.2',
    exportedAt: new Date().toISOString(),
    records: state.records,
    doctors: state.doctors,
    provinces: state.provinces,
    tariffs: state.tariffs
  };

  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const datePart = getLocalNowISOString().slice(0, 10);
  a.href = url;
  a.download = `BioDent_Backup_${datePart}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`Copia de seguridad JSON descargada (${state.records.length} registros).`);
}

function triggerImportJSON() {
  const input = document.getElementById('hidden-json-input');
  input.value = '';
  input.click();
}

function normalizeDateTimeString(rawDt) {
  if (!rawDt) return getLocalNowISOString();
  const str = String(rawDt).trim();
  // Si ya es YYYY-MM-DDTHH:mm o YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(str)) {
    return str.length >= 16 ? str.slice(0, 16) : `${str.slice(0, 10)}T08:00`;
  }
  // Si viene en formato DD/MM/YYYY HH:mm AM/PM o DD/MM/YYYY
  const dmyMatch = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{2})(?:\s*(AM|PM|a\.?\s*m\.?|p\.?\s*m\.?))?)?/i);
  if (dmyMatch) {
    const pad = (n) => String(n).padStart(2, '0');
    const day = pad(dmyMatch[1]);
    const month = pad(dmyMatch[2]);
    const year = dmyMatch[3];
    let hours = Number(dmyMatch[4] ?? 8);
    const mins = pad(dmyMatch[5] ?? 0);
    const ampm = (dmyMatch[6] || '').toUpperCase();
    if (ampm.startsWith('P') && hours < 12) hours += 12;
    if (ampm.startsWith('A') && hours === 12) hours = 0;
    return `${year}-${month}-${day}T${pad(hours)}:${mins}`;
  }
  const parsed = new Date(str);
  if (!isNaN(parsed.getTime())) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}T${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;
  }
  return getLocalNowISOString();
}

function normalizeImportedRecord(r, idx) {
  if (!r || typeof r !== 'object') return null;
  const amount = parseFloat(r.amount ?? r.monto ?? r.total ?? 0) || 0;
  const rawPlateStr = String(r.plateType ?? r.tipoPlaca ?? r.placa ?? 'Panorámica').trim() || 'Panorámica';
  const plateTypes = Array.isArray(r.plateTypes) && r.plateTypes.length > 0
    ? r.plateTypes.map((p) => String(p).trim()).filter(Boolean)
    : rawPlateStr.split(/\s*\+\s*|\s*,\s*/).map((p) => p.trim()).filter(Boolean);
  const plateType = plateTypes.join(' + ') || 'Panorámica';
  const onlyPer = isPlateListOnlyPeriapical(plateTypes);
  const rawComm = parseFloat(r.commission ?? r.comision ?? 0) || 0;
  const commission = onlyPer ? 0 : rawComm;
  const paymentMethod = String(r.paymentMethod ?? r.metodoPago ?? r.pago ?? 'Efectivo').trim() || 'Efectivo';

  let amountEfectivo = parseFloat(r.amountEfectivo);
  let amountYape = parseFloat(r.amountYape);
  if (isNaN(amountEfectivo) || isNaN(amountYape)) {
    if (paymentMethod === 'Yape') {
      amountEfectivo = 0;
      amountYape = amount;
    } else if (paymentMethod === 'Mixto') {
      amountEfectivo = amount / 2;
      amountYape = amount - amountEfectivo;
    } else {
      amountEfectivo = amount;
      amountYape = 0;
    }
  }

  return {
    id: String(r.id || `ORD-IMP-${Date.now()}-${idx}`),
    datetime: normalizeDateTimeString(r.datetime || r.fecha || r.date),
    patient: String(r.patient ?? r.paciente ?? 'Paciente').trim(),
    doctor: String(r.doctor ?? r.doctorSolicitante ?? 'Sin especificar').trim(),
    province: String(r.province ?? r.provincia ?? 'Chota').trim(),
    plateType,
    plateTypes,
    amount,
    commission,
    paymentMethod,
    amountEfectivo,
    amountYape,
    commissionPaid: Boolean(r.commissionPaid ?? r.comisionPagada ?? false)
  };
}

function parseCSVBackupRecords(csvText) {
  const lines = csvText
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length < 2) return [];

  const splitCSVLine = (line) => {
    const res = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === ',' && !inQuotes) {
        res.push(cur);
        cur = '';
      } else {
        cur += ch;
      }
    }
    res.push(cur);
    return res;
  };

  return lines.slice(1).map((line, idx) => {
    const cols = splitCSVLine(line);
    if (cols.length < 6) return null;
    return normalizeImportedRecord(
      {
        id: cols[0],
        datetime: cols[1],
        patient: cols[2],
        doctor: cols[3],
        province: cols[4],
        plateType: cols[5],
        paymentMethod: cols[6],
        amountEfectivo: cols[7],
        amountYape: cols[8],
        amount: cols[9],
        commission: cols[10],
        commissionPaid: String(cols[11] || '').toLowerCase().includes('cancelado')
      },
      idx
    );
  }).filter(Boolean);
}

function resetAllTableFiltersForImport() {
  const searchEl = document.getElementById('search-input');
  if (searchEl) searchEl.value = '';
  ['filter-doctor', 'filter-comm-status', 'filter-plate', 'filter-payment', 'filter-province'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.value = 'ALL';
  });
}

function handleImportJSONFile(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const rawText = String(e.target.result || '').trim();
      let importedRecords = [];
      let importedDoctors = [];
      let importedProvinces = [];
      let importedTariffs = null;

      if (file.name.toLowerCase().endsWith('.csv') || (!rawText.startsWith('{') && !rawText.startsWith('['))) {
        importedRecords = parseCSVBackupRecords(rawText);
      } else {
        const data = JSON.parse(rawText.replace(/^\uFEFF/, ''));
        const rawList = Array.isArray(data)
          ? data
          : Array.isArray(data.records)
            ? data.records
            : Array.isArray(data.data)
              ? data.data
              : null;

        if (!rawList) {
          showToast('El archivo seleccionado no tiene el formato válido de BioDent.', true);
          return;
        }

        importedRecords = rawList.map((r, idx) => normalizeImportedRecord(r, idx)).filter(Boolean);
        if (Array.isArray(data.doctors)) importedDoctors = data.doctors;
        if (Array.isArray(data.provinces)) importedProvinces = data.provinces;
        if (data.tariffs && typeof data.tariffs === 'object') importedTariffs = data.tariffs;
      }

      if (importedRecords.length === 0) {
        tryRecoverFromIndexedDB();
        showToast(
          `⚠️ El archivo de respaldo seleccionado está vacío (0 registros). No se borraron sus datos actuales.`,
          true
        );
        return;
      }

      // Combinar registros existentes con los importados sin duplicar para no perder órdenes nuevas
      const existingById = new Map();
      state.records.forEach((r) => {
        if (r && r.id) existingById.set(r.id, r);
      });
      importedRecords.forEach((r) => {
        existingById.set(r.id, r);
        ensureCatalogEntry(state.doctors, r.doctor);
        ensureCatalogEntry(state.provinces, r.province);
      });

      state.records = Array.from(existingById.values()).sort((a, b) =>
        (b.datetime || '').localeCompare(a.datetime || '')
      );

      importedDoctors.forEach((d) => ensureCatalogEntry(state.doctors, d));
      importedProvinces.forEach((p) => ensureCatalogEntry(state.provinces, p));

      if (importedTariffs) {
        state.tariffs = { ...DEFAULT_TARIFFS, ...importedTariffs };
        if (state.tariffs['Periapical']) state.tariffs['Periapical'].commission = 0;
      }

      saveStateToStorage();
      populateDatalists();
      resetAllTableFiltersForImport();

      // Activar filtro "Todos los Registros" y llevar a la tabla principal para que se visualicen de inmediato
      setDateRangeFilter('all');
      switchView('view-operations');

      showToast(`✅ Se cargaron y visualizaron ${state.records.length} registro(s) correctamente.`);
    } catch (err) {
      console.error('Error al importar respaldo:', err);
      showToast('Error al leer el archivo de respaldo. Verifique que sea un archivo JSON o CSV de BioDent.', true);
    }
  };
  reader.readAsText(file, 'UTF-8');
}

function exportFilteredCSV() {
  const records = getFilteredRecordsForTable();
  if (records.length === 0) {
    showToast('No hay registros en la tabla actual para exportar.', true);
    return;
  }

  const headers = [
    'ID Orden',
    'Fecha y Hora',
    'Paciente',
    'Doctor Solicitante',
    'Provincia',
    'Tipo de Placa',
    'Metodo de Pago',
    'Monto Efectivo (S/)',
    'Monto Yape (S/)',
    'Monto Total Pagado (S/)',
    'Comision Doctor (S/)',
    'Estado Comision',
    'Utilidad Neta BioDent (S/)'
  ];

  const escapeCSV = (val) => {
    const str = String(val ?? '').replace(/"/g, '""');
    return `"${str}"`;
  };

  const rows = records.map((r) => {
    const amt = Number(r.amount) || 0;
    const com = r.plateType === 'Periapical' ? 0 : Number(r.commission) || 0;
    const net = amt - com;
    const split = getPaymentSplit(r);
    const commStatus =
      r.plateType === 'Periapical' || com <= 0
        ? 'Sin comision'
        : r.commissionPaid
          ? 'Cancelado'
          : 'Pendiente';

    return [
      escapeCSV(r.id),
      escapeCSV(formatReadableDateTime(r.datetime)),
      escapeCSV(r.patient),
      escapeCSV(r.doctor),
      escapeCSV(r.province),
      escapeCSV(r.plateType),
      escapeCSV(r.paymentMethod),
      split.efectivo.toFixed(2),
      split.yape.toFixed(2),
      amt.toFixed(2),
      com.toFixed(2),
      escapeCSV(commStatus),
      net.toFixed(2)
    ].join(',');
  });

  // UTF-8 BOM (\uFEFF) para que Microsoft Excel en Windows abra tildes y eñes correctamente
  const csvContent = '\uFEFF' + [headers.join(','), ...rows].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const datePart = getLocalNowISOString().slice(0, 10);
  a.href = url;
  a.download = `BioDent_Reporte_${datePart}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`Reporte Excel (CSV) exportado con ${records.length} registros.`);
}

/* ==========================================================================
   11. NAVEGACIÓN, MODALES RÁPIDOS Y CONFIGURACIÓN DE PRECIOS
   ========================================================================== */

function switchView(viewId) {
  document.querySelectorAll('.view-section').forEach((sec) => {
    sec.classList.toggle('active', sec.id === viewId);
  });
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === viewId);
  });

  const titles = {
    'view-operations': [
      'Control de Radiología Odontológica y Comisiones',
      'Registro rápido de placas radiográficas, tomografías Cone Beam y órdenes diarias'
    ],
    'view-cash': [
      'Cierre de Caja y Producción del Día',
      'Desglose de ingresos en Efectivo, Yape y Pagos Mixtos, comisiones y utilidad neta'
    ],
    'view-analytics': [
      'Reportes Avanzados y Estadísticas (Dashboard Analítico)',
      'Ranking de doctores solicitantes, tipos de placa más vendidas y procedencia por provincias'
    ],
    'view-doctors': [
      'Directorio de Doctores y Liquidación de Comisiones',
      'Control de comisiones pendientes y canceladas por doctor remitente'
    ],
    'view-utilities': [
      'Portabilidad Sin Conexión y Configuración de Tarifas',
      'Respaldo JSON para cambio de laptop, exportación a Excel (CSV) y tarifario sugerido'
    ]
  };

  if (titles[viewId]) {
    document.getElementById('current-view-title').textContent = titles[viewId][0];
    document.getElementById('current-view-subtitle').textContent = titles[viewId][1];
  }

  document.getElementById('sidebar').classList.remove('open');
  renderAll();
}

function toggleMobileSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

function closeModal(modalId) {
  document.getElementById(modalId)?.classList.remove('open');
}

function openTariffsModal() {
  const tPan = state.tariffs['Panorámica'] || { price: 80, commission: 20 };
  const tCef = state.tariffs['Cefalométrica'] || { price: 80, commission: 20 };
  const tPer = state.tariffs['Periapical'] || { price: 25, commission: 0 };
  const tCon = state.tariffs['Tomografía Cone Beam'] || { price: 180, commission: 40 };

  document.getElementById('modal-price-panoramica').value = tPan.price;
  document.getElementById('modal-comm-panoramica').value = tPan.commission;
  const mCefP = document.getElementById('modal-price-cefalometrica');
  if (mCefP) {
    mCefP.value = tCef.price;
    document.getElementById('modal-comm-cefalometrica').value = tCef.commission;
  }
  document.getElementById('modal-price-periapical').value = tPer.price;
  document.getElementById('modal-price-conebeam').value = tCon.price;
  document.getElementById('modal-comm-conebeam').value = tCon.commission;

  document.getElementById('tariffs-modal').classList.add('open');
}

function handleQuickTariffsSave(e) {
  e.preventDefault();
  state.tariffs = {
    'Panorámica': {
      price: parseFloat(document.getElementById('modal-price-panoramica').value) || 0,
      commission: parseFloat(document.getElementById('modal-comm-panoramica').value) || 0
    },
    'Cefalométrica': {
      price: parseFloat(document.getElementById('modal-price-cefalometrica')?.value) || 0,
      commission: parseFloat(document.getElementById('modal-comm-cefalometrica')?.value) || 0
    },
    'Periapical': {
      price: parseFloat(document.getElementById('modal-price-periapical').value) || 0,
      commission: 0
    },
    'Tomografía Cone Beam': {
      price: parseFloat(document.getElementById('modal-price-conebeam').value) || 0,
      commission: parseFloat(document.getElementById('modal-comm-conebeam').value) || 0
    }
  };

  saveStateToStorage();
  populateDatalists();
  applySelectedPlatesToForm();
  closeModal('tariffs-modal');
  showToast('Precios de exámenes actualizados.');
}

function openQuickAddModal(type) {
  document.getElementById('quick-add-type').value = type;
  const input = document.getElementById('quick-add-input');
  input.value = '';

  if (type === 'doctor') {
    document.getElementById('quick-add-title').textContent = 'Agregar Nuevo Doctor Solicitante';
    document.getElementById('quick-add-label').textContent = 'Nombre completo del Doctor(a)';
    input.placeholder = 'Ej. Dr. Roberto Mendoza Huamán';
  } else {
    document.getElementById('quick-add-title').textContent = 'Agregar Nueva Provincia';
    document.getElementById('quick-add-label').textContent = 'Nombre de la Provincia o Distrito';
    input.placeholder = 'Ej. Bambamarca, Bagua, Celendín...';
  }

  document.getElementById('quick-add-modal').classList.add('open');
  setTimeout(() => input.focus(), 80);
}

function handleQuickAddSubmit(e) {
  e.preventDefault();
  const type = document.getElementById('quick-add-type').value;
  const val = document.getElementById('quick-add-input').value.trim();
  if (!val) return;

  if (type === 'doctor') {
    ensureCatalogEntry(state.doctors, val);
    document.getElementById('inp-doctor').value = val;
    showToast(`Doctor agregado: ${val}`);
  } else {
    ensureCatalogEntry(state.provinces, val);
    document.getElementById('inp-province').value = val;
    showToast(`Provincia agregada: ${val}`);
  }

  saveStateToStorage();
  populateDatalists();
  closeModal('quick-add-modal');
  renderAll();
}

function saveTariffsConfig(e) {
  e.preventDefault();
  state.tariffs = {
    'Panorámica': {
      price: parseFloat(document.getElementById('cfg-price-panoramica').value) || 0,
      commission: parseFloat(document.getElementById('cfg-comm-panoramica').value) || 0
    },
    'Cefalométrica': {
      price: parseFloat(document.getElementById('cfg-price-cefalometrica')?.value) || 0,
      commission: parseFloat(document.getElementById('cfg-comm-cefalometrica')?.value) || 0
    },
    'Periapical': {
      price: parseFloat(document.getElementById('cfg-price-periapical').value) || 0,
      commission: 0
    },
    'Tomografía Cone Beam': {
      price: parseFloat(document.getElementById('cfg-price-conebeam').value) || 0,
      commission: parseFloat(document.getElementById('cfg-comm-conebeam').value) || 0
    }
  };

  saveStateToStorage();
  populateDatalists();
  applySelectedPlatesToForm();
  showToast('Precios y comisiones predeterminadas actualizadas.');
}

function showToast(message, isError = false) {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${isError ? 'error' : ''}`;
  toast.innerHTML = `<span>${isError ? '⚠️' : '✅'}</span><span>${escapeHTML(message)}</span>`;
  container.appendChild(toast);
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 250);
  }, 3200);
}

/* ==========================================================================
   12. PROTECCIÓN DE AUTORÍA E INTEGRIDAD DEL SISTEMA (By. Carlos Neira)
   ========================================================================== */

function initSecurityAndIntegrityGuard() {
  const REQUIRED_AUTHOR = 'By. Carlos Neira';

  // 1. Bloquear clic derecho e inspección de código en la interfaz del cliente
  document.addEventListener('contextmenu', (e) => {
    e.preventDefault();
  });

  document.addEventListener('keydown', (e) => {
    const key = (e.key || '').toUpperCase();
    const ctrlOrMeta = e.ctrlKey || e.metaKey;
    if (
      e.key === 'F12' ||
      (ctrlOrMeta && e.shiftKey && ['I', 'J', 'C', 'K'].includes(key)) ||
      (ctrlOrMeta && ['U', 'S'].includes(key))
    ) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  });

  // 2. Verificador continuo de integridad de la firma de autor
  const verifyAuthorIntegrity = () => {
    const s1 = document.getElementById('sig-sidebar');
    const s2 = document.getElementById('sig-author-badge');
    const f2 = document.getElementById('sig-footer');

    const REQUIRED_PHONE = '969 029 276';
    const valid =
      s1 &&
      s2 &&
      f2 &&
      s1.textContent.includes(REQUIRED_AUTHOR) &&
      s1.textContent.includes(REQUIRED_PHONE) &&
      s2.textContent.includes(REQUIRED_AUTHOR) &&
      s2.textContent.includes(REQUIRED_PHONE) &&
      window.getComputedStyle(s2).display !== 'none' &&
      window.getComputedStyle(f2).display !== 'none' &&
      window.getComputedStyle(s2).visibility !== 'hidden';

    if (!valid) {
      document.body.innerHTML = `
        <div style="min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0f172a;color:#fff;font-family:sans-serif;padding:2rem;text-align:center;">
          <div style="max-width:480px;background:#1e293b;padding:2rem;border-radius:16px;border:1px solid #ef4444;box-shadow:0 20px 25px rgba(0,0,0,0.4);">
            <h2 style="color:#f87171;margin-bottom:0.75rem;">Sistema Bloqueado por Modificación No Autorizada</h2>
            <p style="color:#cbd5e1;font-size:0.95rem;line-height:1.5;margin-bottom:1rem;">
              Se ha detectado una alteración en los archivos o créditos originales del sistema. Solicite el paquete oficial de actualización al desarrollador.
            </p>
            <div style="display:inline-block;padding:0.5rem 1.2rem;background:#065f46;color:#a7f3d0;border-radius:999px;font-weight:700;font-size:0.9rem;">
              ${REQUIRED_AUTHOR} · 📲 WhatsApp: ${REQUIRED_PHONE}
            </div>
          </div>
        </div>
      `;
      throw new Error('Integrity check failed.');
    }
  };

  verifyAuthorIntegrity();
  setInterval(verifyAuthorIntegrity, 2500);
}

/* ==========================================================================
   13. SISTEMA DE LICENCIAMIENTO POR PC Y VENCIMIENTO DE PRUEBA (7 DÍAS)
   ========================================================================== */

const LICENSE_STORAGE_KEY = 'biodent_pc_license_v1';
const MACHINE_UID_KEY = 'biodent_machine_uid_v1';
const KEY_HASH_TRIAL_ADMIN = '5a17666c-1045fae'; // CARLOS-PRUEBA-2026
const KEY_HASH_PERMANENT = 'cd1e490-104b93b';   // CARLOS-FULL-BIODENT

function computeLicenseHash(str) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    a ^= str.charCodeAt(i);
    a = Math.imul(a, b) >>> 0;
    b = (b + str.charCodeAt(i) * 131) >>> 0;
  }
  return a.toString(16) + '-' + b.toString(16);
}

function getMachineFingerprint() {
  let uid = localStorage.getItem(MACHINE_UID_KEY);
  if (!uid) {
    uid =
      'M-' +
      Math.random().toString(36).substring(2, 8).toUpperCase() +
      '-' +
      Date.now().toString(36).toUpperCase().slice(-4);
    localStorage.setItem(MACHINE_UID_KEY, uid);
  }
  const hwRaw = [
    uid,
    navigator.platform || 'WIN',
    navigator.hardwareConcurrency || 4,
    screen.width + 'x' + screen.height,
    screen.colorDepth || 24,
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'PE'
  ].join('|');

  const shortHash = computeLicenseHash(hwRaw).split('-')[0].toUpperCase().padStart(8, '0');
  return `PC-${shortHash.slice(0, 4)}-${shortHash.slice(4, 8)}`;
}

function signLicenseObject(status, expiresAt, machineId, clockTampered) {
  return computeLicenseHash(`${status}|${expiresAt}|${machineId}|${Boolean(clockTampered)}|BIODENT-PC-LOCK`);
}

function loadOrCreateLicense() {
  const machineId = getMachineFingerprint();
  const now = Date.now();
  const defaultExpires = now + 7 * 24 * 60 * 60 * 1000; // 7 días de prueba iniciales

  try {
    const raw = localStorage.getItem(LICENSE_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      const expectedSig = signLicenseObject(
        parsed.status,
        parsed.expiresAt,
        machineId,
        parsed.clockTampered
      );
      // Si la firma coincide con ESTA PC específica
      if (parsed.machineId === machineId && parsed.sig === expectedSig) {
        // Detectar si atrasaron el reloj de Windows más de 1 hora respecto al último uso
        if (now < (parsed.lastSeenAt || 0) - 3600 * 1000) {
          parsed.clockTampered = true;
        } else {
          parsed.lastSeenAt = Math.max(now, parsed.lastSeenAt || now);
        }
        parsed.sig = signLicenseObject(parsed.status, parsed.expiresAt, machineId, parsed.clockTampered);
        localStorage.setItem(LICENSE_STORAGE_KEY, JSON.stringify(parsed));
        return parsed;
      }
    }
  } catch (_) {}

  // Crear nueva licencia de prueba de 7 días vinculada a esta PC
  const freshLicense = {
    machineId,
    status: 'TRIAL', // 'TRIAL' | 'PERMANENT'
    createdAt: now,
    expiresAt: defaultExpires,
    lastSeenAt: now,
    clockTampered: false,
    sig: signLicenseObject('TRIAL', defaultExpires, machineId, false)
  };
  localStorage.setItem(LICENSE_STORAGE_KEY, JSON.stringify(freshLicense));
  return freshLicense;
}

function saveLicenseState(lic) {
  const machineId = getMachineFingerprint();
  lic.machineId = machineId;
  lic.lastSeenAt = Date.now();
  lic.sig = signLicenseObject(lic.status, lic.expiresAt, machineId, lic.clockTampered);
  localStorage.setItem(LICENSE_STORAGE_KEY, JSON.stringify(lic));
}

function getLicenseEvaluation() {
  const lic = loadOrCreateLicense();
  const now = Date.now();

  if (lic.status === 'PERMANENT' && !lic.clockTampered) {
    return {
      lic,
      isLocked: false,
      isPermanent: true,
      daysLeft: Infinity,
      reason: 'Licencia Permanente Activada en esta PC'
    };
  }

  if (lic.clockTampered) {
    return {
      lic,
      isLocked: true,
      isPermanent: false,
      daysLeft: 0,
      reason: 'Se detectó alteración en la fecha/reloj del sistema. Ingrese clave de autorización.'
    };
  }

  const msLeft = lic.expiresAt - now;
  const daysLeft = Math.ceil(msLeft / (24 * 60 * 60 * 1000));

  if (msLeft <= 0) {
    return {
      lic,
      isLocked: true,
      isPermanent: false,
      daysLeft: 0,
      reason: 'El periodo de prueba de 7 días ha finalizado en este equipo.'
    };
  }

  return {
    lic,
    isLocked: false,
    isPermanent: false,
    daysLeft,
    reason: `Periodo de prueba activo: quedan ${daysLeft} día(s) en este equipo.`
  };
}

function checkAndUpdateLicenseUI(forceOpenModal = false) {
  const evalState = getLicenseEvaluation();
  const badge = document.getElementById('sidebar-license-badge');
  const badgeText = document.getElementById('sidebar-license-text');
  const badgeDot = document.getElementById('sidebar-license-dot');
  const overlay = document.getElementById('license-overlay');
  const closeBtn = document.getElementById('license-close-btn');
  const machineLabel = document.getElementById('license-machine-label');
  const alertBox = document.getElementById('license-status-alert');
  const titleEl = document.getElementById('license-modal-title');

  if (machineLabel) {
    machineLabel.textContent = `ID único de esta PC: ${evalState.lic.machineId}`;
  }
  const waLink = document.getElementById('license-whatsapp-link');
  if (waLink) {
    const msg = encodeURIComponent(
      `Hola Carlos Neira, solicito clave de activación para el sistema BioDent Tomografías (ID de Equipo: ${evalState.lic.machineId}).`
    );
    waLink.href = `https://wa.me/51969029276?text=${msg}`;
  }

  if (evalState.isPermanent) {
    if (badgeText) badgeText.textContent = '✅ Licencia Permanente Activa';
    if (badgeDot) badgeDot.style.background = '#10b981';
    if (badge) {
      badge.style.background = 'rgba(16, 185, 129, 0.16)';
      badge.style.borderColor = 'rgba(16, 185, 129, 0.35)';
      badge.style.color = '#a7f3d0';
    }
  } else if (evalState.isLocked) {
    if (badgeText) badgeText.textContent = '🔒 Prueba Vencida (Activar)';
    if (badgeDot) badgeDot.style.background = '#ef4444';
    if (badge) {
      badge.style.background = 'rgba(239, 68, 68, 0.18)';
      badge.style.borderColor = 'rgba(239, 68, 68, 0.4)';
      badge.style.color = '#fecaca';
    }
  } else {
    if (badgeText) badgeText.textContent = `⏳ Prueba: ${evalState.daysLeft} día(s) restantes`;
    if (badgeDot) badgeDot.style.background = '#f59e0b';
    if (badge) {
      badge.style.background = 'rgba(245, 158, 11, 0.15)';
      badge.style.borderColor = 'rgba(245, 158, 11, 0.35)';
      badge.style.color = '#fde68a';
    }
  }

  if (alertBox) {
    if (evalState.isPermanent) {
      alertBox.style.background = 'var(--brand-emerald-50)';
      alertBox.style.borderColor = '#6ee7b7';
      alertBox.style.color = 'var(--brand-emerald-900)';
      alertBox.innerHTML = `<strong>✅ Sistema Liberado en este Equipo</strong><br>${escapeHTML(evalState.reason)} (No transferible a otras computadoras).`;
    } else if (evalState.isLocked) {
      alertBox.style.background = 'var(--danger-50)';
      alertBox.style.borderColor = '#fca5a5';
      alertBox.style.color = '#991b1b';
      alertBox.innerHTML = `<strong>🔒 Sistema Bloqueado — Licencia Vencida</strong><br>${escapeHTML(evalState.reason)} Todos sus registros están seguros. Ingrese la clave de extensión o liberación.`;
    } else {
      alertBox.style.background = 'var(--amber-50)';
      alertBox.style.borderColor = '#fcd34d';
      alertBox.style.color = '#92400e';
      const expDate = new Date(evalState.lic.expiresAt).toLocaleDateString('es-PE');
      alertBox.innerHTML = `<strong>⏳ Versión de Prueba Activa</strong><br>${escapeHTML(evalState.reason)} (Vence el ${expDate}).`;
    }
  }

  if (evalState.isLocked) {
    if (titleEl) titleEl.textContent = '🔒 Periodo de Prueba Finalizado';
    if (closeBtn) closeBtn.style.display = 'none';
    if (overlay) overlay.classList.add('open');
  } else {
    if (titleEl) titleEl.textContent = 'Control de Licencia del Sistema';
    if (closeBtn) closeBtn.style.display = 'inline-flex';
    if (forceOpenModal && overlay) {
      overlay.classList.add('open');
    }
  }
}

function openLicenseModal() {
  document.getElementById('inp-license-key').value = '';
  document.getElementById('trial-admin-panel')?.classList.remove('open');
  checkAndUpdateLicenseUI(true);
}

function closeLicenseModal() {
  const evalState = getLicenseEvaluation();
  if (evalState.isLocked) {
    showToast('Debe ingresar una clave válida para desbloquear el sistema.', true);
    return;
  }
  document.getElementById('license-overlay')?.classList.remove('open');
  document.getElementById('trial-admin-panel')?.classList.remove('open');
}

function handleLicenseKeySubmit(e) {
  e.preventDefault();
  const rawInput = (document.getElementById('inp-license-key').value || '').trim().toUpperCase();
  if (!rawInput) return;

  const candidateHash = computeLicenseHash(`${rawInput}|BIODENT-SALT`);

  // CLAVE 2: Liberación Definitiva en esta PC (CARLOS-FULL-BIODENT)
  if (candidateHash === KEY_HASH_PERMANENT) {
    const lic = loadOrCreateLicense();
    lic.status = 'PERMANENT';
    lic.clockTampered = false;
    saveLicenseState(lic);
    document.getElementById('inp-license-key').value = '';
    document.getElementById('trial-admin-panel')?.classList.remove('open');
    checkAndUpdateLicenseUI(false);
    document.getElementById('license-overlay')?.classList.remove('open');
    showToast('✅ ¡Licencia Permanente activada con éxito en esta PC!');
    return;
  }

  // CLAVE 1: Clave para Expandir 7 días o Editar días de prueba (CARLOS-PRUEBA-2026)
  if (candidateHash === KEY_HASH_TRIAL_ADMIN) {
    document.getElementById('inp-license-key').value = '';
    const adminPanel = document.getElementById('trial-admin-panel');
    if (adminPanel) {
      adminPanel.classList.add('open');
    }
    showToast('🔓 Modo Administrador de Prueba habilitado. Elija cuántos días asignar.');
    return;
  }

  showToast('Clave de autorización incorrecta. Verifique con By. Carlos Neira.', true);
}

function applyTrialExtensionDays(daysToAdd, additive = true) {
  const lic = loadOrCreateLicense();
  const now = Date.now();
  const baseTime = additive && lic.expiresAt > now ? lic.expiresAt : now;
  lic.status = 'TRIAL';
  lic.clockTampered = false;
  lic.expiresAt = baseTime + Number(daysToAdd) * 24 * 60 * 60 * 1000;
  saveLicenseState(lic);

  document.getElementById('trial-admin-panel')?.classList.remove('open');
  checkAndUpdateLicenseUI(false);
  if (!getLicenseEvaluation().isLocked) {
    document.getElementById('license-overlay')?.classList.remove('open');
  }
  showToast(`⏳ Se asignaron los días de prueba correctamente.`);
}

function applyCustomTrialDaysFromInput() {
  const days = parseInt(document.getElementById('inp-custom-trial-days').value, 10);
  if (isNaN(days) || days < 0) {
    showToast('Ingrese un número válido de días (0 o más).', true);
    return;
  }
  applyTrialExtensionDays(days, false);
}

/* ==========================================================================
   14. INICIALIZACIÓN AL CARGAR LA PÁGINA (COMPATIBLE CON PAQUETE BLINDADO)
   ========================================================================== */

function bootBioDentSystem() {
  if (window.__biodentBooted) return;
  if (!document.getElementById('records-tbody')) return;
  window.__biodentBooted = true;

  initSecurityAndIntegrityGuard();
  initIndexedDBMirror();
  loadStateFromStorage();
  initDmyControls();
  populateDatalists();
  resetOrderForm();
  renderAll();
  checkAndUpdateLicenseUI(false);
  setInterval(() => checkAndUpdateLicenseUI(false), 60000);

  // Sincronización en tiempo real con Firebase Cloud
  pullFromCloudDatabase(true);
  setInterval(() => {
    if (!document.hidden) {
      forceCloudSyncNow();
    }
  }, 8000);
  window.addEventListener('online', () => forceCloudSyncNow());
  window.addEventListener('offline', () => updateCloudBadgeUI('offline'));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) forceCloudSyncNow();
  });
}

window.bootBioDentSystem = bootBioDentSystem;

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', bootBioDentSystem);
} else {
  bootBioDentSystem();
}
window.addEventListener('load', bootBioDentSystem);
