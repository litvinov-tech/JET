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
  function fmtH(secs) {
    if (!secs || secs < 0) return "0h 00m";
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h + "h " + (m < 10 ? "0" : "") + m + "m";
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
    periodTurnos: [], periodFrom: null, periodTo: null,
    correctionsPending: [],
    admins: [],
  };
  let empMap = {}; // empleado_id -> nombre
  let myEmail = null;

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
      myEmail = (await sb.auth.getUser()).data.user?.email || null;
      const [pendingRes, activeRes, todayRes, corrRes, adminsRes] = await Promise.all([
        sb.from("empleados").select("id, nombre, email, telefono, created_at").eq("activo", false).order("created_at", { ascending: false }),
        sb.from("empleados").select("id, nombre, email, telefono, puesto").eq("activo", true).order("nombre"),
        sb.from("turnos").select("*").gte("entrada_at", today + "T00:00:00").order("entrada_at", { ascending: true }),
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
        el.onclick = () => openPhotoLightbox(url, el.dataset.caption);
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
    };
    update();
    liveTimerHandle = setInterval(update, 1000);
  }

  // ── Hours chart (last 7 days) ────────────────────────────────────────────
  async function loadHoursChart() {
    const fromIso = dateOffset(6) + "T00:00:00";
    const toIso = todayStr() + "T23:59:59";
    try {
      const { data, error } = await sb.from("turnos")
        .select("entrada_at, horas_trab_secs")
        .gte("entrada_at", fromIso).lte("entrada_at", toIso);
      if (error) throw error;
      const byDay = {};
      for (let i = 6; i >= 0; i--) byDay[dateOffset(i)] = 0;
      (data || []).forEach(r => {
        const d = fmtDateLocal(r.entrada_at);
        if (d in byDay) byDay[d] += r.horas_trab_secs || 0;
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
  function openPhotoLightbox(url, caption) {
    const lb = $("#photo-lightbox");
    if (!lb) return;
    $("#lightbox-img").src = url;
    $("#lightbox-caption").textContent = caption || "";
    lb.classList.remove("hidden");
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
      const fromIso = cache.periodFrom + "T00:00:00";
      const toIso = cache.periodTo + "T23:59:59";
      const { data, error } = await sb.from("turnos")
        .select("*").gte("entrada_at", fromIso).lte("entrada_at", toIso)
        .order("entrada_at", { ascending: false });
      if (error) throw error;
      cache.periodTurnos = data || [];
      renderPeriod();
    } catch (e) {
      alert("Error: " + e.message);
    } finally {
      hideOverlay();
    }
  }

  // ── Render: KPIs ─────────────────────────────────────────────────────────
  function renderKPIs() {
    const working = cache.turnosToday.filter(t => !t.salida_at).length;
    const totalSec = cache.turnosToday.reduce((s, t) => s + (t.horas_trab_secs || 0), 0);
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
    tbl.innerHTML = "<thead><tr><th>Empleado</th><th>Punto</th><th>Entrada</th><th>Salida</th><th>Horas</th><th>Fotos</th></tr></thead>";
    const tb = document.createElement("tbody");
    cache.turnosToday.forEach(r => {
      const empName = empMap[r.empleado_id] || `(#${r.empleado_id})`;
      const photoSpec = [
        ["foto_entrada", "▶", "Entrada"],
        ["foto_ini_desc", "🍴", "Inicio descanso"],
        ["foto_fin_desc", "↩", "Fin descanso"],
        ["foto_salida", "⏹", "Salida"],
      ];
      const photosHtml = photoSpec
        .filter(([k]) => r[k])
        .map(([k, icon, label]) =>
          `<a class="photo-link" data-path="${escapeHtml(r[k])}" data-caption="${escapeHtml(empName + " · " + label)}" href="#" onclick="window.JETAdmin.openPhoto(this); return false;">${icon}</a>`
        ).join(" ");
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(empName)}</td><td>${escapeHtml(r.punto || "")}</td><td>${fmtTimeShort(r.entrada_at)}</td><td>${fmtTimeShort(r.salida_at)}</td><td>${r.horas_trab_secs ? fmtH(r.horas_trab_secs) : "—"}</td><td>${photosHtml}</td>`;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    list.appendChild(tbl);
  }

  // ── Render: Period summary ───────────────────────────────────────────────
  function renderPeriod() {
    const rows = cache.periodTurnos;
    let totalSec = 0, totalLunchSec = 0;
    const empAgg = {};
    const days = new Set();
    rows.forEach(r => {
      const sec = r.horas_trab_secs || 0;
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

    renderTopEmployees(empAgg);
  }

  // ── Render: Active employees ─────────────────────────────────────────────
  function renderActive() {
    $("#admin-active-count").textContent = cache.empleados.length;
    const list = $("#admin-active-list");
    list.innerHTML = "";
    if (!cache.empleados.length) {
      list.innerHTML = "<div class='empty'>Sin empleados aprobados</div>";
      return;
    }
    const adminMap = {};
    cache.admins.forEach(a => adminMap[a.email] = a);
    cache.empleados.forEach(e => {
      const div = document.createElement("div");
      div.className = "week-row";
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
        <span style="min-width:0;flex:1;">
          <strong>${escapeHtml(e.nombre)}</strong>${adminBadge}${roleBadge}<br>
          <small style="color:var(--jet-gray);font-size:11px;">${escapeHtml(e.email)}${e.telefono ? " · " + escapeHtml(e.telefono) : ""}</small>
        </span>
        <select class="role-select" data-action="set-role" data-id="${e.id}">${roleOptions}</select>
        <div class="emp-actions">
          ${promoteBtn}
          ${deleteBtn}
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
      // Actualizar cache local sin recarga completa
      const e = cache.empleados.find(x => String(x.id) === String(empId));
      if (e) e.puesto = puesto || null;
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
    const note = prompt("Nota opcional (visible al empleado):", "");
    if (note === null) return;
    showOverlay("Aprobando...");
    try {
      const { data, error } = await sb.rpc("approve_correction", { p_req_id: parseInt(id), p_admin_note: note || null });
      if (error) throw error;
      await load();
    } catch (e) { alert("Error: " + e.message); } finally { hideOverlay(); }
  }
  async function rejectCorrection(id) {
    const note = prompt("Razón del rechazo:", "");
    if (note === null) return;
    showOverlay("Rechazando...");
    try {
      const { data, error } = await sb.rpc("reject_correction", { p_req_id: parseInt(id), p_admin_note: note || null });
      if (error) throw error;
      await load();
    } catch (e) { alert("Error: " + e.message); } finally { hideOverlay(); }
  }

  // ── Photo opener (signed URL для приватного бакета) ──────────────────────
  async function openPhoto(linkEl) {
    const path = linkEl.dataset.path;
    if (!path) return;
    if (path.startsWith("http")) { openPhotoLightbox(path, linkEl.dataset.caption || ""); return; }
    const url = await getSignedUrl(path);
    if (url) openPhotoLightbox(url, linkEl.dataset.caption || "");
    else alert("No se pudo cargar la foto");
  }

  // ── CSV Export ───────────────────────────────────────────────────────────
  function exportCSV() {
    if (!cache.periodTurnos.length) { alert("No hay datos para exportar"); return; }
    const headers = ["Fecha","Empleado","Punto","Entrada","Inicio descanso","Fin descanso","Salida","Horas comida","Horas trabajadas","GPS entrada","GPS salida","Origen"];
    const rows = cache.periodTurnos.map(r => [
      fmtDateLocal(r.entrada_at),
      empMap[r.empleado_id] || `#${r.empleado_id}`,
      r.punto || "",
      fmtTimeShort(r.entrada_at), fmtTimeShort(r.ini_descanso_at),
      fmtTimeShort(r.fin_descanso_at), fmtTimeShort(r.salida_at),
      r.horas_comida_secs ? fmtH(r.horas_comida_secs) : "",
      r.horas_trab_secs ? fmtH(r.horas_trab_secs) : "",
      r.gps_entrada || "", r.gps_salida || "",
      r.source || "app",
    ]);
    const totalSec = cache.periodTurnos.reduce((s, r) => s + (r.horas_trab_secs || 0), 0);
    rows.push([]);
    rows.push(["TOTAL", "", "", "", "", "", "", "", fmtH(totalSec), "", "", ""]);

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

  // ── Bind ─────────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    const r = $("#btn-admin-refresh"); if (r) r.addEventListener("click", load);
    $$(".period-tab").forEach(t => t.addEventListener("click", () => setPeriod(t.dataset.period)));
    const apply = $("#btn-period-apply"); if (apply) apply.addEventListener("click", applyCustomPeriod);
    const exp = $("#btn-export-csv"); if (exp) exp.addEventListener("click", exportCSV);
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

  window.JETAdmin = { load, openPhoto, renderRoleBadge, getEmpleados: () => cache.empleados, getMyEmail: () => myEmail };
})();
