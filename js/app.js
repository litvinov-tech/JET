"use strict";

// ── Supabase client ─────────────────────────────────────────────────────────
const sb = window.supabase.createClient(
  window.JET_CONFIG.SUPABASE_URL,
  window.JET_CONFIG.SUPABASE_KEY
);
const CFG = window.JET_CONFIG;
const LS_KEY = "jet_user_v3";

const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

// ── State ───────────────────────────────────────────────────────────────────
let session = null;       // { id, nombre }
let pendingAction = null;
let currentGPS = null;    // {lat, lng}
let nearestPark = null;   // {name, distance}
let map = null;
let userMarker = null;
let parkMarkers = {};

// ── UI helpers ──────────────────────────────────────────────────────────────
function showView(id) {
  $$(".view").forEach(v => v.classList.remove("active"));
  $(id).classList.add("active");
  // Re-render Leaflet when entering main (size fix after hidden)
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
function dateOffset(days) {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
}
function getMondayDate(weeksAgo) {
  const d = new Date();
  const day = (d.getDay() + 6) % 7; // Mon=0...Sun=6
  d.setDate(d.getDate() - day - 7 * (weeksAgo || 0));
  return d.toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
}

// ── Login: load empleados from DB ───────────────────────────────────────────
async function loadEmpleados() {
  const sel = $("#select-empleado");
  sel.innerHTML = "<option value=''>— Cargando... —</option>";
  const { data, error } = await sb.from("empleados").select("id, nombre").eq("activo", true).order("nombre");
  if (error) { toast("Error: " + error.message, "error"); return; }
  sel.innerHTML = "<option value=''>— Selecciona —</option>";
  data.forEach(e => {
    const o = document.createElement("option");
    o.value = JSON.stringify({ id: e.id, nombre: e.nombre });
    o.textContent = e.nombre;
    sel.appendChild(o);
  });
}

function saveSession(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }
function loadSession() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; }
}
function clearSession() { localStorage.removeItem(LS_KEY); }

$("#btn-continuar").addEventListener("click", () => {
  const v = $("#select-empleado").value;
  if (!v) { toast("Selecciona tu nombre", "error"); return; }
  session = JSON.parse(v);
  saveSession(session);
  enterMain();
});

$("#btn-go-register").addEventListener("click", () => {
  showView("#view-register");
});

$("#btn-back-login").addEventListener("click", () => {
  showView("#view-login");
});

$("#btn-register").addEventListener("click", async () => {
  const nombre = $("#reg-nombre").value.trim();
  const tel = $("#reg-telefono").value.trim() || null;
  if (!nombre || nombre.length < 3) { toast("Ingresa tu nombre completo", "error"); return; }
  showOverlay("Registrando...");
  try {
    const { data, error } = await sb.from("empleados").insert({ nombre, telefono: tel }).select("id, nombre").single();
    if (error) {
      if (error.code === "23505") throw new Error("Ya existe un empleado con ese nombre");
      throw error;
    }
    session = { id: data.id, nombre: data.nombre };
    saveSession(session);
    toast("¡Bienvenido " + nombre + "!", "success");
    await enterMain();
  } catch (e) {
    toast(e.message || String(e), "error");
  } finally {
    hideOverlay();
  }
});

$("#btn-logout").addEventListener("click", () => {
  clearSession();
  session = null;
  showView("#view-login");
  loadEmpleados();
});

// ── Main view ───────────────────────────────────────────────────────────────
async function enterMain() {
  $("#display-empleado").textContent = session.nombre;
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
  // Add park circles
  Object.entries(CFG.PARQUES).forEach(([name, p]) => {
    const circle = L.circle([p.lat, p.lng], {
      radius: p.radius,
      color: "#0057b8",
      fillColor: "#2196f3",
      fillOpacity: 0.20,
      weight: 2,
    }).addTo(map);
    circle.bindTooltip(name, { permanent: false });
    parkMarkers[name] = circle;
  });
  // Fit bounds to all parks
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
  // Find nearest park
  let nearest = null, minDist = Infinity;
  Object.entries(CFG.PARQUES).forEach(([name, p]) => {
    const d = haversine(lat, lng, p.lat, p.lng);
    if (d < minDist) { minDist = d; nearest = { name, distance: d, park: p }; }
  });
  nearestPark = nearest;

  // Update user marker
  if (userMarker) userMarker.remove();
  userMarker = L.marker([lat, lng], {
    icon: L.divIcon({
      html: '<div style="background:#1976d2;border:3px solid white;border-radius:50%;width:18px;height:18px;box-shadow:0 0 0 2px #1976d2;"></div>',
      iconSize: [18, 18],
      iconAnchor: [9, 9],
      className: "",
    })
  }).addTo(map);

  // Update status
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
    const { data, error } = await sb
      .from("turnos")
      .select("*")
      .eq("empleado", session.nombre)
      .eq("fecha", todayStr())
      .maybeSingle();
    if (error) throw error;
    renderStatus(buildStatus(data), data);
  } catch (e) {
    toast("Error: " + (e.message || e), "error");
  }
}

function buildStatus(row) {
  if (!row) return { state: "idle" };
  const out = {
    entrada:      row.entrada || "",
    ini_descanso: row.ini_descanso || "",
    fin_descanso: row.fin_descanso || "",
    salida:       row.salida || "",
  };
  if (out.salida) out.state = "closed";
  else if (out.ini_descanso && !out.fin_descanso) out.state = "on_break";
  else if (out.entrada) out.state = "working";
  else out.state = "idle";
  return out;
}

function renderStatus(r, row) {
  const STATES = {
    idle:     { icon: "⏸", text: "Sin turno activo hoy" },
    working:  { icon: "🟢", text: "Trabajando" },
    on_break: { icon: "🍴", text: "En descanso" },
    closed:   { icon: "✅", text: "Turno cerrado" },
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
  if (!currentGPS) {
    toast("Esperando ubicación... permite GPS", "error");
    return;
  }
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
  const safeName = session.nombre.replace(/[^a-zA-Z0-9_-]/g, "_");
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
    .select("*").eq("empleado", session.nombre).eq("fecha", fecha).maybeSingle();
  if (e0) throw new Error(e0.message);

  if (action === "start_shift") {
    if (existing) throw new Error("Ya iniciaste turno hoy");
    const { error } = await sb.from("turnos").insert({
      empleado: session.nombre, fecha, punto: parkName,
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
$("#btn-mis-horas").addEventListener("click", () => loadMisHoras());
$("#btn-back-main").addEventListener("click", () => showView("#view-main"));

async function loadMisHoras() {
  showView("#view-mishoras");
  showOverlay("Cargando historial...");
  try {
    const since = dateOffset(14);
    const { data, error } = await sb.from("turnos")
      .select("fecha, punto, entrada, salida, horas_comida, horas_trab")
      .eq("empleado", session.nombre)
      .gte("fecha", since)
      .order("fecha", { ascending: false });
    if (error) throw error;
    renderMisHoras(data || []);
  } catch (e) {
    toast(e.message, "error");
  } finally {
    hideOverlay();
  }
}

function renderMisHoras(rows) {
  // Compute totals per week
  const monday  = getMondayDate(0);
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
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── Init ────────────────────────────────────────────────────────────────────
(async function init() {
  if (!CFG.SUPABASE_URL || CFG.SUPABASE_URL.includes("PEGAR")) {
    toast("Falta configurar SUPABASE_URL en js/config.js", "error");
    return;
  }
  await loadEmpleados();
  const saved = loadSession();
  if (saved && saved.id && saved.nombre) {
    session = saved;
    await enterMain();
  } else {
    showView("#view-login");
  }
})();
