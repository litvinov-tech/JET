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
let me = null;       // { auth_user_id, nombre, email, activo, isAdmin }
let pendingAction = null;
let currentGPS = null;
let nearestPark = null;
let map = null;
let userMarker = null;
let parkMarkers = {};

window.JET = { sb, $, $$, CFG, getMe: () => me };

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

// ── Date / time helpers ─────────────────────────────────────────────────────
function todayStr() { return new Date().toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE }); }
function nowTime()  { return new Date().toLocaleTimeString("en-GB", { timeZone: CFG.TIMEZONE, hour12: false }); }
function dateOffset(days) { const d = new Date(); d.setDate(d.getDate() - days); return d.toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE }); }
function getMondayDate(weeksAgo) {
  const d = new Date();
  const day = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - day - 7 * (weeksAgo || 0));
  return d.toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
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
    // 1) Crear auth user
    const { data: authData, error: authErr } = await sb.auth.signUp({
      email, password,
      options: { data: { nombre } },
    });
    if (authErr) throw authErr;
    if (!authData.user) throw new Error("No se pudo crear el usuario");

    // 2) Si email confirmation está activado, no hay sesión todavía → pedir login después
    let session = authData.session;
    if (!session) {
      // Hacer login explícitamente
      const { data: signIn, error: signInErr } = await sb.auth.signInWithPassword({ email, password });
      if (signInErr) throw new Error("Cuenta creada pero login falló: " + signInErr.message);
      session = signIn.session;
    }

    // 3) Insertar empleado record
    const { error: empErr } = await sb.from("empleados").insert({
      auth_user_id: authData.user.id,
      nombre, email, telefono: tel,
    });
    if (empErr) {
      if (empErr.code === "23505") throw new Error("Ya existe una cuenta con ese correo o nombre");
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

  // Check admin
  let isAdmin = false;
  try {
    const { data: a } = await sb.from("admins").select("email").eq("email", email).maybeSingle();
    isAdmin = !!a;
  } catch {}

  // Load empleado record (optional — admin может не быть empleado)
  let emp = null;
  try {
    const { data: e } = await sb.from("empleados").select("*").eq("auth_user_id", userId).maybeSingle();
    emp = e;
  } catch {}

  me = {
    auth_user_id: userId,
    email,
    nombre: emp ? emp.nombre : null,
    activo: emp ? emp.activo : false,
    isAdmin,
    empleadoId: emp ? emp.id : null,
  };

  showTabs();

  if (me.isAdmin && !emp) {
    // Чистый админ без employee-записи — сразу в админку
    switchTab("admin");
    return;
  }

  if (!emp) {
    // Залогинен но нет empleado — странное состояние, отправляем на регистрацию
    toast("No hay datos de empleado. Completa el registro.", "error");
    showView("#view-register");
    return;
  }

  if (!me.activo) {
    showPending();
    return;
  }

  switchTab("empleado");
}

// ── Pending view ────────────────────────────────────────────────────────────
function showPending() {
  showView("#view-pending");
  $("#pending-name").textContent = me.nombre || me.email;
}

// ── Logout ──────────────────────────────────────────────────────────────────
async function logoutAll() {
  await sb.auth.signOut();
  me = null;
  hideTabs();
  showView("#view-login");
  $("#login-email").value = "";
  $("#login-password").value = "";
}

// ── Tab handlers ────────────────────────────────────────────────────────────
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
});

// ── Main view ───────────────────────────────────────────────────────────────
async function enterMain() {
  if (!me || !me.activo) { showPending(); return; }
  $("#display-empleado").textContent = me.nombre;
  $("#display-status-park").textContent = "Esperando GPS…";
  showView("#view-main");
  initMap();
  startGPSWatch();
  await refreshStatus();
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
    pos => updateUserLocation(pos.coords.latitude, pos.coords.longitude),
    err => {
      $("#park-status").textContent = "Permite ubicación para continuar";
      $("#park-status").className = "park-status out-zone";
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 15000 }
  );
}

function updateUserLocation(lat, lng) {
  currentGPS = { lat, lng };
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
  if (nearest && nearest.distance <= nearest.park.radius) {
    ps.textContent = `✓ Estás en ${nearest.name}`;
    ps.className = "park-status in-zone";
    $("#display-status-park").textContent = nearest.name;
  } else if (nearest) {
    ps.textContent = `Estás a ${Math.round(nearest.distance)}m de ${nearest.name}. Acércate al punto.`;
    ps.className = "park-status out-zone";
    $("#display-status-park").textContent = `${Math.round(nearest.distance)}m de ${nearest.name}`;
  } else {
    ps.textContent = "Sin puntos configurados";
    ps.className = "park-status";
  }
}

async function refreshStatus() {
  try {
    const { data, error } = await sb.from("turnos")
      .select("*").eq("empleado", me.nombre).eq("fecha", todayStr()).maybeSingle();
    if (error) throw error;
    renderStatus(buildStatus(data), data);
  } catch (e) {
    toast("Error: " + (e.message || e), "error");
  }
}

function buildStatus(row) {
  if (!row) return { state: "idle" };
  const out = {
    entrada: row.entrada || "", ini_descanso: row.ini_descanso || "",
    fin_descanso: row.fin_descanso || "", salida: row.salida || "",
  };
  if (out.salida) out.state = "closed";
  else if (out.ini_descanso && !out.fin_descanso) out.state = "on_break";
  else if (out.entrada) out.state = "working";
  else out.state = "idle";
  return out;
}

function renderStatus(r, row) {
  const STATES = {
    idle: { icon: "⏸", text: "Sin turno activo hoy" },
    working: { icon: "🟢", text: "Trabajando" },
    on_break: { icon: "🍴", text: "En descanso" },
    closed: { icon: "✅", text: "Turno cerrado" },
  };
  const cur = STATES[r.state] || STATES.idle;
  $("#status-icon").textContent = cur.icon;
  $("#status-text").textContent = cur.text + (row && row.punto ? ` · ${row.punto}` : "");

  const times = $("#status-times");
  times.innerHTML = "";
  [["Entrada", r.entrada], ["Inicio descanso", r.ini_descanso],
   ["Fin descanso", r.fin_descanso], ["Salida", r.salida]
  ].forEach(([label, val]) => {
    if (val) {
      const div = document.createElement("div");
      div.className = "row";
      div.innerHTML = `<span>${label}</span><span>${val}</span>`;
      times.appendChild(div);
    }
  });

  const actions = $("#actions");
  actions.innerHTML = "";
  const buttons = {
    idle:    [["start_shift", "▶ Iniciar turno", "btn-primary"]],
    working: [
      ["start_lunch", "🍴 Iniciar descanso", "btn-secondary"],
      ["end_shift",   "⏹ Cerrar turno",      "btn-danger"],
    ],
    on_break:[["end_lunch", "↩ Volver al trabajo", "btn-primary"]],
    closed:  [],
  };
  (buttons[r.state] || []).forEach(([action, label, klass]) => {
    const b = document.createElement("button");
    b.className = "btn " + klass;
    b.textContent = label;
    b.onclick = () => triggerAction(action);
    actions.appendChild(b);
  });
}

// ── Action: GPS check → camera → upload → DB ────────────────────────────────
function triggerAction(action) {
  if (!currentGPS) { toast("Esperando ubicación... permite GPS", "error"); return; }
  if (!nearestPark || nearestPark.distance > nearestPark.park.radius) {
    const dist = nearestPark ? Math.round(nearestPark.distance) : "?";
    const name = nearestPark ? nearestPark.name : "?";
    toast(`No estás en ningún punto. ${dist}m de ${name}`, "error");
    return;
  }
  pendingAction = action;
  $("#photo-input").value = "";
  $("#photo-input").click();
}

$("#photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!currentGPS || !nearestPark) { toast("GPS perdido", "error"); return; }

  showOverlay("Comprimiendo foto...");
  try {
    const blob = await compressImageToBlob(file);
    showOverlay("Subiendo foto...");
    const photoUrl = await uploadPhoto(blob, pendingAction);
    showOverlay("Registrando...");
    const result = await commitEvent(pendingAction, photoUrl, currentGPS, nearestPark.name);
    toast(result.message, "success");
    await refreshStatus();
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
  const path = `${todayStr()}/${safeName}_${action}_${stamp}.jpg`;
  const { error } = await sb.storage.from("fotos").upload(path, blob, {
    contentType: "image/jpeg", upsert: false,
  });
  if (error) throw new Error("Error subiendo foto: " + error.message);
  const { data } = sb.storage.from("fotos").getPublicUrl(path);
  return data.publicUrl;
}

async function commitEvent(action, photoUrl, coords, parkName) {
  const time = nowTime();
  const fecha = todayStr();
  const gps = coords.lat.toFixed(5) + "," + coords.lng.toFixed(5);

  const { data: existing, error: e0 } = await sb.from("turnos")
    .select("*").eq("empleado", me.nombre).eq("fecha", fecha).maybeSingle();
  if (e0) throw new Error(e0.message);

  if (action === "start_shift") {
    if (existing) throw new Error("Ya iniciaste turno hoy");
    const { error } = await sb.from("turnos").insert({
      empleado: me.nombre, fecha, punto: parkName,
      entrada: time, foto_entrada: photoUrl, gps_entrada: gps,
    });
    if (error) throw new Error(error.message);
    return { message: "Turno iniciado a las " + time };
  }
  if (!existing) throw new Error("Inicia turno primero");

  if (action === "start_lunch") {
    if (existing.ini_descanso) throw new Error("Descanso ya iniciado");
    const { error } = await sb.from("turnos").update({
      ini_descanso: time, foto_ini_desc: photoUrl,
    }).eq("id", existing.id);
    if (error) throw new Error(error.message);
    return { message: "Descanso a las " + time };
  }
  if (action === "end_lunch") {
    if (!existing.ini_descanso) throw new Error("No iniciaste descanso");
    if (existing.fin_descanso) throw new Error("Descanso ya cerrado");
    const { error } = await sb.from("turnos").update({
      fin_descanso: time, foto_fin_desc: photoUrl,
    }).eq("id", existing.id);
    if (error) throw new Error(error.message);
    return { message: "De vuelta al trabajo, " + time };
  }
  if (action === "end_shift") {
    if (existing.salida) throw new Error("Turno ya cerrado");
    const horas = computeHoras(existing.entrada, existing.ini_descanso, existing.fin_descanso, time);
    const { error } = await sb.from("turnos").update({
      salida: time, foto_salida: photoUrl, gps_salida: gps,
      horas_comida: horas.comida, horas_trab: horas.trabajadas,
    }).eq("id", existing.id);
    if (error) throw new Error(error.message);
    return { message: `Turno cerrado, ${time}. Trabajaste ${horas.trabajadas}` };
  }
  throw new Error("Acción desconocida");
}

// ── Mis horas view ──────────────────────────────────────────────────────────
async function loadMisHoras() {
  showView("#view-mishoras");
  showOverlay("Cargando historial...");
  try {
    const since = dateOffset(14);
    const { data, error } = await sb.from("turnos")
      .select("fecha, punto, entrada, salida, horas_comida, horas_trab")
      .eq("empleado", me.nombre).gte("fecha", since).order("fecha", { ascending: false });
    if (error) throw error;
    renderMisHoras(data || []);
  } catch (e) {
    toast(e.message, "error");
  } finally {
    hideOverlay();
  }
}

function renderMisHoras(rows) {
  const monday = getMondayDate(0);
  const monday1 = getMondayDate(1);
  let secWeek = 0, secWeekPrev = 0, sec14 = 0;
  rows.forEach(r => {
    const sec = parseHHMM(r.horas_trab);
    sec14 += sec;
    if (r.fecha >= monday) secWeek += sec;
    else if (r.fecha >= monday1) secWeekPrev += sec;
  });
  $("#hrs-week").textContent      = fmtHHMM(secWeek);
  $("#hrs-week-prev").textContent = fmtHHMM(secWeekPrev);
  $("#hrs-14d").textContent       = fmtHHMM(sec14);

  const list = $("#history-list");
  list.innerHTML = "";
  if (!rows.length) {
    list.innerHTML = "<div class='park-status' style='margin:0;'>No hay registros aún</div>";
    return;
  }
  rows.forEach(r => {
    const div = document.createElement("div");
    div.className = "history-row";
    const partial = !r.horas_trab;
    div.innerHTML = `
      <div>
        <div class="date">${r.fecha}</div>
        <span class="punto">${r.punto || "—"}</span>
      </div>
      <div class="hours ${partial ? 'partial' : ''}">
        ${r.horas_trab || (r.entrada ? `desde ${r.entrada}` : "—")}
      </div>`;
    list.appendChild(div);
  });
}

// ── Time math ──────────────────────────────────────────────────────────────
function parseHHMM(s) {
  if (!s) return 0;
  const p = String(s).split(":").map(Number);
  return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
}
function fmtHHMM(secs) {
  if (secs <= 0) return "00:00";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
}
function computeHoras(entrada, iniDesc, finDesc, salida) {
  const total = parseHHMM(salida) - parseHHMM(entrada);
  let comida = 0;
  if (iniDesc && finDesc) comida = parseHHMM(finDesc) - parseHHMM(iniDesc);
  return { comida: fmtHHMM(comida), trabajadas: fmtHHMM(total - comida) };
}

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
        canvas.toBlob(b => b ? resolve(b) : reject(new Error("Error comprimiendo")), "image/jpeg", quality);
      };
      img.onerror = () => reject(new Error("No se pudo leer la imagen"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("Error leyendo archivo"));
    reader.readAsDataURL(file);
  });
}

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Init ────────────────────────────────────────────────────────────────────
(async function init() {
  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes("PEGAR")) {
    toast("Falta configurar SUPABASE_URL en js/config.js", "error");
    return;
  }
  await loadMe();
})();

// Reload UI when auth state changes (login from another tab, etc.)
sb.auth.onAuthStateChange((event, sessionObj) => {
  if (event === "SIGNED_OUT") {
    me = null;
    hideTabs();
    showView("#view-login");
  }
});
