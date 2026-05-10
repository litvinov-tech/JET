"use strict";
// JET Admin — full dashboard

(function () {
  const { sb, $, $$, CFG, getSignedUrl } = window.JET;

  // ── Date helpers ─────────────────────────────────────────────────────────
  function todayStr() { return new Date().toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE }); }
  function dateOffset(days) { const d = new Date(); d.setDate(d.getDate() - days); return d.toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE }); }
  function getMondayStr() {
    const d = new Date();
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
    return d.toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
  }
  function getMonthStartStr() {
    const d = new Date();
    d.setDate(1);
    return d.toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
  }
  function addDateStr(dateStr, days) {
    const d = new Date(dateStr + "T12:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }
  function tzOffsetMs(date) {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: CFG.TIMEZONE, hourCycle: "h23",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).formatToParts(date).reduce((a, p) => { a[p.type] = p.value; return a; }, {});
    const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    return asUtc - date.getTime();
  }
  function zonedTimeToUtcIso(dateStr, timeStr) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const [hh, mm, ss = 0] = timeStr.split(":").map(Number);
    const wallAsUtc = Date.UTC(y, m - 1, d, hh, mm, ss);
    let utc = new Date(wallAsUtc - tzOffsetMs(new Date(wallAsUtc)));
    utc = new Date(wallAsUtc - tzOffsetMs(utc));
    return utc.toISOString();
  }
  function dayBoundsUtc(dateStr) {
    return {
      from: zonedTimeToUtcIso(dateStr, "00:00:00"),
      to: zonedTimeToUtcIso(addDateStr(dateStr, 1), "00:00:00"),
    };
  }
  function fmtH(secs) {
    if (!secs || secs < 0) return "0h 00m";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h + "h " + (m < 10 ? "0" : "") + m + "m";
  }
  function computeWorkSecs(r) {
    if (!r || !r.entrada_at || !r.salida_at) return null;
    const start = new Date(r.entrada_at).getTime();
    const end = new Date(r.salida_at).getTime();
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
    let workSecs = Math.round((end - start) / 1000);
    if (r.ini_descanso_at && r.fin_descanso_at) {
      const lunchStart = new Date(r.ini_descanso_at).getTime();
      const lunchEnd = new Date(r.fin_descanso_at).getTime();
      if (Number.isFinite(lunchStart) && Number.isFinite(lunchEnd) && lunchEnd >= lunchStart) {
        workSecs -= Math.round((lunchEnd - lunchStart) / 1000);
      }
    }
    return Math.max(0, workSecs);
  }
  function getTurnoWorkSecs(r) {
    if (!r?.salida_at) return 0;
    const computed = computeWorkSecs(r);
    const stored = Number(r?.horas_trab_secs);
    if (!Number.isFinite(stored) || stored < 0) return computed || 0;
    if (computed == null) return stored;
    if (stored > 16 * 3600) return computed;
    if (Math.abs(stored - computed) > 5 * 60) return computed;
    return stored;
  }
  function getTurnoLiveSecs(r) {
    if (!r?.entrada_at) return 0;
    if (r.salida_at) return getTurnoWorkSecs(r);
    const start = new Date(r.entrada_at).getTime();
    const end = Date.now();
    if (!Number.isFinite(start) || end < start) return 0;
    let workSecs = Math.round((end - start) / 1000);
    if (r.ini_descanso_at) {
      const lunchStart = new Date(r.ini_descanso_at).getTime();
      const lunchEnd = r.fin_descanso_at ? new Date(r.fin_descanso_at).getTime() : end;
      if (Number.isFinite(lunchStart) && Number.isFinite(lunchEnd) && lunchEnd >= lunchStart) {
        workSecs -= Math.round((lunchEnd - lunchStart) / 1000);
      }
    }
    return Math.max(0, workSecs);
  }
  function shouldRepairTurno(r) {
    const computed = computeWorkSecs(r);
    const stored = Number(r?.horas_trab_secs);
    if (computed == null) return false;
    if (!Number.isFinite(stored) || stored < 0) return true;
    return stored > 16 * 3600 || Math.abs(stored - computed) > 5 * 60;
  }
  async function repairTurnoHours(rows) {
    const candidates = (rows || []).filter(r => shouldRepairTurno(r));
    if (!candidates.length) return 0;
    let repaired = 0;
    for (const r of candidates) {
      const workSecs = computeWorkSecs(r);
      if (workSecs == null) continue;
      const lunchSecs = (r.ini_descanso_at && r.fin_descanso_at)
        ? Math.max(0, Math.round((new Date(r.fin_descanso_at).getTime() - new Date(r.ini_descanso_at).getTime()) / 1000))
        : 0;
      const patch = { horas_trab_secs: workSecs, horas_comida_secs: lunchSecs };
      const { error } = await sb.from("turnos").update(patch).eq("id", r.id);
      if (error) {
        console.warn("[JET] repairTurnoHours failed", r.id, error);
        continue;
      }
      r.horas_trab_secs = workSecs;
      r.horas_comida_secs = lunchSecs;
      repaired += 1;
    }
    return repaired;
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
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, m => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[m]));
  }

  function showOverlay(t) { $("#overlay-text").textContent = t || "Cargando..."; $("#overlay").classList.remove("hidden"); }
  function hideOverlay() { $("#overlay").classList.add("hidden"); }

  // ── State ────────────────────────────────────────────────────────────────
  let cache = {
    empleados: [], pending: [], turnosToday: [],
    periodTurnos: [], periodAssignments: [], periodCorrections: [], periodFrom: null, periodTo: null,
    correctionsPending: [],
    admins: [],
  };
  let empMap = {}; // empleado_id -> nombre
  let myEmail = null;
  let workManualLang = "es";

  // ── Period selection ─────────────────────────────────────────────────────
  function setPeriod(p) {
    $$(".period-tab").forEach(t => t.classList.toggle("active", t.dataset.period === p));
    const custom = $("#period-custom");
    if (p === "custom") { custom.style.display = "flex"; return; }
    custom.style.display = "none";
    let from, to = todayStr();
    if (p === "today") from = todayStr();
    else if (p === "week") from = getMondayStr();
    else if (p === "month") from = getMonthStartStr();
    else if (p === "all") from = "2020-01-01";
    cache.periodFrom = from; cache.periodTo = to;
    loadPeriod();
  }

  function applyCustomPeriod() {
    const from = $("#period-from").value;
    const to = $("#period-to").value;
    if (!from || !to) { alert("Selecciona ambas fechas"); return; }
    if (from > to) { alert("Fecha 'desde' debe ser anterior a 'hasta'"); return; }
    cache.periodFrom = from; cache.periodTo = to;
    loadPeriod();
  }

  // ── Main load ────────────────────────────────────────────────────────────
  async function load() {
    showOverlay();
    try {
      const today = todayStr();
      const todayBounds = dayBoundsUtc(today);
      myEmail = (await sb.auth.getUser()).data.user?.email || null;
      const [pendingRes, activeRes, todayRes, corrRes, adminsRes] = await Promise.all([
        sb.from("empleados").select("id, nombre, email, telefono, created_at").eq("activo", false).order("created_at", { ascending: false }),
        sb.from("empleados").select("id, nombre, email, telefono, puesto").eq("activo", true).order("nombre"),
        sb.from("turnos").select("*").is("deleted_at", null).gte("entrada_at", todayBounds.from).lt("entrada_at", todayBounds.to).order("entrada_at", { ascending: true }),
        sb.from("correction_requests").select("*").eq("status", "pending").order("created_at", { ascending: true }),
        sb.from("admins").select("email, super, created_at").order("created_at", { ascending: true }),
      ]);

      cache.pending = pendingRes.data || [];
      cache.empleados = activeRes.data || [];
      cache.turnosToday = todayRes.data || [];
      cache.correctionsPending = corrRes.data || [];
      cache.admins = adminsRes.data || [];

      empMap = {};
      cache.empleados.forEach(e => empMap[e.id] = e.nombre);
      // Also include pending for emp lookup (correction requests can come before approve)
      cache.pending.forEach(e => empMap[e.id] = e.nombre);

      renderKPIs();
      renderPending();
      renderCorrections();
      renderToday();
      renderActive();
      renderAdmins();
      renderLiveBoard();
      await loadHoursChart();

      if (!cache.periodFrom) { cache.periodFrom = today; cache.periodTo = today; }
      await loadPeriod();
    } catch (e) {
      alert("Error cargando admin: " + e.message);
    } finally {
      hideOverlay();
    }
  }

  // ── Live Working Board ───────────────────────────────────────────────────
  function renderLiveBoard() {
    const board = $("#live-board");
    if (!board) return;
    const open = cache.turnosToday.filter(t => !t.salida_at);
    $("#live-count").textContent = open.length;
    board.innerHTML = "";
    if (!open.length) {
      board.innerHTML = "<div class='live-empty'>Nadie está trabajando ahora</div>";
      return;
    }
    const empById = {};
    cache.empleados.forEach(e => empById[e.id] = e);
    open.forEach(t => {
      const emp = empById[t.empleado_id];
      const empName = (emp && emp.nombre) || empMap[t.empleado_id] || `(emp #${t.empleado_id})`;
      const roleBadge = emp ? renderRoleBadge(emp.puesto) : "";
      const initial = empName.trim().charAt(0).toUpperCase();
      const onBreak = t.ini_descanso_at && !t.fin_descanso_at;
      const startMs = new Date(t.entrada_at).getTime();
      const photoPath = t.foto_entrada;
      const card = document.createElement("div");
      card.className = "live-card" + (onBreak ? " on-break" : "");
      card.innerHTML = `
        <div class="live-card-photo" data-path="${escapeHtml(photoPath || "")}" data-caption="${escapeHtml(empName + " · entrada " + fmtTimeShort(t.entrada_at))}">${initial}</div>
        <div class="live-card-info">
          <div class="live-card-name">${escapeHtml(empName)}${roleBadge}</div>
          <div class="live-card-park">${escapeHtml(t.punto || "—")} · entrada ${fmtTimeShort(t.entrada_at)}</div>
          <div class="live-card-timer" data-start="${startMs}" data-break-start="${t.ini_descanso_at ? new Date(t.ini_descanso_at).getTime() : ""}" data-break-end="${t.fin_descanso_at ? new Date(t.fin_descanso_at).getTime() : ""}">—</div>
        </div>`;
      board.appendChild(card);
    });
    // Load thumbnails async (signed URLs)
    board.querySelectorAll(".live-card-photo[data-path]").forEach(async el => {
      const path = el.dataset.path;
      if (!path) return;
      const url = await getSignedUrl(path);
      if (url) {
        el.style.backgroundImage = `url("${url}")`;
        el.textContent = "";
        el.onclick = () => openPhotoLightbox(url, el.dataset.caption, path);
      }
    });
    tickLiveTimers();
  }

  let liveTimerHandle = null;
  function tickLiveTimers() {
    if (liveTimerHandle) clearInterval(liveTimerHandle);
    const update = () => {
      const now = Date.now();
      $$(".live-card-timer").forEach(el => {
        const start = +el.dataset.start;
        if (!start) return;
        const breakStart = el.dataset.breakStart ? +el.dataset.breakStart : null;
        const breakEnd = el.dataset.breakEnd ? +el.dataset.breakEnd : null;
        let totalSecs = Math.max(0, Math.floor((now - start) / 1000));
        let lunchSecs = 0;
        if (breakStart) {
          const end = breakEnd || now;
          lunchSecs = Math.max(0, Math.floor((end - breakStart) / 1000));
        }
        const workSecs = totalSecs - lunchSecs;
        const h = Math.floor(workSecs / 3600);
        const m = Math.floor((workSecs % 3600) / 60);
        const s = Math.floor(workSecs % 60);
        el.textContent = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
      });
      const kpiHours = $("#kpi-today-hours");
      if (kpiHours) kpiHours.textContent = fmtH(cache.turnosToday.reduce((s, t) => s + getTurnoLiveSecs(t), 0));
    };
    update();
    liveTimerHandle = setInterval(update, 1000);
  }

  // ── Hours chart (last 7 days) ────────────────────────────────────────────
  async function loadHoursChart() {
    const fromIso = dayBoundsUtc(dateOffset(6)).from;
    const toIso = dayBoundsUtc(todayStr()).to;
    try {
      const { data, error } = await sb.from("turnos")
        .select("entrada_at, ini_descanso_at, fin_descanso_at, salida_at, horas_trab_secs")
        .is("deleted_at", null)
        .gte("entrada_at", fromIso).lt("entrada_at", toIso);
      if (error) throw error;
      const byDay = {};
      for (let i = 6; i >= 0; i--) byDay[dateOffset(i)] = 0;
      (data || []).forEach(r => {
        const d = fmtDateLocal(r.entrada_at);
        if (d in byDay) byDay[d] += getTurnoLiveSecs(r);
      });
      renderHoursChart(byDay);
    } catch (e) {
      $("#hours-chart").innerHTML = "<div class='empty'>Error cargando gráfico</div>";
    }
  }

  function renderHoursChart(byDay) {
    const el = $("#hours-chart");
    if (!el) return;
    el.innerHTML = "";
    const dates = Object.keys(byDay);
    const maxSec = Math.max(...Object.values(byDay), 3600);
    const today = todayStr();
    dates.forEach(d => {
      const secs = byDay[d];
      const heightPct = Math.max(2, (secs / maxSec) * 100);
      const dt = new Date(d + "T12:00:00");
      const dow = dt.toLocaleDateString("es-MX", { weekday: "short" }).replace(".","");
      const isToday = d === today;
      const col = document.createElement("div");
      col.className = "chart-col";
      col.innerHTML = `
        <div class="chart-bar" style="height:${heightPct}%;${isToday ? '' : 'background:linear-gradient(180deg,#a8c7ff,#5a8eff);'}">
          ${secs > 0 ? `<span class="chart-bar-value">${fmtH(secs)}</span>` : ""}
        </div>
        <div class="chart-label${isToday ? ' is-today' : ''}">${dow}</div>`;
      el.appendChild(col);
    });
  }

  // ── Top employees ────────────────────────────────────────────────────────
  function renderTopEmployees(empAgg) {
    const el = $("#top-emp");
    if (!el) return;
    const sorted = Object.entries(empAgg)
      .map(([name, t]) => ({ name, secs: t.segs }))
      .filter(x => x.secs > 0)
      .sort((a, b) => b.secs - a.secs)
      .slice(0, 5);
    el.innerHTML = "";
    if (!sorted.length) {
      el.innerHTML = "<div class='empty'>Sin datos</div>";
      return;
    }
    const maxSec = sorted[0].secs;
    sorted.forEach((x, i) => {
      const pct = Math.max(5, (x.secs / maxSec) * 100);
      const rankClass = i === 0 ? "r1" : i === 1 ? "r2" : i === 2 ? "r3" : "";
      const row = document.createElement("div");
      row.className = "top-emp-row";
      row.innerHTML = `
        <div class="top-emp-rank ${rankClass}">${i + 1}</div>
        <div class="top-emp-name">${escapeHtml(x.name)}</div>
        <div class="top-emp-bar-wrap"><div class="top-emp-bar" style="width:${pct}%"></div></div>
        <div class="top-emp-hours">${fmtH(x.secs)}</div>`;
      el.appendChild(row);
    });
  }

  // ── Photo lightbox ───────────────────────────────────────────────────────
  let lightboxRetried = false;
  let lightboxPath = null;
  function openPhotoLightbox(url, caption, path) {
    const lb = $("#photo-lightbox");
    if (!lb) return;
    const img = $("#lightbox-img");
    img.src = url;
    $("#lightbox-caption").textContent = caption || "";
    lb.classList.remove("hidden");
    lightboxRetried = false;
    lightboxPath = path || null;
    img.onerror = async () => {
      if (lightboxRetried || !lightboxPath) return;
      lightboxRetried = true;
      // re-fetch fresh signed URL (cached one expired)
      const fresh = await getSignedUrl(lightboxPath);
      if (fresh) img.src = fresh;
    };
  }
  function closePhotoLightbox() {
    const lb = $("#photo-lightbox");
    if (!lb) return;
    lb.classList.add("hidden");
    $("#lightbox-img").src = "";
  }

  async function loadPeriod() {
    showOverlay("Cargando período...");
    try {
      const fromIso = dayBoundsUtc(cache.periodFrom).from;
      const toIso = dayBoundsUtc(cache.periodTo).to;
      const [turnos, assignments, corrections] = await Promise.all([
        fetchAllTurnos(fromIso, toIso),
        fetchAllAssignments(cache.periodFrom, cache.periodTo),
        fetchAllCorrections(cache.periodFrom, cache.periodTo),
      ]);
      const repaired = await repairTurnoHours(turnos);
      cache.periodTurnos = turnos;
      cache.periodAssignments = assignments;
      cache.periodCorrections = corrections;
      renderPeriod();
      if (repaired) console.info(`[JET] repaired ${repaired} turno(s) in period ${cache.periodFrom} → ${cache.periodTo}`);
    } catch (e) {
      alert("Error: " + e.message);
    } finally {
      hideOverlay();
    }
  }

  async function fetchAllTurnos(fromIso, toIso) {
    const pageSize = 1000;
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await sb.from("turnos")
        .select("*")
        .is("deleted_at", null)
        .gte("entrada_at", fromIso)
        .lt("entrada_at", toIso)
        .order("entrada_at", { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return rows;
  }

  async function fetchAllAssignments(fromDate, toDate) {
    const pageSize = 1000;
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await sb.from("shift_assignments")
        .select("*")
        .gte("fecha", fromDate)
        .lte("fecha", toDate)
        .order("fecha", { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return rows;
  }

  async function fetchAllCorrections(fromDate, toDate) {
    const pageSize = 1000;
    const rows = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await sb.from("correction_requests")
        .select("*")
        .gte("fecha", fromDate)
        .lte("fecha", toDate)
        .order("fecha", { ascending: false })
        .range(from, from + pageSize - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < pageSize) break;
    }
    return rows;
  }

  // ── Render: KPIs ─────────────────────────────────────────────────────────
  function renderKPIs() {
    const working = cache.turnosToday.filter(t => !t.salida_at).length;
    const totalSec = cache.turnosToday.reduce((s, t) => s + getTurnoLiveSecs(t), 0);
    $("#kpi-today-working").textContent = working;
    $("#kpi-today-hours").textContent = fmtH(totalSec);
    $("#kpi-active").textContent = cache.empleados.length;
    $("#kpi-pending").textContent = cache.pending.length + cache.correctionsPending.length;
  }

  // ── Render: Pending registrations ────────────────────────────────────────
  function renderPending() {
    const card = $("#admin-pending-card");
    $("#admin-pending-count").textContent = cache.pending.length;
    if (!cache.pending.length) { card.style.display = "none"; return; }
    card.style.display = "block";
    const list = $("#admin-pending-list");
    list.innerHTML = "";
    const tbl = document.createElement("table");
    tbl.className = "admin-table";
    tbl.innerHTML = "<thead><tr><th>Nombre</th><th>Email</th><th>Tel</th><th></th></tr></thead>";
    const tb = document.createElement("tbody");
    cache.pending.forEach(e => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escapeHtml(e.nombre)}</strong></td>
        <td style="font-size:11px;">${escapeHtml(e.email)}</td>
        <td>${escapeHtml(e.telefono || "—")}</td>
        <td style="text-align:right;white-space:nowrap;">
          <button class="approve-btn" data-id="${e.id}">✓</button>
          <button class="reject-btn" data-id="${e.id}">✕</button>
        </td>`;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    list.appendChild(tbl);
    list.querySelectorAll(".approve-btn").forEach(b => b.addEventListener("click", () => approveEmp(b.dataset.id)));
    list.querySelectorAll(".reject-btn").forEach(b => b.addEventListener("click", () => rejectEmp(b.dataset.id)));
  }

  // ── Render: Correction requests ──────────────────────────────────────────
  function renderCorrections() {
    const card = $("#admin-corrections-card");
    if (!card) return;
    const cnt = cache.correctionsPending.length;
    $("#admin-corrections-count").textContent = cnt;
    if (!cnt) { card.style.display = "none"; return; }
    card.style.display = "block";
    const list = $("#admin-corrections-list");
    list.innerHTML = "";
    const tipoMap = { forgot_start:"Olvidó entrada", forgot_end:"Olvidó salida", forgot_lunch:"Olvidó descanso", wrong_time:"Hora incorrecta", other:"Otro" };
    cache.correctionsPending.forEach(c => {
      const div = document.createElement("div");
      div.className = "correction-item";
      const empName = empMap[c.empleado_id] || `(emp #${c.empleado_id})`;
      const proposedTxt = c.proposed_time ? `<div style="font-size:12px;margin-top:4px;">Hora propuesta: <strong>${fmtTimeShort(c.proposed_time)}</strong></div>` : "";
      div.innerHTML = `
        <div class="correction-head">
          <strong>${escapeHtml(empName)}</strong>
          <span class="corr-type">${tipoMap[c.tipo] || c.tipo}</span>
        </div>
        <div class="correction-meta">${c.fecha} · ${escapeHtml(c.field_name || "")}</div>
        <div class="correction-motivo">${escapeHtml(c.motivo)}</div>
        ${proposedTxt}
        <div class="correction-actions">
          <button class="approve-btn" data-id="${c.id}">✓ Aprobar</button>
          <button class="reject-btn" data-id="${c.id}">✕ Rechazar</button>
        </div>`;
      list.appendChild(div);
    });
    list.querySelectorAll(".approve-btn").forEach(b => b.addEventListener("click", () => approveCorrection(b.dataset.id)));
    list.querySelectorAll(".reject-btn").forEach(b => b.addEventListener("click", () => rejectCorrection(b.dataset.id)));
  }

  // ── Render: Today details ────────────────────────────────────────────────
  function renderToday() {
    $("#admin-today-date").textContent = todayStr();
    const list = $("#admin-today-list");
    list.innerHTML = "";
    if (!cache.turnosToday.length) {
      list.innerHTML = "<div class='empty'>Aún nadie ha fichado hoy</div>";
      return;
    }
    const tbl = document.createElement("table");
    tbl.className = "admin-table";
    tbl.innerHTML = "<thead><tr><th>Empleado</th><th>Punto</th><th>Entrada</th><th>Salida</th><th>Horas</th><th>Fotos</th><th></th></tr></thead>";
    const tb = document.createElement("tbody");
    cache.turnosToday.forEach(r => {
      const empName = empMap[r.empleado_id] || `(#${r.empleado_id})`;
      const photosHtml = renderTurnoPhotoLinks(r, empName);
      const tr = document.createElement("tr");
      const delBtn = `<button class="btn-mini btn-mini-delete" data-action="del-turno" data-id="${r.id}" data-name="${escapeHtml(empName)}" data-time="${fmtTimeShort(r.entrada_at)}-${fmtTimeShort(r.salida_at) || "abierto"}" title="Eliminar turno">🗑</button>`;
      tr.innerHTML = `<td>${escapeHtml(empName)}</td><td>${escapeHtml(r.punto || "")}</td><td>${fmtTimeShort(r.entrada_at)}</td><td>${fmtTimeShort(r.salida_at)}</td><td>${fmtH(getTurnoLiveSecs(r))}${r.salida_at ? "" : " <span class='live-pill'>en vivo</span>"}</td><td>${photosHtml}</td><td>${delBtn}</td>`;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    list.appendChild(tbl);
    list.querySelectorAll('[data-action="del-turno"]').forEach(b =>
      b.addEventListener("click", () => promptDeleteTurno(b.dataset.id, b.dataset.name, b.dataset.time)));
  }

  function renderTurnoPhotoLinks(r, empName) {
    const photoSpec = [
      ["foto_entrada", "▶", "Entrada"],
      ["foto_ini_desc", "🍴", "Inicio descanso"],
      ["foto_fin_desc", "↩", "Fin descanso"],
      ["foto_salida", "⏹", "Salida"],
    ];
    const html = photoSpec
      .filter(([k]) => r[k])
      .map(([k, icon, label]) => {
        const caption = `${empName} · ${fmtDateLocal(r.entrada_at)} · ${label}`;
        return `<a class="photo-link" data-path="${escapeHtml(r[k])}" data-caption="${escapeHtml(caption)}" href="#" onclick="window.JETAdmin.openPhoto(this); return false;">${icon}</a>`;
      }).join(" ");
    return html || "<span class='muted'>—</span>";
  }

  // ── Render: Period summary ───────────────────────────────────────────────
  function renderPeriod() {
    const rows = cache.periodTurnos;
    let totalSec = 0, totalLunchSec = 0;
    const empAgg = {};
    const days = new Set();
    rows.forEach(r => {
      const sec = getTurnoLiveSecs(r);
      const lun = r.horas_comida_secs || 0;
      totalSec += sec;
      totalLunchSec += lun;
      days.add(fmtDateLocal(r.entrada_at));
      const empName = empMap[r.empleado_id] || `(emp #${r.empleado_id})`;
      if (!empAgg[empName]) empAgg[empName] = { dias: new Set(), segs: 0, segsLunch: 0, turnos: 0 };
      empAgg[empName].turnos += 1;
      empAgg[empName].dias.add(fmtDateLocal(r.entrada_at));
      empAgg[empName].segs += sec;
      empAgg[empName].segsLunch += lun;
    });

    const empCount = Object.keys(empAgg).length;
    $("#period-summary").innerHTML = `
      <div class="row"><span>Período</span><strong>${cache.periodFrom} → ${cache.periodTo}</strong></div>
      <div class="row"><span>Días con actividad</span><strong>${days.size}</strong></div>
      <div class="row"><span>Empleados</span><strong>${empCount}</strong></div>
      <div class="row"><span>Total turnos</span><strong>${rows.length}</strong></div>
      <div class="row"><span>Horas trabajadas</span><strong>${fmtH(totalSec)}</strong></div>
      <div class="row"><span>Horas comida</span><strong>${fmtH(totalLunchSec)}</strong></div>
    `;

    const byEmp = $("#period-by-emp");
    byEmp.innerHTML = "";
    const sorted = Object.keys(empAgg).sort();
    if (!sorted.length) {
      byEmp.innerHTML = "<div class='empty'>Sin datos en este período</div>";
      renderWorkAnalysis();
      renderPeriodHistory();
      return;
    }
    const tbl = document.createElement("table");
    tbl.className = "admin-table";
    tbl.innerHTML = "<thead><tr><th>Empleado</th><th>Días</th><th>Turnos</th><th>Comida</th><th>Trabajadas</th></tr></thead>";
    const tb = document.createElement("tbody");
    sorted.forEach(emp => {
      const t = empAgg[emp];
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><strong>${escapeHtml(emp)}</strong></td><td>${t.dias.size}</td><td>${t.turnos}</td><td>${fmtH(t.segsLunch)}</td><td><strong style="color:var(--jet-blue);">${fmtH(t.segs)}</strong></td>`;
      tb.appendChild(tr);
    });
    const totalTr = document.createElement("tr");
    totalTr.style.background = "var(--jet-blue-pale)";
    totalTr.style.fontWeight = "700";
    totalTr.innerHTML = `<td>TOTAL</td><td>${days.size}</td><td>${rows.length}</td><td>${fmtH(totalLunchSec)}</td><td style="color:var(--jet-blue);">${fmtH(totalSec)}</td>`;
    tb.appendChild(totalTr);
    tbl.appendChild(tb);
    byEmp.appendChild(tbl);

    renderWorkAnalysis();
    renderTopEmployees(empAgg);
    renderPeriodHistory();
  }

  function renderWorkAnalysis() {
    const el = $("#work-analysis");
    if (!el) return;
    const turnos = cache.periodTurnos || [];
    const assignments = cache.periodAssignments || [];
    const corrections = cache.periodCorrections || [];
    const today = todayStr();
    const toleranceSecs = 10 * 60;
    const actualByKey = {};
    const byEmp = {};
    const anomalies = [];

    const ensureEmp = (empId) => {
      const name = empMap[empId] || `(#${empId})`;
      if (!byEmp[empId]) byEmp[empId] = {
        empId, name, scheduled: 0, actual: 0, turnos: 0, noShow: 0,
        late: 0, early: 0, unscheduled: 0, issues: 0, corrections: 0,
      };
      return byEmp[empId];
    };

    turnos.forEach(t => {
      const d = fmtDateLocal(t.entrada_at);
      const key = `${t.empleado_id}|${d}`;
      if (!actualByKey[key]) actualByKey[key] = { secs: 0, firstIn: null, lastOut: null, rows: [] };
      const rec = actualByKey[key];
      const secs = getTurnoLiveSecs(t);
      rec.secs += secs;
      rec.rows.push(t);
      if (!rec.firstIn || new Date(t.entrada_at) < new Date(rec.firstIn)) rec.firstIn = t.entrada_at;
      if (t.salida_at && (!rec.lastOut || new Date(t.salida_at) > new Date(rec.lastOut))) rec.lastOut = t.salida_at;
      const emp = ensureEmp(t.empleado_id);
      emp.actual += secs;
      emp.turnos += 1;

      const missingPhotos = ["foto_entrada"].filter(k => !t[k]);
      if (t.salida_at && !t.foto_salida) missingPhotos.push("foto_salida");
      const missingGps = [];
      if (!t.gps_entrada) missingGps.push("GPS entrada");
      if (t.salida_at && !t.gps_salida) missingGps.push("GPS salida");
      if (!t.salida_at) anomalies.push({ empId: t.empleado_id, text: `${d}: turno abierto desde ${fmtTimeShort(t.entrada_at)}` });
      if (t.ini_descanso_at && !t.fin_descanso_at) anomalies.push({ empId: t.empleado_id, text: `${d}: descanso abierto` });
      if (secs > 12 * 3600) anomalies.push({ empId: t.empleado_id, text: `${d}: jornada mayor a 12h (${fmtH(secs)})` });
      if (secs < 0) anomalies.push({ empId: t.empleado_id, text: `${d}: horas negativas (${fmtH(secs)})` });
      if (missingPhotos.length || missingGps.length) {
        anomalies.push({ empId: t.empleado_id, text: `${d}: faltan ${[...missingPhotos, ...missingGps].join(", ")}` });
      }
    });

    const scheduledKeys = new Set();
    assignments.forEach(a => {
      const emp = ensureEmp(a.empleado_id);
      if (a.status !== "scheduled") return;
      const key = `${a.empleado_id}|${a.fecha}`;
      scheduledKeys.add(key);
      const schedSecs = scheduleSecs(a.fecha, a.hora_inicio, a.hora_fin);
      emp.scheduled += schedSecs;
      const actual = actualByKey[key];
      if (!actual || actual.secs <= 0) {
        if (a.fecha < today) { emp.noShow += 1; anomalies.push({ empId: a.empleado_id, text: `${a.fecha}: no-show (${(a.hora_inicio || "").slice(0,5)}-${(a.hora_fin || "").slice(0,5)})` }); }
        return;
      }
      const schedIn = dateTimeMs(a.fecha, a.hora_inicio);
      const schedOut = dateTimeMs(a.fecha, a.hora_fin);
      const firstIn = actual.firstIn ? new Date(actual.firstIn).getTime() : null;
      const lastOut = actual.lastOut ? new Date(actual.lastOut).getTime() : null;
      if (firstIn && schedIn && firstIn - schedIn > toleranceSecs * 1000) emp.late += 1;
      if (lastOut && schedOut && schedOut - lastOut > toleranceSecs * 1000) emp.early += 1;
    });

    Object.entries(actualByKey).forEach(([key, rec]) => {
      const [empId] = key.split("|");
      if (!scheduledKeys.has(key)) ensureEmp(empId).unscheduled += rec.rows.length;
    });
    corrections.forEach(c => ensureEmp(c.empleado_id).corrections += 1);
    anomalies.forEach(a => ensureEmp(a.empId).issues += 1);

    const totalScheduled = Object.values(byEmp).reduce((s, e) => s + e.scheduled, 0);
    const totalActual = Object.values(byEmp).reduce((s, e) => s + e.actual, 0);
    const delta = totalActual - totalScheduled;
    const totalNoShow = Object.values(byEmp).reduce((s, e) => s + e.noShow, 0);
    const totalLate = Object.values(byEmp).reduce((s, e) => s + e.late, 0);
    const totalEarly = Object.values(byEmp).reduce((s, e) => s + e.early, 0);
    const totalIssues = anomalies.length;
    const payrollRows = buildPayrollRows(byEmp);
    const payrollByEmp = {};
    payrollRows.forEach(r => payrollByEmp[r.empId] = r);
    const totalPay = payrollRows.reduce((s, r) => s + r.estimatedPay, 0);
    const totalOvertime = payrollRows.reduce((s, r) => s + r.overtimeSecs, 0);
    const totalSunday = payrollRows.reduce((s, r) => s + r.sundaySecs, 0);
    const totalNight = payrollRows.reduce((s, r) => s + r.nightSecs, 0);

    const sorted = Object.values(byEmp)
      .filter(e => e.scheduled || e.actual || e.noShow || e.issues || e.corrections)
      .sort((a, b) => b.issues - a.issues || b.actual - a.actual || a.name.localeCompare(b.name));

    el.innerHTML = `
      <div class="work-analysis-kpis">
        <div><span>Plan</span><strong>${fmtH(totalScheduled)}</strong></div>
        <div><span>Real</span><strong>${fmtH(totalActual)}</strong></div>
        <div><span>Diferencia</span><strong class="${delta < 0 ? "neg" : "pos"}">${delta < 0 ? "-" : "+"}${fmtH(Math.abs(delta))}</strong></div>
        <div><span>No-show</span><strong>${totalNoShow}</strong></div>
        <div><span>Retardos</span><strong>${totalLate}</strong></div>
        <div><span>Salidas tempranas</span><strong>${totalEarly}</strong></div>
        <div><span>Extra</span><strong>${fmtH(totalOvertime)}</strong></div>
        <div><span>Nocturnas</span><strong>${fmtH(totalNight)}</strong></div>
        <div><span>Domingo</span><strong>${fmtH(totalSunday)}</strong></div>
        <div><span>Nómina estimada</span><strong>${money(totalPay)}</strong></div>
        <div><span>Alertas</span><strong>${totalIssues}</strong></div>
      </div>
      ${renderWorkManual()}`;

    if (!sorted.length) {
      el.innerHTML += "<div class='empty'>Sin datos para análisis laboral</div>";
      return;
    }
    const tbl = document.createElement("table");
    tbl.className = "admin-table work-analysis-table";
    tbl.innerHTML = "<thead><tr><th>Empleado</th><th>Plan</th><th>Real</th><th>Δ</th><th>Extra</th><th>Noct.</th><th>Dom.</th><th>Tarifa</th><th>Pago est.</th><th>Turnos</th><th>No-show</th><th>Retardos</th><th>Temprano</th><th>Sin plan</th><th>Correcciones</th><th>Alertas</th></tr></thead>";
    const tb = document.createElement("tbody");
    sorted.forEach(e => {
      const d = e.actual - e.scheduled;
      const pay = payrollByEmp[e.empId] || {};
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escapeHtml(e.name)}</strong></td>
        <td>${fmtH(e.scheduled)}</td>
        <td>${fmtH(e.actual)}</td>
        <td class="${d < 0 ? "neg" : "pos"}">${d < 0 ? "-" : "+"}${fmtH(Math.abs(d))}</td>
        <td>${fmtH(pay.overtimeSecs || 0)}</td>
        <td>${fmtH(pay.nightSecs || 0)}</td>
        <td>${fmtH(pay.sundaySecs || 0)}</td>
        <td>${money(pay.hourlyRate || 0)}</td>
        <td><strong>${money(pay.estimatedPay || 0)}</strong></td>
        <td>${e.turnos}</td><td>${e.noShow}</td><td>${e.late}</td><td>${e.early}</td>
        <td>${e.unscheduled}</td><td>${e.corrections}</td><td>${e.issues}</td>`;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    const wrap = document.createElement("div");
    wrap.className = "table-scroll";
    wrap.appendChild(tbl);
    el.appendChild(wrap);

    if (anomalies.length) {
      const box = document.createElement("div");
      box.className = "work-alerts";
      box.innerHTML = "<strong>Alertas principales</strong>";
      anomalies.slice(0, 30).forEach(a => {
        const div = document.createElement("div");
        div.textContent = `${empMap[a.empId] || `#${a.empId}`}: ${a.text}`;
        box.appendChild(div);
      });
      if (anomalies.length > 30) {
        const more = document.createElement("div");
        more.textContent = `... ${anomalies.length - 30} alertas más`;
        box.appendChild(more);
      }
      el.appendChild(box);
    }
  }

  function renderWorkManual() {
    const es = workManualLang === "es";
    const items = es ? [
      ["Plan", "Horas programadas en Horarios para el período seleccionado."],
      ["Real", "Horas realmente trabajadas según entrada, salida y descanso."],
      ["Δ", "Diferencia entre Real y Plan. Negativo = faltaron horas; positivo = trabajó más."],
      ["Extra", "Horas por encima de las reglas configuradas en PAYROLL."],
      ["Noct.", "Horas trabajadas dentro de la ventana nocturna configurada."],
      ["Dom.", "Horas trabajadas en domingo; se suma prima dominical estimada."],
      ["Tarifa", "Tarifa por hora del puesto. Ahora está en 0 hasta capturar valores reales."],
      ["Pago est.", "Estimación: regular + extra doble/triple + prima dominical. No es recibo legal."],
      ["No-show", "Día programado pasado sin turno trabajado."],
      ["Retardos", "Entrada más de 10 minutos tarde contra horario programado."],
      ["Temprano", "Salida más de 10 minutos antes del horario programado."],
      ["Sin plan", "Turno trabajado sin día programado en Horarios."],
      ["Alertas", "Problemas para revisar: turno abierto, descanso abierto, faltan fotos/GPS, jornada anómala."],
    ] : [
      ["Plan", "Запланированные часы из Horarios за выбранный период."],
      ["Real", "Фактически отработанные часы по entrada, salida и descanso."],
      ["Δ", "Разница Real - Plan. Минус = недоработка, плюс = переработка."],
      ["Extra", "Сверхурочные часы по правилам PAYROLL."],
      ["Noct.", "Часы в ночном окне, заданном в настройках."],
      ["Dom.", "Часы в воскресенье; добавляется расчетная воскресная премия."],
      ["Tarifa", "Почасовая ставка роли. Сейчас 0, пока не внесены реальные ставки."],
      ["Pago est.", "Оценка оплаты: обычные + двойные/тройные extra + воскресная премия. Не юридический расчет."],
      ["No-show", "Прошедший запланированный день без фактической смены."],
      ["Retardos", "Опоздание больше 10 минут относительно плана."],
      ["Temprano", "Уход больше чем на 10 минут раньше плана."],
      ["Sin plan", "Смена была, но в Horarios не было плана."],
      ["Alertas", "Что проверить: открытая смена/перерыв, нет фото/GPS, аномальная jornada."],
    ];
    return `
      <details class="work-manual">
        <summary>
          <strong>${es ? "Manual de lectura" : "Инструкция к отчету"}</strong>
          <span>
            <button class="${es ? "active" : ""}" onclick="window.JETAdmin.setWorkManualLang('es'); event.preventDefault();">ES</button>
            <button class="${!es ? "active" : ""}" onclick="window.JETAdmin.setWorkManualLang('ru'); event.preventDefault();">RU</button>
          </span>
        </summary>
        <div class="work-manual-body">
          ${items.map(([k, v]) => `<div><b>${escapeHtml(k)}</b><span>${escapeHtml(v)}</span></div>`).join("")}
        </div>
      </details>`;
  }

  function setWorkManualLang(lang) {
    workManualLang = lang === "ru" ? "ru" : "es";
    renderWorkAnalysis();
  }

  function scheduleSecs(fecha, inicio, fin) {
    const a = dateTimeMs(fecha, inicio), b = dateTimeMs(fecha, fin);
    if (!a || !b) return 0;
    return Math.max(0, Math.round(((b <= a ? b + 86400000 : b) - a) / 1000));
  }

  function dateTimeMs(fecha, hhmm) {
    if (!fecha || !hhmm) return null;
    return new Date(`${fecha}T${String(hhmm).slice(0,5)}:00`).getTime();
  }

  function buildPayrollRows(byEmp) {
    const rules = CFG.PAYROLL || {};
    const dailyRegularSecs = (rules.dailyRegularHours || 8) * 3600;
    const weeklyRegularSecs = (rules.weeklyRegularHours || 48) * 3600;
    const doubleCapSecs = (rules.overtimeFirstWeeklyHours || 9) * 3600;
    const rows = Object.values(byEmp).map(e => {
      const profile = cache.empleados.find(x => String(x.id) === String(e.empId)) || {};
      const role = CFG.ROLES?.[profile.puesto] || {};
      const hourlyRate = Number(role.hourlyRate ?? rules.defaultHourlyRate ?? 0) || 0;
      const workedByDate = {};
      (cache.periodTurnos || [])
        .filter(t => String(t.empleado_id) === String(e.empId))
        .forEach(t => {
          const d = fmtDateLocal(t.entrada_at);
          if (!workedByDate[d]) workedByDate[d] = 0;
          workedByDate[d] += getTurnoLiveSecs(t);
        });

      let dailyOvertimeSecs = 0;
      Object.values(workedByDate).forEach(secs => {
        dailyOvertimeSecs += Math.max(0, secs - dailyRegularSecs);
      });
      const weeklyOvertimeSecs = Math.max(0, e.actual - weeklyRegularSecs);
      const overtimeSecs = Math.max(dailyOvertimeSecs, weeklyOvertimeSecs);
      const regularSecs = Math.max(0, e.actual - overtimeSecs);
      const doubleSecs = Math.min(overtimeSecs, doubleCapSecs);
      const tripleSecs = Math.max(0, overtimeSecs - doubleSecs);
      const sundaySecs = sumSundaySecs(e.empId);
      const nightSecs = sumNightSecs(e.empId);
      const regularPay = hours(regularSecs) * hourlyRate;
      const overtimePay =
        hours(doubleSecs) * hourlyRate * (rules.overtimeDoubleMultiplier || 2) +
        hours(tripleSecs) * hourlyRate * (rules.overtimeTripleMultiplier || 3);
      const sundayPay = hours(sundaySecs) * hourlyRate * ((rules.sundayPremiumPct || 0) / 100);
      const estimatedPay = regularPay + overtimePay + sundayPay;
      return {
        empId: e.empId, name: e.name, role: role.label || profile.puesto || "",
        hourlyRate, scheduledSecs: e.scheduled, actualSecs: e.actual,
        regularSecs, overtimeSecs, doubleSecs, tripleSecs, nightSecs, sundaySecs,
        noShow: e.noShow, late: e.late, early: e.early, unscheduled: e.unscheduled,
        corrections: e.corrections, issues: e.issues, estimatedPay,
      };
    });
    return rows.sort((a, b) => b.estimatedPay - a.estimatedPay || a.name.localeCompare(b.name));
  }

  function sumSundaySecs(empId) {
    return (cache.periodTurnos || [])
      .filter(t => String(t.empleado_id) === String(empId))
      .reduce((s, t) => {
        const day = new Date(t.entrada_at).toLocaleDateString("en-US", { weekday: "short", timeZone: CFG.TIMEZONE });
        return s + (day === "Sun" ? getTurnoLiveSecs(t) : 0);
      }, 0);
  }

  function sumNightSecs(empId) {
    const rules = CFG.PAYROLL || {};
    const start = rules.nightStart || "20:00";
    const end = rules.nightEnd || "06:00";
    return (cache.periodTurnos || [])
      .filter(t => String(t.empleado_id) === String(empId))
      .reduce((s, t) => s + overlapWindowSecs(t.entrada_at, t.salida_at || new Date().toISOString(), start, end), 0);
  }

  function overlapWindowSecs(startIso, endIso, winStart, winEnd) {
    if (!startIso || !endIso) return 0;
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (!(end > start)) return 0;
    let total = 0;
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const day = d.toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
      const a = new Date(`${day}T${winStart}:00`);
      let b = new Date(`${day}T${winEnd}:00`);
      if (b <= a) b = new Date(b.getTime() + 86400000);
      total += Math.max(0, Math.min(end.getTime(), b.getTime()) - Math.max(start.getTime(), a.getTime())) / 1000;
    }
    return Math.round(total);
  }

  function hours(secs) { return (secs || 0) / 3600; }
  function money(n) { return "$" + Number(n || 0).toFixed(2); }

  function renderPeriodHistory() {
    const count = $("#admin-history-count");
    const list = $("#admin-history-list");
    if (!list) return;
    const rows = cache.periodTurnos || [];
    if (count) count.textContent = rows.length;
    list.innerHTML = "";
    if (!rows.length) {
      list.innerHTML = "<div class='empty'>Sin historial en este período</div>";
      return;
    }

    const tbl = document.createElement("table");
    tbl.className = "admin-table admin-history-table";
    tbl.innerHTML = "<thead><tr><th>Fecha</th><th>Empleado</th><th>Punto</th><th>Entrada</th><th>Descanso</th><th>Salida</th><th>Horas</th><th>Fotos</th></tr></thead>";
    const tb = document.createElement("tbody");
    rows.forEach(r => {
      const empName = empMap[r.empleado_id] || `(#${r.empleado_id})`;
      const lunch = `${fmtTimeShort(r.ini_descanso_at)} - ${fmtTimeShort(r.fin_descanso_at)}`;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${fmtDateLocal(r.entrada_at)}</td>
        <td><strong>${escapeHtml(empName)}</strong></td>
        <td>${escapeHtml(r.punto || "")}</td>
        <td>${fmtTimeShort(r.entrada_at)}</td>
        <td>${lunch}</td>
        <td>${fmtTimeShort(r.salida_at)}</td>
        <td>${fmtH(getTurnoLiveSecs(r))}${r.salida_at ? "" : " <span class='live-pill'>en vivo</span>"}</td>
        <td>${renderTurnoPhotoLinks(r, empName)}</td>`;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    list.appendChild(tbl);
  }

  // ── Render: Active employees agrupados por tier ──────────────────────────
  function renderActive() {
    const tierBuckets = { linea: [], senior: [], manager: [] };
    cache.empleados.forEach(e => {
      const role = CFG.ROLES[e.puesto];
      const tier = role ? role.tier : "linea"; // sin puesto → línea
      tierBuckets[tier].push(e);
    });

    Object.keys(tierBuckets).forEach(tierKey => {
      const list = $(`#admin-tier-${tierKey}-list`);
      const cnt = $(`#admin-tier-${tierKey}-count`);
      if (!list || !cnt) return;
      cnt.textContent = tierBuckets[tierKey].length;
      list.innerHTML = "";
      if (!tierBuckets[tierKey].length) {
        list.innerHTML = "<div class='empty'>Vacío</div>";
        return;
      }
      renderTierEmpleados(list, tierBuckets[tierKey]);
    });
  }

  function renderTierEmpleados(list, empleados) {
    const adminMap = {};
    cache.admins.forEach(a => adminMap[a.email] = a);
    empleados.forEach(e => {
      const div = document.createElement("div");
      div.className = "week-row emp-admin-row";
      const adm = adminMap[e.email];
      const isAdmin = !!adm;
      const isSuper = adm && adm.super;
      const adminBadge = isSuper
        ? ` <span class="badge" style="background:#ffe4a7;color:#5a3e00;">⭐ SUPER</span>`
        : isAdmin
          ? ` <span class="badge" style="background:#fff3cd;color:#6a4a00;">ADMIN</span>`
          : "";
      const roleBadge = renderRoleBadge(e.puesto);
      const promoteBtn = isAdmin ? "" : `<button class="btn-mini btn-mini-promote" data-action="promote" data-email="${escapeHtml(e.email)}" data-name="${escapeHtml(e.nombre)}" title="Hacer admin">👑</button>`;
      const deleteBtn = isSuper ? "" : `<button class="btn-mini btn-mini-delete" data-action="delete-emp" data-id="${e.id}" data-name="${escapeHtml(e.nombre)}" title="Eliminar">🗑</button>`;
      const roleOptions = ["", ...Object.keys(CFG.ROLES)].map(k => {
        const lbl = k ? `${CFG.ROLES[k].icon} ${CFG.ROLES[k].label}` : "— Sin puesto —";
        return `<option value="${k}" ${e.puesto === k ? "selected" : ""}>${lbl}</option>`;
      }).join("");
      div.innerHTML = `
        <div class="emp-admin-main">
          <div class="emp-admin-name">${escapeHtml(e.nombre)}${adminBadge}${roleBadge}</div>
          <div class="emp-admin-meta">${escapeHtml(e.email)}${e.telefono ? " · " + escapeHtml(e.telefono) : ""}</div>
        </div>
        <div class="emp-admin-controls">
          <select class="role-select" data-action="set-role" data-id="${e.id}">${roleOptions}</select>
          <div class="emp-actions">
            ${promoteBtn}
            ${deleteBtn}
          </div>
        </div>`;
      list.appendChild(div);
    });
    list.querySelectorAll('[data-action="promote"]').forEach(b =>
      b.addEventListener("click", () => promoteEmp(b.dataset.email, b.dataset.name)));
    list.querySelectorAll('[data-action="delete-emp"]').forEach(b =>
      b.addEventListener("click", () => deleteEmp(b.dataset.id, b.dataset.name)));
    list.querySelectorAll('[data-action="set-role"]').forEach(s =>
      s.addEventListener("change", () => setRole(s.dataset.id, s.value)));
  }

  function renderRoleBadge(puesto) {
    if (!puesto || !CFG.ROLES[puesto]) return "";
    const r = CFG.ROLES[puesto];
    return ` <span class="role-badge" style="background:${r.bg};color:${r.color};">${r.icon} ${r.label}</span>`;
  }

  async function setRole(empId, puesto) {
    try {
      const { error } = await sb.from("empleados").update({ puesto: puesto || null }).eq("id", empId);
      if (error) throw error;
      // Actualizar cache local
      const e = cache.empleados.find(x => String(x.id) === String(empId));
      if (e) e.puesto = puesto || null;
      // Re-render tiers (empleado puede haber saltado a otra card)
      renderActive();
    } catch (e) { alert("Error: " + e.message); }
  }

  // ── Render: Administradores ──────────────────────────────────────────────
  function renderAdmins() {
    $("#admin-admins-count").textContent = cache.admins.length;
    const list = $("#admin-admins-list");
    if (!list) return;
    list.innerHTML = "";
    if (!cache.admins.length) {
      list.innerHTML = "<div class='empty'>Sin administradores</div>";
      return;
    }
    cache.admins.forEach(a => {
      const isMe = a.email === myEmail;
      const div = document.createElement("div");
      div.className = "admin-row";
      const superBadge = a.super ? '<span class="admin-super">⭐ SUPER</span>' : '';
      const meBadge = isMe ? '<span class="admin-self">(tú)</span>' : '';
      const showDelete = !a.super && !isMe;
      div.innerHTML = `
        <span class="admin-email">${escapeHtml(a.email)}${superBadge}${meBadge}</span>
        ${showDelete ? `<button class="btn-mini btn-mini-ghost" data-email="${escapeHtml(a.email)}" title="Quitar admin">✕</button>` : ""}`;
      list.appendChild(div);
    });
    list.querySelectorAll("[data-email]").forEach(b =>
      b.addEventListener("click", () => removeAdmin(b.dataset.email)));
  }

  async function addAdmin(email) {
    email = (email || "").trim().toLowerCase();
    if (!email || !email.includes("@")) { alert("Email inválido"); return; }
    showOverlay("Agregando admin...");
    try {
      const { error } = await sb.from("admins").insert({ email });
      if (error) {
        if (error.code === "23505") throw new Error("Ya es admin");
        if (error.code === "42501" || error.message.includes("policy")) throw new Error("Sin permisos. Revisa RLS de tabla admins.");
        throw error;
      }
      $("#new-admin-email").value = "";
      await load();
    } catch (e) { alert("Error: " + e.message); } finally { hideOverlay(); }
  }

  async function removeAdmin(email) {
    if (email === myEmail) { alert("No puedes quitarte a ti mismo"); return; }
    if (!confirm(`¿Quitar admin a ${email}?`)) return;
    showOverlay("Quitando admin...");
    try {
      const { error } = await sb.from("admins").delete().eq("email", email);
      if (error) throw error;
      await load();
    } catch (e) { alert("Error: " + e.message); } finally { hideOverlay(); }
  }

  async function promoteEmp(email, name) {
    if (!confirm(`Hacer admin a ${name} (${email})?`)) return;
    await addAdmin(email);
  }

  async function deleteEmp(id, name) {
    if (!confirm(`¿Eliminar a ${name}? Esta acción borra al empleado y no se puede deshacer.`)) return;
    if (!confirm(`Confirma de nuevo: ELIMINAR a ${name}?`)) return;
    showOverlay("Eliminando...");
    try {
      const { error } = await sb.from("empleados").delete().eq("id", id);
      if (error) {
        if (error.message.includes("foreign key") || error.code === "23503")
          throw new Error("Tiene turnos registrados. Primero exporta CSV o usa SQL para eliminar manualmente.");
        throw error;
      }
      await load();
    } catch (e) { alert("Error: " + e.message); } finally { hideOverlay(); }
  }

  async function promptDeleteTurno(turnoId, empName, timeRange) {
    const reason = prompt(`Eliminar turno de ${empName} (${timeRange})\n\nMotivo (obligatorio):`, "");
    if (reason === null) return;
    if (!reason.trim() || reason.trim().length < 3) {
      alert("Motivo requerido (mín. 3 caracteres)");
      return;
    }
    showOverlay("Eliminando turno...");
    try {
      const { error } = await sb.from("turnos").update({
        deleted_at: new Date().toISOString(),
        deleted_by: myEmail,
        delete_reason: reason.trim(),
      }).eq("id", turnoId);
      if (error) throw error;
      await load();
    } catch (e) { alert("Error: " + e.message); } finally { hideOverlay(); }
  }

  // ── Approve / Reject empleado ────────────────────────────────────────────
  async function approveEmp(id) {
    showOverlay("Aprobando...");
    try {
      const userEmail = (await sb.auth.getUser()).data.user?.email || "admin";
      const { error } = await sb.from("empleados").update({
        activo: true, aprobado_at: new Date().toISOString(), aprobado_por: userEmail,
      }).eq("id", id);
      if (error) throw error;
      await load();
    } catch (e) { alert("Error: " + e.message); } finally { hideOverlay(); }
  }
  async function rejectEmp(id) {
    if (!confirm("¿Rechazar y eliminar la solicitud?")) return;
    showOverlay("Rechazando...");
    try {
      const { error } = await sb.from("empleados").delete().eq("id", id);
      if (error) throw error;
      await load();
    } catch (e) { alert("Error: " + e.message); } finally { hideOverlay(); }
  }

  // ── Approve / Reject correction ──────────────────────────────────────────
  async function approveCorrection(id) {
    const reqId = parseInt(id, 10);
    if (!Number.isFinite(reqId)) { alert("ID inválido"); return; }
    const note = prompt("Nota opcional (visible al empleado):", "");
    if (note === null) return;
    showOverlay("Aprobando...");
    try {
      const { data, error } = await sb.rpc("approve_correction", { p_req_id: reqId, p_admin_note: note || null });
      if (error) throw error;
      await load();
    } catch (e) { alert("Error: " + e.message); } finally { hideOverlay(); }
  }
  async function rejectCorrection(id) {
    const reqId = parseInt(id, 10);
    if (!Number.isFinite(reqId)) { alert("ID inválido"); return; }
    const note = prompt("Razón del rechazo:", "");
    if (note === null) return;
    showOverlay("Rechazando...");
    try {
      const { data, error } = await sb.rpc("reject_correction", { p_req_id: reqId, p_admin_note: note || null });
      if (error) throw error;
      await load();
    } catch (e) { alert("Error: " + e.message); } finally { hideOverlay(); }
  }

  // ── Photo opener (signed URL для приватного бакета) ──────────────────────
  async function openPhoto(linkEl) {
    const path = linkEl.dataset.path;
    if (!path) return;
    if (path.startsWith("http")) { openPhotoLightbox(path, linkEl.dataset.caption || "", null); return; }
    const url = await getSignedUrl(path);
    if (url) openPhotoLightbox(url, linkEl.dataset.caption || "", path);
    else alert("No se pudo cargar la foto");
  }

  // ── CSV Export ───────────────────────────────────────────────────────────
  function exportCSV() {
    if (!cache.periodTurnos.length) { alert("No hay datos para exportar"); return; }
    const headers = ["Fecha","Empleado","Punto","Entrada","Inicio descanso","Fin descanso","Salida","Horas comida","Horas trabajadas","GPS entrada","GPS salida","Origen"];
    const empSummary = {};
    const rows = cache.periodTurnos.map(r => [
      fmtDateLocal(r.entrada_at),
      empMap[r.empleado_id] || `#${r.empleado_id}`,
      r.punto || "",
      fmtTimeShort(r.entrada_at), fmtTimeShort(r.ini_descanso_at),
      fmtTimeShort(r.fin_descanso_at), fmtTimeShort(r.salida_at),
      r.horas_comida_secs ? fmtH(r.horas_comida_secs) : "",
      r.salida_at ? fmtH(getTurnoWorkSecs(r)) : fmtH(getTurnoLiveSecs(r)),
      r.gps_entrada || "", r.gps_salida || "",
      r.source || "app",
    ]);
    cache.periodTurnos.forEach(r => {
      const empId = String(r.empleado_id);
      const empName = empMap[r.empleado_id] || `#${r.empleado_id}`;
      const day = fmtDateLocal(r.entrada_at);
      if (!empSummary[empId]) empSummary[empId] = { name: empName, days: {}, shifts: 0, totalSecs: 0 };
      empSummary[empId].shifts += 1;
      const secs = getTurnoLiveSecs(r);
      empSummary[empId].totalSecs += secs;
      empSummary[empId].days[day] = (empSummary[empId].days[day] || 0) + secs;
    });
    const totalSec = cache.periodTurnos.reduce((s, r) => s + getTurnoLiveSecs(r), 0);
    rows.push([]);
    rows.push(["TOTAL", "", "", "", "", "", "", "", fmtH(totalSec), "", "", ""]);
    rows.push([]);
    rows.push(["RESUMEN POR EMPLEADO"]);
    rows.push(["Empleado","Dias trabajados","Dias y tiempo trabajado","Turnos","Tiempo total"]);
    Object.values(empSummary)
      .sort((a, b) => a.name.localeCompare(b.name))
      .forEach(emp => {
        const dayEntries = Object.entries(emp.days).sort(([a], [b]) => a.localeCompare(b));
        rows.push([
          emp.name,
          dayEntries.length,
          dayEntries.map(([day, secs]) => `${day}: ${fmtH(secs)}`).join(" | "),
          emp.shifts,
          fmtH(emp.totalSecs),
        ]);
      });

    const csv = [headers, ...rows].map(row =>
      row.map(cell => {
        const s = String(cell ?? "");
        return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(";")
    ).join("\r\n");

    const bom = "﻿";
    const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `JET_reporte_${cache.periodFrom}_${cache.periodTo}.csv`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function exportPayrollCSV() {
    if (!cache.periodTurnos.length && !cache.periodAssignments.length) { alert("No hay datos para exportar"); return; }
    const byEmp = {};
    const ensure = (empId) => {
      const name = empMap[empId] || `#${empId}`;
      if (!byEmp[empId]) byEmp[empId] = {
        empId, name, scheduled: 0, actual: 0, turnos: 0, noShow: 0,
        late: 0, early: 0, unscheduled: 0, issues: 0, corrections: 0,
      };
      return byEmp[empId];
    };
    const actualByKey = {};
    (cache.periodTurnos || []).forEach(t => {
      const d = fmtDateLocal(t.entrada_at);
      const key = `${t.empleado_id}|${d}`;
      if (!actualByKey[key]) actualByKey[key] = { secs: 0, firstIn: null, lastOut: null, rows: [] };
      actualByKey[key].secs += getTurnoLiveSecs(t);
      actualByKey[key].rows.push(t);
      if (!actualByKey[key].firstIn || new Date(t.entrada_at) < new Date(actualByKey[key].firstIn)) actualByKey[key].firstIn = t.entrada_at;
      if (t.salida_at && (!actualByKey[key].lastOut || new Date(t.salida_at) > new Date(actualByKey[key].lastOut))) actualByKey[key].lastOut = t.salida_at;
      const emp = ensure(t.empleado_id);
      emp.actual += getTurnoLiveSecs(t);
      emp.turnos += 1;
    });
    const scheduledKeys = new Set();
    (cache.periodAssignments || []).forEach(a => {
      const emp = ensure(a.empleado_id);
      if (a.status !== "scheduled") return;
      const key = `${a.empleado_id}|${a.fecha}`;
      scheduledKeys.add(key);
      emp.scheduled += scheduleSecs(a.fecha, a.hora_inicio, a.hora_fin);
      if (!actualByKey[key]?.secs && a.fecha < todayStr()) emp.noShow += 1;
      const schedIn = dateTimeMs(a.fecha, a.hora_inicio);
      const schedOut = dateTimeMs(a.fecha, a.hora_fin);
      const firstIn = actualByKey[key]?.firstIn ? new Date(actualByKey[key].firstIn).getTime() : null;
      const lastOut = actualByKey[key]?.lastOut ? new Date(actualByKey[key].lastOut).getTime() : null;
      if (firstIn && schedIn && firstIn - schedIn > 10 * 60 * 1000) emp.late += 1;
      if (lastOut && schedOut && schedOut - lastOut > 10 * 60 * 1000) emp.early += 1;
    });
    Object.entries(actualByKey).forEach(([key, rec]) => {
      const [empId] = key.split("|");
      if (!scheduledKeys.has(key)) ensure(empId).unscheduled += rec.rows.length;
    });
    (cache.periodCorrections || []).forEach(c => ensure(c.empleado_id).corrections += 1);

    const rows = buildPayrollRows(byEmp);
    const headers = ["Empleado","Puesto","Plan","Real","Diferencia","Regular","Extra doble","Extra triple","Nocturnas","Domingo","Tarifa hora","Pago estimado","Turnos","No-show","Retardos","Salidas tempranas","Sin plan","Correcciones","Alertas"];
    const csvRows = rows.map(r => [
      r.name, r.role, fmtH(r.scheduledSecs), fmtH(r.actualSecs), fmtSignedH(r.actualSecs - r.scheduledSecs),
      fmtH(r.regularSecs), fmtH(r.doubleSecs), fmtH(r.tripleSecs), fmtH(r.nightSecs), fmtH(r.sundaySecs),
      money(r.hourlyRate), money(r.estimatedPay), r.turnos, r.noShow, r.late, r.early, r.unscheduled, r.corrections, r.issues,
    ]);
    downloadCSV(`JET_nomina_${cache.periodFrom}_${cache.periodTo}.csv`, [headers, ...csvRows]);
  }

  function fmtSignedH(secs) {
    const sign = secs < 0 ? "-" : "+";
    return sign + fmtH(Math.abs(secs || 0));
  }

  function downloadCSV(filename, rows) {
    const csv = rows.map(row =>
      row.map(cell => {
        const s = String(cell ?? "");
        return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(";")
    ).join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Bind ─────────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    const r = $("#btn-admin-refresh"); if (r) r.addEventListener("click", load);
    const fu = $("#btn-force-update");
    if (fu) fu.addEventListener("click", async () => {
      if (!confirm("Limpiar caché y recargar la app? Útil cuando empleados no ven los últimos cambios.")) return;
      try {
        if ("caches" in window) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
        }
        if ("serviceWorker" in navigator) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map(r => r.unregister()));
        }
      } catch (e) { console.warn("Cache clear failed:", e); }
      window.location.reload(true);
    });
    $$(".period-tab").forEach(t => t.addEventListener("click", () => setPeriod(t.dataset.period)));
    const apply = $("#btn-period-apply"); if (apply) apply.addEventListener("click", applyCustomPeriod);
    const exp = $("#btn-export-csv"); if (exp) exp.addEventListener("click", exportCSV);
    const expPayroll = $("#btn-export-payroll"); if (expPayroll) expPayroll.addEventListener("click", exportPayrollCSV);
    const fromIn = $("#period-from"); if (fromIn) fromIn.value = dateOffset(7);
    const toIn = $("#period-to"); if (toIn) toIn.value = todayStr();
    const lbClose = $("#lightbox-close"); if (lbClose) lbClose.addEventListener("click", closePhotoLightbox);
    const lb = $("#photo-lightbox");
    if (lb) lb.addEventListener("click", e => { if (e.target === lb) closePhotoLightbox(); });
    document.addEventListener("keydown", e => { if (e.key === "Escape") closePhotoLightbox(); });
    const addAdminBtn = $("#btn-add-admin");
    if (addAdminBtn) addAdminBtn.addEventListener("click", () => addAdmin($("#new-admin-email").value));
    const newAdminInput = $("#new-admin-email");
    if (newAdminInput) newAdminInput.addEventListener("keydown", e => { if (e.key === "Enter") addAdmin(e.target.value); });
  });

  window.JETAdmin = { load, openPhoto, renderRoleBadge, setWorkManualLang, getEmpleados: () => cache.empleados, getMyEmail: () => myEmail };
})();
