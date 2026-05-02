"use strict";

// ── Supabase client ─────────────────────────────────────────────────────────
const sb = window.supabase.createClient(
  window.JET_CONFIG.SUPABASE_URL,
  window.JET_CONFIG.SUPABASE_KEY
);
const CFG = window.JET_CONFIG;

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

// ── State ───────────────────────────────────────────────────────────────────
let me = null;
let pendingAction = null;
let currentGPS = null;
let nearestPark = null;
let map = null;
let userMarker = null;
let parkMarkers = {};
let activeTurno = null;     // current open shift {id, entrada_at, ini_descanso_at, ...}
let timerHandle = null;     // setInterval id
let signedUrlCache = {};    // path -> {url, exp}
let actionInProgress = false; // anti-double-tap
let gpsWatchId = null;        // navigator.geolocation watch handle

window.JET = { sb, $, $$, CFG, getMe: () => me, getSignedUrl };

// ── UI helpers ──────────────────────────────────────────────────────────────
function showView(id) {
  $$(".view").forEach(v => v.classList.remove("active"));
  $(id).classList.add("active");
  if (id === "#view-main" && map) setTimeout(() => map.invalidateSize(), 50);
}
function showOverlay(t) { $("#overlay-text").textContent = t || "Procesando..."; $("#overlay").classList.remove("hidden"); }
function hideOverlay() { $("#overlay").classList.add("hidden"); }
function toast(msg, kind) {
  const t = document.createElement("div");
  t.className = "toast " + (kind || "");
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ── Time helpers (display only — server is source of truth) ─────────────────
function fmtTimeLocal(isoStr) {
  if (!isoStr) return "—";
  return new Date(isoStr).toLocaleTimeString("en-GB", {
    timeZone: CFG.TIMEZONE, hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit"
  });
}
function fmtTimeShort(isoStr) {
  if (!isoStr) return "—";
  return new Date(isoStr).toLocaleTimeString("en-GB", {
    timeZone: CFG.TIMEZONE, hour12: false, hour: "2-digit", minute: "2-digit"
  });
}
function fmtDateLocal(isoStr) {
  if (!isoStr) return "";
  return new Date(isoStr).toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
}
function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
}
function fmtSecs(secs) {
  if (!secs || secs < 0) return "00:00:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
function fmtSecsHM(secs) {
  if (!secs || secs < 0) return "0h 00m";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return `${h}h ${String(m).padStart(2,"0")}m`;
}
function fmtDuration(secs) {
  if (secs == null) return "—";
  if (secs < 60) return `${Math.round(secs)}s`;
  return fmtSecsHM(secs);
}

// ── Tabs ────────────────────────────────────────────────────────────────────
function showTabs() {
  $("#tabs").style.display = "flex";
  const isAdmin = me && me.isAdmin;
  $("#tab-admin").style.display = isAdmin ? "block" : "none";
  // Los admins no fichan tiempo: ocultar tab "Mi turno"
  $("#tab-empleado").style.display = isAdmin ? "none" : "block";
  // Horarios: visible para todos los autenticados
  $("#tab-horarios").style.display = me ? "block" : "none";
}
function hideTabs() { $("#tabs").style.display = "none"; }
function switchTab(name) {
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  if (name !== "empleado") stopGPSWatch();
  if (name === "empleado") enterMain();
  else if (name === "admin") {
    showView("#view-admin");
    if (window.JETAdmin) window.JETAdmin.load();
  } else if (name === "horarios") {
    showView("#view-horarios");
    if (window.JETHorarios) window.JETHorarios.open();
  }
}

// ── Auth: Login ─────────────────────────────────────────────────────────────
$("#btn-login").addEventListener("click", login);
$("#login-password").addEventListener("keydown", e => { if (e.key === "Enter") login(); });

async function login() {
  const email = $("#login-email").value.trim();
  const password = $("#login-password").value;
  if (!email || !password) { toast("Email y contraseña requeridos", "error"); return; }
  showOverlay("Verificando...");
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await loadMe();
  } catch (e) {
    toast(e.message || String(e), "error");
  } finally {
    hideOverlay();
  }
}

// ── Auth: Registration ──────────────────────────────────────────────────────
$("#btn-go-register").addEventListener("click", () => showView("#view-register"));
$("#btn-back-login").addEventListener("click", () => showView("#view-login"));
$("#btn-register").addEventListener("click", register);

async function register() {
  const nombre = $("#reg-nombre").value.trim();
  const email = $("#reg-email").value.trim();
  const password = $("#reg-password").value;
  const tel = $("#reg-telefono").value.trim() || null;

  if (!nombre || nombre.length < 3) { toast("Ingresa tu nombre completo", "error"); return; }
  if (!email || !email.includes("@")) { toast("Correo inválido", "error"); return; }
  if (!password || password.length < 6) { toast("Contraseña mínimo 6 caracteres", "error"); return; }

  showOverlay("Creando cuenta...");
  try {
    const { data: authData, error: authErr } = await sb.auth.signUp({ email, password });
    if (authErr) throw authErr;
    if (!authData.user) throw new Error("No se pudo crear usuario");

    let session = authData.session;
    if (!session) {
      const { data: signIn, error: signInErr } = await sb.auth.signInWithPassword({ email, password });
      if (signInErr) throw new Error("Cuenta creada pero login falló: " + signInErr.message);
      session = signIn.session;
    }

    const { error: empErr } = await sb.from("empleados").insert({
      auth_user_id: authData.user.id, nombre, email, telefono: tel,
    });
    if (empErr) {
      if (empErr.code === "23505") throw new Error("Ya existe una cuenta con ese correo");
      throw empErr;
    }

    toast("Cuenta creada. Espera aprobación del admin.", "success");
    await loadMe();
  } catch (e) {
    toast(e.message || String(e), "error");
  } finally {
    hideOverlay();
  }
}

// ── Load current user info ──────────────────────────────────────────────────
async function loadMe() {
  const { data: { session: authSess } } = await sb.auth.getSession();
  if (!authSess || !authSess.user) {
    me = null;
    hideTabs();
    showView("#view-login");
    return;
  }
  const email = authSess.user.email;
  const userId = authSess.user.id;

  let isAdmin = false;
  try {
    const { data: a } = await sb.from("admins").select("email").eq("email", email).maybeSingle();
    isAdmin = !!a;
  } catch {}

  let emp = null;
  try {
    const { data: e } = await sb.from("empleados").select("*").eq("auth_user_id", userId).maybeSingle();
    emp = e;
  } catch {}

  me = {
    auth_user_id: userId, email,
    nombre: emp ? emp.nombre : null,
    activo: emp ? emp.activo : false,
    isAdmin,
    empleadoId: emp ? emp.id : null,
  };
  showTabs();

  // Admin SIEMPRE va al panel admin (incluso si tiene cuenta empleado pendiente)
  if (me.isAdmin) {
    switchTab("admin");
    return;
  }

  if (!emp) {
    toast("No hay datos de empleado. Completa el registro.", "error");
    showView("#view-register");
    return;
  }

  if (!me.activo) { showPending(); return; }
  switchTab("empleado");
}

function showPending() {
  showView("#view-pending");
  $("#pending-name").textContent = me.nombre || me.email;
}

async function logoutAll() {
  stopTimer();
  stopGPSWatch();
  await sb.auth.signOut();
  me = null;
  activeTurno = null;
  hideTabs();
  showView("#view-login");
  $("#login-email").value = "";
  $("#login-password").value = "";
}

document.addEventListener("DOMContentLoaded", () => {
  $$(".tab").forEach(t => t.addEventListener("click", () => switchTab(t.dataset.tab)));
  const tabLogout = $("#tab-logout");
  if (tabLogout) tabLogout.addEventListener("click", logoutAll);
  const btnCheck = $("#btn-check-again");
  if (btnCheck) btnCheck.addEventListener("click", loadMe);
  const btnPLogout = $("#btn-pending-logout");
  if (btnPLogout) btnPLogout.addEventListener("click", logoutAll);
  const btnMisHoras = $("#btn-mis-horas");
  if (btnMisHoras) btnMisHoras.addEventListener("click", loadMisHoras);
  const btnBackMain = $("#btn-back-main");
  if (btnBackMain) btnBackMain.addEventListener("click", () => switchTab("empleado"));
  const btnRequestCorr = $("#btn-request-correction");
  if (btnRequestCorr) btnRequestCorr.addEventListener("click", openCorrectionForm);
  const btnCorrCancel = $("#btn-corr-cancel");
  if (btnCorrCancel) btnCorrCancel.addEventListener("click", () => switchTab("empleado"));
  const btnCorrSubmit = $("#btn-corr-submit");
  if (btnCorrSubmit) btnCorrSubmit.addEventListener("click", submitCorrection);
  const corrTipo = $("#corr-tipo");
  if (corrTipo) corrTipo.addEventListener("change", updateCorrectionFormFields);
});

// ── Main view ───────────────────────────────────────────────────────────────
async function enterMain() {
  if (!me || !me.activo) { showPending(); return; }
  $("#display-empleado").textContent = me.nombre;
  $("#display-status-park").textContent = "Esperando GPS…";
  showView("#view-main");
  initMap();
  startGPSWatch();
  await refreshActiveTurno();
  loadEmpleadoSchedule(); // async, no bloquear
}

async function loadEmpleadoSchedule() {
  if (!me || !me.empleadoId) return;
  try {
    const fromIso = dateOffset(0); // hoy en TZ correcta
    const to = new Date(); to.setDate(to.getDate() + 6);
    const toIso = to.toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
    const { data } = await sb.from("shift_assignments")
      .select("fecha, status, hora_inicio, hora_fin, notas")
      .eq("empleado_id", me.empleadoId)
      .gte("fecha", fromIso)
      .lte("fecha", toIso)
      .order("fecha");
    renderTodaySchedule(data || []);
    renderWeekStrip(data || []);
  } catch (e) { /* silencio: schedule es opcional */ }
}

function renderTodaySchedule(rows) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
  const todayRow = rows.find(r => r.fecha === today);
  const el = $("#today-schedule");
  if (!el) return;
  if (!todayRow) { el.style.display = "none"; return; }
  const st = CFG.SHIFT_STATUS[todayRow.status];
  el.style.display = "flex";
  el.className = "today-schedule is-" + todayRow.status.replace("_","-");
  let text = "";
  if (todayRow.status === "scheduled") {
    text = `${todayRow.hora_inicio?.slice(0,5) || "—"} → ${todayRow.hora_fin?.slice(0,5) || "—"}`;
    if (todayRow.notas) text += ` · ${todayRow.notas}`;
  } else {
    text = st ? st.label : todayRow.status;
  }
  el.innerHTML = `
    <div class="ts-icon">${st ? st.icon : "📅"}</div>
    <div style="flex:1;">
      <div class="ts-label">Hoy · ${st ? st.label : ""}</div>
      <div class="ts-text">${text}</div>
    </div>`;
}

function renderWeekStrip(rows) {
  const el = $("#week-strip");
  if (!el) return;
  el.style.display = "grid";
  el.innerHTML = "";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
  const byDate = {};
  rows.forEach(r => byDate[r.fecha] = r);
  for (let i = 0; i < 7; i++) {
    const d = new Date(); d.setDate(d.getDate() + i);
    const dStr = d.toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
    const r = byDate[dStr];
    const dow = d.toLocaleDateString("es-MX", { weekday: "short", timeZone: CFG.TIMEZONE }).replace(".","");
    const num = d.getDate();
    const isToday = dStr === today;
    let cls = "week-cell";
    let statusTxt = "";
    if (isToday) cls += " is-today";
    if (r) {
      cls += " is-" + r.status.replace("_","-");
      if (r.status === "scheduled") {
        const hi = r.hora_inicio?.slice(0,5) || "";
        const hf = r.hora_fin?.slice(0,5) || "";
        statusTxt = hf ? `${hi}<br>→${hf}` : hi;
      } else {
        statusTxt = CFG.SHIFT_STATUS[r.status]?.icon || "";
      }
    }
    const cell = document.createElement("div");
    cell.className = cls;
    cell.innerHTML = `<div class="wc-dow">${dow}</div><div class="wc-num">${num}</div><div class="wc-status">${statusTxt}</div>`;
    el.appendChild(cell);
  }
}

// Bounding box de San Pedro Garza García (con margen)
const SPGG_BBOX = { south: 25.570, north: 25.700, west: -100.470, east: -100.320 };
function inSPGG(lat, lng) {
  return lat >= SPGG_BBOX.south && lat <= SPGG_BBOX.north
      && lng >= SPGG_BBOX.west && lng <= SPGG_BBOX.east;
}

function initMap() {
  if (map) return;
  map = L.map("map", { zoomControl: true, attributionControl: false }).setView([25.6571, -100.3897], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  Object.entries(CFG.PARQUES).forEach(([name, p]) => {
    const marker = L.marker([p.lat, p.lng], {
      icon: L.divIcon({
        html: '<div style="background:#005bff;border:2px solid white;border-radius:50%;width:10px;height:10px;box-shadow:0 0 0 2px #005bff80;"></div>',
        iconSize: [10, 10], iconAnchor: [5, 5], className: "",
      })
    }).addTo(map);
    marker.bindTooltip(name, { permanent: false });
    parkMarkers[name] = marker;
  });
}

function startGPSWatch() {
  if (!navigator.geolocation) {
    $("#park-status").textContent = "GPS no disponible en este dispositivo";
    return;
  }
  if (gpsWatchId !== null) return; // ya hay un watch activo
  gpsWatchId = navigator.geolocation.watchPosition(
    pos => updateUserLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
    err => {
      $("#park-status").textContent = "Permite ubicación para continuar";
      $("#park-status").className = "park-status out-zone";
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}
function stopGPSWatch() {
  if (gpsWatchId !== null) {
    navigator.geolocation.clearWatch(gpsWatchId);
    gpsWatchId = null;
  }
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function updateUserLocation(lat, lng, accuracy) {
  currentGPS = { lat, lng, accuracy };
  let nearest = null, minDist = Infinity;
  Object.entries(CFG.PARQUES).forEach(([name, p]) => {
    const d = haversine(lat, lng, p.lat, p.lng);
    if (d < minDist) { minDist = d; nearest = { name, distance: d, park: p }; }
  });
  nearestPark = nearest;

  if (userMarker) userMarker.remove();
  userMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      html: '<div style="background:#005bff;border:3px solid white;border-radius:50%;width:18px;height:18px;box-shadow:0 0 0 3px rgba(0,91,255,0.4);"></div>',
      iconSize: [18, 18], iconAnchor: [9, 9], className: "",
    })
  }).addTo(map);
  map.setView([lat, lng], Math.max(map.getZoom(), 14));

  const ps = $("#park-status");
  const accWarn = (accuracy && accuracy > 100) ? ` <small style="opacity:0.7">±${Math.round(accuracy)}m</small>` : "";
  if (inSPGG(lat, lng)) {
    ps.innerHTML = `✓ Ubicación verificada · San Pedro Garza García${accWarn}`;
    ps.className = "park-status in-zone";
    $("#display-status-park").textContent = nearest ? nearest.name : "San Pedro Garza García";
  } else {
    ps.innerHTML = `⚠ Estás fuera de San Pedro Garza García${accWarn}`;
    ps.className = "park-status out-zone";
    $("#display-status-park").textContent = "Fuera de SPGG";
  }
}

// ── Active shift tracking + live timer ──────────────────────────────────────
async function refreshActiveTurno() {
  try {
    const { data, error } = await sb.from("turnos")
      .select("*").eq("empleado_id", me.empleadoId).is("salida_at", null).is("deleted_at", null)
      .order("entrada_at", { ascending: false });
    if (error) throw error;
    if (data && data.length > 1) {
      console.warn("[JET] Multiple open shifts detected:", data.map(d => d.id));
      toast("⚠ Múltiples turnos abiertos detectados. Contacta al admin.", "error");
    }
    activeTurno = data && data.length ? data[0] : null;
    renderShift();
    if (activeTurno) startTimer();
    else stopTimer();
  } catch (e) {
    toast("Error: " + (e.message || e), "error");
  }
}

function renderShift() {
  const heroLabel = $("#hero-label");
  const heroSub = $("#hero-sub");
  const times = $("#status-times");
  const actions = $("#actions");
  const timerEl = $("#live-timer");
  const clockBtn = $("#btn-clock-main");
  const clockIcon = $("#clock-icon");
  const clockLabel = $("#clock-label");
  const dot = $("#emp-status-dot");

  times.innerHTML = "";
  actions.innerHTML = "";

  // Update avatar initial
  const avatar = $("#emp-avatar");
  if (avatar && me && me.nombre) avatar.textContent = me.nombre.trim().charAt(0).toUpperCase();

  if (!activeTurno) {
    heroLabel.textContent = "SIN TURNO ACTIVO";
    heroLabel.className = "hero-label";
    heroSub.textContent = "Toca para registrar tu entrada";
    timerEl.textContent = "00:00:00";
    timerEl.classList.remove("on-break", "active");
    clockBtn.className = "btn-clock btn-clock-start";
    clockIcon.textContent = "▶";
    clockLabel.textContent = "Iniciar turno";
    clockBtn.onclick = () => triggerAction("start_shift");
    if (dot) dot.className = "emp-status-dot";
    return;
  }

  const onBreak = activeTurno.ini_descanso_at && !activeTurno.fin_descanso_at;
  if (onBreak) {
    heroLabel.textContent = "EN DESCANSO";
    heroLabel.className = "hero-label hero-label-break";
    heroSub.textContent = activeTurno.punto || "";
    timerEl.classList.add("on-break");
    timerEl.classList.remove("active");
    clockBtn.className = "btn-clock btn-clock-resume";
    clockIcon.textContent = "↩";
    clockLabel.textContent = "Volver al trabajo";
    clockBtn.onclick = () => triggerAction("end_lunch");
    if (dot) dot.className = "emp-status-dot dot-break";
  } else {
    heroLabel.textContent = "TRABAJANDO";
    heroLabel.className = "hero-label hero-label-active";
    heroSub.textContent = activeTurno.punto || "";
    timerEl.classList.add("active");
    timerEl.classList.remove("on-break");
    clockBtn.className = "btn-clock btn-clock-stop";
    clockIcon.textContent = "⏹";
    clockLabel.textContent = "Cerrar turno";
    clockBtn.onclick = () => triggerAction("end_shift");
    if (dot) dot.className = "emp-status-dot dot-active";
  }

  // Inline timeline of timestamps
  const rows = [
    ["Entrada", fmtTimeShort(activeTurno.entrada_at)],
    ["Inicio descanso", fmtTimeShort(activeTurno.ini_descanso_at)],
    ["Fin descanso", fmtTimeShort(activeTurno.fin_descanso_at)],
  ];
  rows.forEach(([label, val]) => {
    if (val !== "—") {
      const div = document.createElement("div");
      div.className = "row";
      div.innerHTML = `<span>${label}</span><span>${val}</span>`;
      times.appendChild(div);
    }
  });

  // Secondary action: descanso button (только когда не на перерыве)
  if (!onBreak) {
    addActionButton(actions, "start_lunch", "🍴 Iniciar descanso", "btn-secondary");
  }
}

function addActionButton(container, action, label, klass) {
  const b = document.createElement("button");
  b.className = "btn " + klass;
  b.textContent = label;
  b.onclick = () => triggerAction(action);
  container.appendChild(b);
}

function startTimer() {
  if (timerHandle) clearInterval(timerHandle);
  const tick = () => {
    if (!activeTurno) { stopTimer(); return; }
    const now = Date.now();
    const startMs = new Date(activeTurno.entrada_at).getTime();
    let totalSecs = Math.max(0, Math.floor((now - startMs) / 1000));
    let lunchSecs = 0;
    if (activeTurno.ini_descanso_at) {
      const lunchStart = new Date(activeTurno.ini_descanso_at).getTime();
      const lunchEnd = activeTurno.fin_descanso_at ? new Date(activeTurno.fin_descanso_at).getTime() : now;
      lunchSecs = Math.max(0, Math.floor((lunchEnd - lunchStart) / 1000));
    }
    const workSecs = totalSecs - lunchSecs;
    $("#live-timer").textContent = fmtSecs(workSecs);
    if (activeTurno.ini_descanso_at && !activeTurno.fin_descanso_at) {
      $("#live-timer").classList.add("on-break");
    } else {
      $("#live-timer").classList.remove("on-break");
    }
  };
  tick();
  timerHandle = setInterval(tick, 1000);
}

function stopTimer() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
}

// ── Action: GPS check → photo → RPC ─────────────────────────────────────────
function triggerAction(action) {
  if (actionInProgress) { toast("Espera... acción en progreso", "error"); return; }
  if (!currentGPS) { toast("Esperando ubicación... permite GPS", "error"); return; }
  if (!inSPGG(currentGPS.lat, currentGPS.lng)) {
    toast("Estás fuera de San Pedro Garza García", "error");
    return;
  }
  if (currentGPS.accuracy && currentGPS.accuracy > 200) {
    if (!confirm(`Tu GPS tiene baja precisión (±${Math.round(currentGPS.accuracy)}m). ¿Continuar?`)) return;
  }
  actionInProgress = true;
  pendingAction = action;
  $("#photo-input").value = "";
  $("#photo-input").click();
}

$("#photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) { actionInProgress = false; return; }
  if (!currentGPS || !nearestPark) { toast("GPS perdido", "error"); actionInProgress = false; return; }
  if (!pendingAction) { actionInProgress = false; return; }

  let uploadedPath = null;
  showOverlay("Comprimiendo foto...");
  try {
    const blob = await compressImageToBlob(file);
    if (!blob) throw new Error("Error al comprimir foto");
    showOverlay("Subiendo foto...");
    uploadedPath = await uploadPhoto(blob, pendingAction);
    showOverlay("Registrando...");
    const result = await callRPC(pendingAction, uploadedPath, currentGPS, nearestPark.name);
    toast(result.message, "success");
    await refreshActiveTurno();
  } catch (err) {
    // Cleanup: si la foto subió pero el RPC falló, eliminamos la foto huérfana
    if (uploadedPath) {
      sb.storage.from("fotos").remove([uploadedPath]).catch(() => {});
    }
    toast(err.message || String(err), "error");
  } finally {
    hideOverlay();
    pendingAction = null;
    actionInProgress = false;
  }
});

async function uploadPhoto(blob, action) {
  const safeName = me.nombre.replace(/[^a-zA-Z0-9_-]/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${dateOffset(0)}/${safeName}_${action}_${stamp}.jpg`;
  const { error } = await sb.storage.from("fotos").upload(path, blob, {
    contentType: "image/jpeg", upsert: false,
  });
  if (error) throw new Error("Error subiendo foto: " + error.message);
  return path;
}

async function callRPC(action, photoPath, coords, parkName) {
  let rpcName, args;
  if (action === "start_shift") {
    rpcName = "start_shift";
    args = { p_punto: parkName, p_foto_url: photoPath, p_lat: coords.lat, p_lng: coords.lng };
  } else if (action === "start_lunch") {
    rpcName = "start_lunch"; args = { p_foto_url: photoPath };
  } else if (action === "end_lunch") {
    rpcName = "end_lunch"; args = { p_foto_url: photoPath };
  } else if (action === "end_shift") {
    rpcName = "end_shift";
    args = { p_foto_url: photoPath, p_lat: coords.lat, p_lng: coords.lng };
  }
  const { data, error } = await sb.rpc(rpcName, args);
  if (error) throw new Error(error.message);
  if (!data || !data.ok) throw new Error("Operación falló");
  let msg = "OK";
  if (action === "start_shift") msg = "Turno iniciado";
  else if (action === "start_lunch") msg = "Descanso iniciado";
  else if (action === "end_lunch") msg = "De vuelta al trabajo";
  else if (action === "end_shift") msg = `Turno cerrado: ${fmtSecsHM(data.work_secs)} trabajadas`;
  return { message: msg };
}

// ── Mis horas ───────────────────────────────────────────────────────────────
async function loadMisHoras() {
  showView("#view-mishoras");
  showOverlay("Cargando historial...");
  try {
    const sinceDate = dateOffset(14);
    const { data, error } = await sb.from("turnos")
      .select("id, punto, entrada_at, ini_descanso_at, fin_descanso_at, salida_at, horas_comida_secs, horas_trab_secs, source")
      .eq("empleado_id", me.empleadoId)
      .is("deleted_at", null)
      .gte("entrada_at", sinceDate + "T00:00:00")
      .order("entrada_at", { ascending: false });
    if (error) throw error;

    // Carga también solicitudes correcciones del usuario
    const { data: corr } = await sb.from("correction_requests")
      .select("id, fecha, tipo, status, motivo, admin_note, created_at")
      .eq("empleado_id", me.empleadoId)
      .order("created_at", { ascending: false }).limit(20);

    // Solo eventos pasados marcados explícitamente (libre/enfermo/falta)
    // No mostramos "scheduled" — esos son planes, no horas trabajadas
    const today = new Date().toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
    const { data: shifts } = await sb.from("shift_assignments")
      .select("fecha, status, hora_inicio, hora_fin, notas")
      .eq("empleado_id", me.empleadoId)
      .gte("fecha", sinceDate)
      .lte("fecha", today)
      .in("status", ["day_off", "sick", "absent"])
      .order("fecha", { ascending: false });

    renderMisHoras(data || [], corr || [], shifts || []);
  } catch (e) {
    toast(e.message, "error");
  } finally {
    hideOverlay();
  }
}

function renderMisHoras(turnos, corrections, shifts) {
  shifts = shifts || [];
  const monday = mondayOffset(0);
  const monday1 = mondayOffset(1);
  let secWeek = 0, secWeekPrev = 0, sec14 = 0;
  turnos.forEach(r => {
    const sec = r.horas_trab_secs || 0;
    sec14 += sec;
    const d = fmtDateLocal(r.entrada_at);
    if (d >= monday) secWeek += sec;
    else if (d >= monday1) secWeekPrev += sec;
  });
  $("#hrs-week").textContent      = fmtSecsHM(secWeek);
  $("#hrs-week-prev").textContent = fmtSecsHM(secWeekPrev);
  $("#hrs-14d").textContent       = fmtSecsHM(sec14);

  const list = $("#history-list");
  list.innerHTML = "";

  // Construir lista plana: cada turno = 1 entrada, cada evento (sin turno ese día) = 1 entrada
  const items = [];
  const datesWithTurnos = new Set();
  turnos.forEach(r => {
    const d = fmtDateLocal(r.entrada_at);
    datesWithTurnos.add(d);
    items.push({ sortKey: r.entrada_at, date: d, turno: r });
  });
  shifts.forEach(s => {
    if (datesWithTurnos.has(s.fecha)) return; // si hay turno real, no duplicamos con evento
    items.push({ sortKey: s.fecha + "T00:00:00", date: s.fecha, shift: s });
  });
  items.sort((a, b) => b.sortKey.localeCompare(a.sortKey));

  if (!items.length) {
    list.innerHTML = "<div class='park-status' style='margin:0;'>No hay registros aún</div>";
  } else {
    items.forEach(it => {
      const r = it.turno;
      const s = it.shift;
      const date = it.date;
      const div = document.createElement("div");
      let cls = "history-row";
      let statusPill = "";
      let dateTxt = date;
      let detail = "";
      let hoursTxt = "";

      if (r) {
        // Hubo turno real ese día
        const inT = fmtTimeShort(r.entrada_at);
        const outT = r.salida_at ? fmtTimeShort(r.salida_at) : "abierto";
        const iniD = r.ini_descanso_at ? fmtTimeShort(r.ini_descanso_at) : null;
        const finD = r.fin_descanso_at ? fmtTimeShort(r.fin_descanso_at) : null;
        const segments = [];
        segments.push(`▶ ${inT}`);
        if (iniD) segments.push(`🍴 ${iniD}`);
        if (finD) segments.push(`↩ ${finD}`);
        segments.push(`⏹ ${outT}`);
        const punto = r.punto ? `<div class="punto" style="margin-top:2px;">${r.punto}</div>` : "";
        detail = `<div class="timeline-row">${segments.join(" · ")}</div>${punto}`;
        // Calcular tiempo de descanso si hay
        const hasLunch = r.horas_comida_secs && r.horas_comida_secs > 0;
        const lunchTxt = hasLunch ? `<div class="lunch-info">🍴 ${fmtDuration(r.horas_comida_secs)} comida</div>` : "";
        // Calcular horas trabajadas: si BD no las tiene aún, calcular desde timestamps
        let workSecs = r.horas_trab_secs;
        if (!workSecs && r.salida_at) {
          const total = Math.max(0, (new Date(r.salida_at).getTime() - new Date(r.entrada_at).getTime()) / 1000);
          const lunchSecs = (iniD && finD) ? Math.max(0, (new Date(r.fin_descanso_at).getTime() - new Date(r.ini_descanso_at).getTime()) / 1000) : 0;
          workSecs = total - lunchSecs;
        }
        if (r.salida_at) {
          if (workSecs == null) hoursTxt = "—";
          else if (workSecs < 60) hoursTxt = `${Math.round(workSecs)}s`;
          else hoursTxt = fmtSecsHM(workSecs);
        } else {
          hoursTxt = "en curso";
        }
        hoursTxt += lunchTxt;
        if (r.source === "manual_correction") {
          statusPill = ` <span class="status-pill" style="background:var(--jet-warn);color:#5a3e00;">EDITADO</span>`;
        }
      } else if (s) {
        // No hubo turno, pero hay registro de schedule
        const st = CFG.SHIFT_STATUS[s.status];
        cls += " is-" + s.status.replace("_","-");
        statusPill = ` <span class="status-pill" style="background:${st?.bg};color:${st?.color};">${st?.icon} ${st?.label}</span>`;
        if (s.status === "scheduled") {
          detail = `${(s.hora_inicio||"").slice(0,5)} → ${(s.hora_fin||"").slice(0,5)}${s.notas ? " · " + s.notas : ""} (no fichado)`;
          hoursTxt = "—";
        } else if (s.status === "day_off") {
          detail = "Día libre" + (s.notas ? " · " + s.notas : "");
          hoursTxt = "🌴";
        } else if (s.status === "absent") {
          detail = "Falta" + (s.notas ? " · " + s.notas : "");
          hoursTxt = "❌";
        } else if (s.status === "sick") {
          detail = "Enfermo" + (s.notas ? " · " + s.notas : "");
          hoursTxt = "🤒";
        }
      }

      div.className = cls;
      div.innerHTML = `
        <div style="flex:1;min-width:0;">
          <div class="date">${dateTxt}${statusPill}</div>
          <div class="punto-block">${detail}</div>
        </div>
        <div class="hours">${hoursTxt}</div>`;
      list.appendChild(div);
    });
  }

  // Render correction requests
  const corrList = $("#correction-list");
  if (corrList) {
    corrList.innerHTML = "";
    if (!corrections.length) {
      corrList.innerHTML = "<div class='park-status' style='margin:0;font-size:12px;'>Sin solicitudes</div>";
    } else {
      corrections.forEach(c => {
        const div = document.createElement("div");
        div.className = "history-row";
        const colorMap = { pending: "var(--jet-warn)", approved: "var(--jet-success)", rejected: "var(--jet-danger)" };
        const labelMap = { pending: "Pendiente", approved: "Aprobada", rejected: "Rechazada" };
        const tipoMap = { forgot_start:"Olvidé entrar", forgot_end:"Olvidé salir", forgot_lunch:"Olvidé descanso", wrong_time:"Hora incorrecta", other:"Otro" };
        div.innerHTML = `
          <div>
            <div class="date">${c.fecha} · ${tipoMap[c.tipo] || c.tipo}</div>
            <span class="punto">${c.motivo}${c.admin_note ? " · " + c.admin_note : ""}</span>
          </div>
          <div class="hours" style="background:${colorMap[c.status]};color:white;padding:3px 10px;border-radius:10px;font-size:11px;">${labelMap[c.status]}</div>`;
        corrList.appendChild(div);
      });
    }
  }
}

function mondayOffset(weeksAgo) {
  const d = new Date();
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day - 7 * (weeksAgo || 0));
  return d.toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
}

// ── Correction request form ─────────────────────────────────────────────────
function openCorrectionForm() {
  showView("#view-correction");
  $("#corr-fecha").value = dateOffset(0);
  $("#corr-tipo").value = "forgot_start";
  $("#corr-motivo").value = "";
  $("#corr-time").value = "";
  updateCorrectionFormFields();
}

function updateCorrectionFormFields() {
  const tipo = $("#corr-tipo").value;
  const showTime = ["forgot_start", "forgot_end", "forgot_lunch", "wrong_time"].includes(tipo);
  $("#corr-time-row").style.display = showTime ? "block" : "none";
}

async function submitCorrection() {
  const fecha = $("#corr-fecha").value;
  const tipo = $("#corr-tipo").value;
  const motivo = $("#corr-motivo").value.trim();
  const timeStr = $("#corr-time").value;

  if (!fecha) { toast("Selecciona la fecha", "error"); return; }
  if (motivo.length < 5) { toast("Explica al menos en 5 caracteres", "error"); return; }

  const tipoToField = {
    forgot_start: "entrada_at",
    forgot_end: "salida_at",
    forgot_lunch: "ini_descanso_at",
    wrong_time: "entrada_at",
  };
  const fieldName = tipoToField[tipo] || null;

  let proposed = null;
  if (timeStr && fieldName) {
    proposed = new Date(`${fecha}T${timeStr}:00`).toISOString();
  }

  showOverlay("Enviando solicitud...");
  try {
    // Find turno_id for that fecha if any
    const { data: t } = await sb.from("turnos")
      .select("id").eq("empleado_id", me.empleadoId)
      .gte("entrada_at", fecha + "T00:00:00").lt("entrada_at", fecha + "T23:59:59")
      .limit(1).maybeSingle();
    const turnoId = t ? t.id : null;

    const { data, error } = await sb.rpc("request_correction", {
      p_turno_id: turnoId, p_fecha: fecha, p_tipo: tipo,
      p_field_name: fieldName, p_proposed_time: proposed, p_motivo: motivo,
    });
    if (error) throw new Error(error.message);
    toast("Solicitud enviada al admin", "success");
    switchTab("empleado");
  } catch (e) {
    toast(e.message, "error");
  } finally {
    hideOverlay();
  }
}

// ── Image compression ───────────────────────────────────────────────────────
function compressImageToBlob(file, maxDim = 800, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const r = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * r);
          height = Math.round(height * r);
        }
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob(b => b ? resolve(b) : reject(new Error("Error comprimiendo (memoria)")), "image/jpeg", quality);
      };
      img.onerror = () => reject(new Error("No se pudo leer imagen"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("Error leyendo archivo"));
    reader.readAsDataURL(file);
  });
}

// ── Signed URL для отображения фото в админке (private bucket) ──────────────
async function getSignedUrl(path) {
  if (!path) return null;
  const cached = signedUrlCache[path];
  if (cached && cached.exp > Date.now()) return cached.url;
  try {
    const { data, error } = await sb.storage.from("fotos").createSignedUrl(path, 3600);
    if (error) throw error;
    signedUrlCache[path] = { url: data.signedUrl, exp: Date.now() + 3500 * 1000 };
    return data.signedUrl;
  } catch {
    return null;
  }
}

// ── Init ────────────────────────────────────────────────────────────────────
(async function init() {
  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes("PEGAR")) {
    toast("Falta configurar SUPABASE_URL en js/config.js", "error");
    return;
  }
  await loadMe();
})();

sb.auth.onAuthStateChange((event) => {
  if (event === "SIGNED_OUT") {
    me = null; activeTurno = null; stopTimer();
    hideTabs(); showView("#view-login");
  }
});
