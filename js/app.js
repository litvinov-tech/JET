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
  return d.toISOString().slice(0, 10);
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

// ── Tabs ────────────────────────────────────────────────────────────────────
function showTabs() {
  $("#tabs").style.display = "flex";
  $("#tab-admin").style.display = (me && me.isAdmin) ? "block" : "none";
}
function hideTabs() { $("#tabs").style.display = "none"; }
function switchTab(name) {
  $$(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === name));
  if (name === "empleado") enterMain();
  else if (name === "admin") {
    showView("#view-admin");
    if (window.JETAdmin) window.JETAdmin.load();
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
}

function initMap() {
  if (map) return;
  map = L.map("map", { zoomControl: true, attributionControl: false }).setView([25.66, -100.38], 13);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19 }).addTo(map);
  Object.entries(CFG.PARQUES).forEach(([name, p]) => {
    const circle = L.circle([p.lat, p.lng], {
      radius: p.radius, color: "#005bff", fillColor: "#4d8eff", fillOpacity: 0.2, weight: 2,
    }).addTo(map);
    circle.bindTooltip(name, { permanent: false });
    parkMarkers[name] = circle;
  });
  const bounds = L.latLngBounds(Object.values(CFG.PARQUES).map(p => [p.lat, p.lng]));
  map.fitBounds(bounds, { padding: [30, 30] });
}

function startGPSWatch() {
  if (!navigator.geolocation) {
    $("#park-status").textContent = "GPS no disponible en este dispositivo";
    return;
  }
  navigator.geolocation.watchPosition(
    pos => updateUserLocation(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy),
    err => {
      $("#park-status").textContent = "Permite ubicación para continuar";
      $("#park-status").className = "park-status out-zone";
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
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
      html: '<div style="background:#1976d2;border:3px solid white;border-radius:50%;width:18px;height:18px;box-shadow:0 0 0 2px #1976d2;"></div>',
      iconSize: [18, 18], iconAnchor: [9, 9], className: "",
    })
  }).addTo(map);

  const ps = $("#park-status");
  const accWarn = (accuracy && accuracy > 100) ? ` <small style="opacity:0.7">(precisión ±${Math.round(accuracy)}m)</small>` : "";
  if (nearest && nearest.distance <= nearest.park.radius) {
    ps.innerHTML = `✓ Estás en ${nearest.name}${accWarn}`;
    ps.className = "park-status in-zone";
    $("#display-status-park").textContent = nearest.name;
  } else if (nearest) {
    ps.innerHTML = `Estás a ${Math.round(nearest.distance)}m de ${nearest.name}.${accWarn}`;
    ps.className = "park-status out-zone";
    $("#display-status-park").textContent = `${Math.round(nearest.distance)}m de ${nearest.name}`;
  } else {
    ps.textContent = "Sin puntos configurados";
    ps.className = "park-status";
  }
}

// ── Active shift tracking + live timer ──────────────────────────────────────
async function refreshActiveTurno() {
  try {
    const { data, error } = await sb.from("turnos")
      .select("*").eq("empleado_id", me.empleadoId).is("salida_at", null)
      .order("entrada_at", { ascending: false }).limit(1).maybeSingle();
    if (error) throw error;
    activeTurno = data;
    renderShift();
    if (activeTurno) startTimer();
    else stopTimer();
  } catch (e) {
    toast("Error: " + (e.message || e), "error");
  }
}

function renderShift() {
  const card = $("#status-card");
  const icon = $("#status-icon");
  const text = $("#status-text");
  const times = $("#status-times");
  const actions = $("#actions");
  const timerEl = $("#live-timer");

  times.innerHTML = "";
  actions.innerHTML = "";

  if (!activeTurno) {
    icon.textContent = "⏸";
    text.textContent = "Sin turno activo";
    timerEl.textContent = "00:00:00";
    timerEl.style.display = "none";
    addActionButton(actions, "start_shift", "▶ Iniciar turno", "btn-primary");
    return;
  }

  const onBreak = activeTurno.ini_descanso_at && !activeTurno.fin_descanso_at;
  icon.textContent = onBreak ? "🍴" : "🟢";
  text.textContent = (onBreak ? "En descanso" : "Trabajando") + ` · ${activeTurno.punto}`;
  timerEl.style.display = "block";

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

  if (onBreak) {
    addActionButton(actions, "end_lunch", "↩ Volver al trabajo", "btn-primary");
  } else {
    addActionButton(actions, "start_lunch", "🍴 Iniciar descanso", "btn-secondary");
    addActionButton(actions, "end_shift", "⏹ Cerrar turno", "btn-danger");
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
  if (!currentGPS) { toast("Esperando ubicación... permite GPS", "error"); return; }
  if (!nearestPark || nearestPark.distance > nearestPark.park.radius) {
    const dist = nearestPark ? Math.round(nearestPark.distance) : "?";
    const name = nearestPark ? nearestPark.name : "?";
    toast(`Acércate a ${name}. Estás a ${dist}m.`, "error");
    return;
  }
  if (currentGPS.accuracy && currentGPS.accuracy > 200) {
    if (!confirm(`Tu GPS tiene baja precisión (±${Math.round(currentGPS.accuracy)}m). ¿Continuar?`)) return;
  }
  pendingAction = action;
  $("#photo-input").value = "";
  $("#photo-input").click();
}

$("#photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!currentGPS || !nearestPark) { toast("GPS perdido", "error"); return; }
  if (!pendingAction) return;

  showOverlay("Comprimiendo foto...");
  try {
    const blob = await compressImageToBlob(file);
    if (!blob) throw new Error("Error al comprimir foto");
    showOverlay("Subiendo foto...");
    const photoPath = await uploadPhoto(blob, pendingAction);
    showOverlay("Registrando...");
    const result = await callRPC(pendingAction, photoPath, currentGPS, nearestPark.name);
    toast(result.message, "success");
    await refreshActiveTurno();
  } catch (err) {
    toast(err.message || String(err), "error");
  } finally {
    hideOverlay();
    pendingAction = null;
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
      .gte("entrada_at", sinceDate + "T00:00:00")
      .order("entrada_at", { ascending: false });
    if (error) throw error;

    // Carga también solicitudes correcciones del usuario
    const { data: corr } = await sb.from("correction_requests")
      .select("id, fecha, tipo, status, motivo, admin_note, created_at")
      .eq("empleado_id", me.empleadoId)
      .order("created_at", { ascending: false }).limit(20);

    renderMisHoras(data || [], corr || []);
  } catch (e) {
    toast(e.message, "error");
  } finally {
    hideOverlay();
  }
}

function renderMisHoras(turnos, corrections) {
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
  if (!turnos.length) {
    list.innerHTML = "<div class='park-status' style='margin:0;'>No hay registros aún</div>";
  } else {
    turnos.forEach(r => {
      const div = document.createElement("div");
      div.className = "history-row";
      const date = fmtDateLocal(r.entrada_at);
      const inT = fmtTimeShort(r.entrada_at);
      const outT = r.salida_at ? fmtTimeShort(r.salida_at) : "abierto";
      const hrs = r.horas_trab_secs ? fmtSecsHM(r.horas_trab_secs) : (r.salida_at ? "—" : "en curso");
      const corrFlag = r.source === "manual_correction" ? " <span class='badge' style='background:var(--jet-warn);color:#5a3e00;font-size:9px;'>EDITADO</span>" : "";
      div.innerHTML = `
        <div>
          <div class="date">${date}${corrFlag}</div>
          <span class="punto">${r.punto || "—"} · ${inT} → ${outT}</span>
        </div>
        <div class="hours">${hrs}</div>`;
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
