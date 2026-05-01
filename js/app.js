"use strict";

// ── Supabase client ─────────────────────────────────────────────────────────
const sb = window.supabase.createClient(
  window.JET_CONFIG.SUPABASE_URL,
  window.JET_CONFIG.SUPABASE_KEY
);
const CFG = window.JET_CONFIG;
const LS_KEY = "jet_user_v2";

const $ = sel => document.querySelector(sel);

// ── State ───────────────────────────────────────────────────────────────────
let session = null;       // { empleado, parque }
let pendingAction = null;

// ── UI helpers ──────────────────────────────────────────────────────────────
function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  $(id).classList.add("active");
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

// ── Date / time helpers (timezone-aware) ────────────────────────────────────
function todayStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
}
function nowTime() {
  return new Date().toLocaleTimeString("en-GB", { timeZone: CFG.TIMEZONE, hour12: false });
}

// ── Login flow ──────────────────────────────────────────────────────────────
function loadConfigUI() {
  const sel1 = $("#select-empleado");
  CFG.EMPLEADOS.forEach(n => {
    const o = document.createElement("option");
    o.value = n; o.textContent = n;
    sel1.appendChild(o);
  });
  const sel2 = $("#select-parque");
  Object.keys(CFG.PARQUES).forEach(p => {
    const o = document.createElement("option");
    o.value = p; o.textContent = p;
    sel2.appendChild(o);
  });
}

function saveSession(s) { localStorage.setItem(LS_KEY, JSON.stringify(s)); }
function loadSession() {
  try { return JSON.parse(localStorage.getItem(LS_KEY)); } catch { return null; }
}
function clearSession() { localStorage.removeItem(LS_KEY); }

$("#btn-continuar").addEventListener("click", () => {
  const empleado = $("#select-empleado").value;
  const parque = $("#select-parque").value;
  if (!empleado || !parque) { toast("Selecciona nombre y punto", "error"); return; }
  session = { empleado, parque };
  saveSession(session);
  enterMain();
});

$("#btn-logout").addEventListener("click", () => {
  clearSession();
  session = null;
  showView("#view-login");
});

// ── Main view ───────────────────────────────────────────────────────────────
async function enterMain() {
  $("#display-empleado").textContent = session.empleado;
  $("#display-parque").textContent = session.parque;
  showView("#view-main");
  await refreshStatus();
}

async function refreshStatus() {
  showOverlay("Cargando estado...");
  try {
    const { data, error } = await sb
      .from("turnos")
      .select("*")
      .eq("empleado", session.empleado)
      .eq("fecha", todayStr())
      .maybeSingle();
    if (error) throw error;
    renderStatus(buildStatus(data));
  } catch (e) {
    toast("Error: " + (e.message || e), "error");
  } finally {
    hideOverlay();
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

function renderStatus(r) {
  const STATES = {
    idle:     { icon: "⏸", text: "Sin turno activo hoy" },
    working:  { icon: "🟢", text: "Trabajando" },
    on_break: { icon: "🍴", text: "En descanso" },
    closed:   { icon: "✅", text: "Turno cerrado" },
  };
  const cur = STATES[r.state] || STATES.idle;
  $("#status-icon").textContent = cur.icon;
  $("#status-text").textContent = cur.text;

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

  $("#info-line").textContent = r.state === "closed"
    ? "Buen trabajo! Vuelve mañana."
    : "Cada acción registra ubicación y foto.";
}

// ── Action: GPS → camera → upload → DB ──────────────────────────────────────
function triggerAction(action) {
  pendingAction = action;
  $("#photo-input").value = "";
  $("#photo-input").click();
}

$("#photo-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  showOverlay("Obteniendo ubicación...");
  try {
    const coords = await getGPS();
    const park = CFG.PARQUES[session.parque];
    const dist = haversine(coords.lat, coords.lng, park.lat, park.lng);
    if (dist > park.radius) {
      throw new Error(`Estás a ${Math.round(dist)}m de ${session.parque}. Debes estar a menos de ${park.radius}m.`);
    }
    showOverlay("Comprimiendo foto...");
    const blob = await compressImageToBlob(file);
    showOverlay("Subiendo foto...");
    const photoUrl = await uploadPhoto(blob, pendingAction);
    showOverlay("Registrando...");
    const result = await commitEvent(pendingAction, photoUrl, coords);
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
  const safeName = session.empleado.replace(/[^a-zA-Z0-9_-]/g, "_");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${todayStr()}/${safeName}_${action}_${stamp}.jpg`;
  const { error } = await sb.storage.from("fotos").upload(path, blob, {
    contentType: "image/jpeg",
    upsert: false,
  });
  if (error) throw new Error("Error subiendo foto: " + error.message);
  const { data } = sb.storage.from("fotos").getPublicUrl(path);
  return data.publicUrl;
}

async function commitEvent(action, photoUrl, coords) {
  const time = nowTime();
  const fecha = todayStr();
  const gps = coords.lat.toFixed(5) + "," + coords.lng.toFixed(5);

  // Buscar si ya hay turno hoy
  const { data: existing, error: e0 } = await sb.from("turnos")
    .select("*")
    .eq("empleado", session.empleado)
    .eq("fecha", fecha)
    .maybeSingle();
  if (e0) throw new Error(e0.message);

  if (action === "start_shift") {
    if (existing) throw new Error("Ya iniciaste turno hoy");
    const { error } = await sb.from("turnos").insert({
      empleado: session.empleado,
      fecha, punto: session.parque,
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

// ── Time math ──────────────────────────────────────────────────────────────
function parseHHMM(s) {
  if (!s) return 0;
  const p = String(s).split(":").map(Number);
  return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
}
function fmtHHMM(secs) {
  if (secs < 0) secs = 0;
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

// ── GPS / camera helpers ────────────────────────────────────────────────────
function getGPS() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) { reject(new Error("GPS no disponible")); return; }
    navigator.geolocation.getCurrentPosition(
      pos => resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
      err => reject(new Error("Ubicación denegada o no disponible: " + err.message)),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  });
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
  loadConfigUI();
  const saved = loadSession();
  if (saved && saved.empleado && saved.parque) {
    session = saved;
    await enterMain();
  } else {
    showView("#view-login");
  }
})();
