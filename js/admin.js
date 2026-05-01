"use strict";
// JET Admin — full dashboard for accounting

(function () {
  const { sb, $, $$, CFG } = window.JET;

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
  function parseHHMM(s) {
    if (!s) return 0;
    const p = String(s).split(":").map(Number);
    return (p[0] || 0) * 3600 + (p[1] || 0) * 60 + (p[2] || 0);
  }
  function fmtH(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return h + "h " + (m < 10 ? "0" : "") + m + "m";
  }
  function fmtHHMM(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m;
  }

  function showOverlay(t) { $("#overlay-text").textContent = t || "Cargando..."; $("#overlay").classList.remove("hidden"); }
  function hideOverlay() { $("#overlay").classList.add("hidden"); }

  // ── State ────────────────────────────────────────────────────────────────
  let cache = { empleados: [], pending: [], turnosToday: [], periodTurnos: [], periodFrom: null, periodTo: null };
  let currentPeriod = "today";

  // ── Period selection ─────────────────────────────────────────────────────
  function setPeriod(p) {
    currentPeriod = p;
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
    if (from > to) { alert("La fecha 'desde' debe ser anterior a 'hasta'"); return; }
    cache.periodFrom = from; cache.periodTo = to;
    loadPeriod();
  }

  // ── Main load ────────────────────────────────────────────────────────────
  async function load() {
    showOverlay();
    try {
      const today = todayStr();

      const [pendingRes, activeRes, todayRes] = await Promise.all([
        sb.from("empleados").select("id, nombre, email, telefono, created_at").eq("activo", false).order("created_at", { ascending: false }),
        sb.from("empleados").select("id, nombre, email, telefono").eq("activo", true).order("nombre"),
        sb.from("turnos").select("*").eq("fecha", today).order("entrada", { ascending: true }),
      ]);

      cache.pending     = pendingRes.data || [];
      cache.empleados   = activeRes.data || [];
      cache.turnosToday = todayRes.data || [];

      renderKPIs();
      renderPending();
      renderToday();
      renderActive();

      // Init period (default = today если ещё не было)
      if (!cache.periodFrom) {
        cache.periodFrom = today;
        cache.periodTo = today;
      }
      await loadPeriod();
    } catch (e) {
      alert("Error cargando admin: " + e.message);
    } finally {
      hideOverlay();
    }
  }

  async function loadPeriod() {
    showOverlay("Cargando período...");
    try {
      const { data, error } = await sb.from("turnos")
        .select("*")
        .gte("fecha", cache.periodFrom)
        .lte("fecha", cache.periodTo)
        .order("fecha", { ascending: false })
        .order("entrada", { ascending: true });
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
    const working = cache.turnosToday.filter(t => t.entrada && !t.salida).length;
    const totalSec = cache.turnosToday.reduce((sum, t) => sum + parseHHMM(t.horas_trab), 0);
    $("#kpi-today-working").textContent = working;
    $("#kpi-today-hours").textContent = fmtH(totalSec);
    $("#kpi-active").textContent = cache.empleados.length;
    $("#kpi-pending").textContent = cache.pending.length;
  }

  // ── Render: Pending ──────────────────────────────────────────────────────
  function renderPending() {
    const card = $("#admin-pending-card");
    $("#admin-pending-count").textContent = cache.pending.length;
    if (!cache.pending.length) { card.style.display = "none"; return; }
    card.style.display = "block";
    const list = $("#admin-pending-list");
    list.innerHTML = "";
    const tbl = document.createElement("table");
    tbl.className = "admin-table";
    tbl.innerHTML = "<thead><tr><th>Nombre</th><th>Email</th><th>Tel</th><th>Solicitado</th><th></th></tr></thead>";
    const tb = document.createElement("tbody");
    cache.pending.forEach(e => {
      const tr = document.createElement("tr");
      const dt = new Date(e.created_at).toLocaleString("es-MX", { timeZone: CFG.TIMEZONE, dateStyle: "short", timeStyle: "short" });
      tr.innerHTML = `
        <td><strong>${escapeHtml(e.nombre)}</strong></td>
        <td style="font-size:11px;">${escapeHtml(e.email)}</td>
        <td>${e.telefono || "—"}</td>
        <td style="color:var(--jet-gray);font-size:11px;">${dt}</td>
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

  // ── Render: Today details ────────────────────────────────────────────────
  function renderToday() {
    $("#admin-today-date").textContent = todayStr();
    const list = $("#admin-today-list");
    list.innerHTML = "";
    if (!cache.turnosToday.length) {
      list.innerHTML = "<div style='text-align:center;color:var(--jet-gray);padding:20px;font-size:13px;'>Aún nadie ha fichado hoy</div>";
      return;
    }
    const tbl = document.createElement("table");
    tbl.className = "admin-table";
    tbl.innerHTML = "<thead><tr><th>Empleado</th><th>Punto</th><th>Entrada</th><th>Salida</th><th>Horas</th><th>Fotos</th></tr></thead>";
    const tb = document.createElement("tbody");
    cache.turnosToday.forEach(r => {
      const photos = [
        r.foto_entrada && `<a class="photo-link" href="${r.foto_entrada}" target="_blank">▶</a>`,
        r.foto_ini_desc && `<a class="photo-link" href="${r.foto_ini_desc}" target="_blank">🍴</a>`,
        r.foto_fin_desc && `<a class="photo-link" href="${r.foto_fin_desc}" target="_blank">↩</a>`,
        r.foto_salida && `<a class="photo-link" href="${r.foto_salida}" target="_blank">⏹</a>`,
      ].filter(Boolean).join(" ");
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${escapeHtml(r.empleado)}</td><td>${escapeHtml(r.punto || "")}</td><td>${r.entrada || "—"}</td><td>${r.salida || "—"}</td><td>${r.horas_trab || "—"}</td><td>${photos}</td>`;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    list.appendChild(tbl);
  }

  // ── Render: Period summary + by-employee breakdown ───────────────────────
  function renderPeriod() {
    const rows = cache.periodTurnos;

    // Summary
    let totalSec = 0, totalLunchSec = 0;
    const empMap = {};
    const days = new Set();
    rows.forEach(r => {
      const sec = parseHHMM(r.horas_trab);
      const lun = parseHHMM(r.horas_comida);
      totalSec += sec;
      totalLunchSec += lun;
      days.add(r.fecha);
      if (!empMap[r.empleado]) empMap[r.empleado] = { dias: 0, segs: 0, segsLunch: 0, turnos: 0 };
      empMap[r.empleado].turnos += 1;
      empMap[r.empleado].dias = (function() {
        // dias_unicos
        return Object.keys(empMap[r.empleado]._daySet || {}).length || 0;
      })();
      // track unique days per emp
      if (!empMap[r.empleado]._daySet) empMap[r.empleado]._daySet = {};
      empMap[r.empleado]._daySet[r.fecha] = true;
      empMap[r.empleado].dias = Object.keys(empMap[r.empleado]._daySet).length;
      empMap[r.empleado].segs += sec;
      empMap[r.empleado].segsLunch += lun;
    });

    const empCount = Object.keys(empMap).length;
    const summary = $("#period-summary");
    summary.innerHTML = `
      <div class="row"><span>Período</span><strong>${cache.periodFrom} → ${cache.periodTo}</strong></div>
      <div class="row"><span>Días con actividad</span><strong>${days.size}</strong></div>
      <div class="row"><span>Empleados que trabajaron</span><strong>${empCount}</strong></div>
      <div class="row"><span>Total turnos</span><strong>${rows.length}</strong></div>
      <div class="row"><span>Horas trabajadas total</span><strong>${fmtH(totalSec)}</strong></div>
      <div class="row"><span>Horas comida total</span><strong>${fmtH(totalLunchSec)}</strong></div>
    `;

    // By employee
    const byEmp = $("#period-by-emp");
    byEmp.innerHTML = "";
    const sorted = Object.keys(empMap).sort();
    if (!sorted.length) {
      byEmp.innerHTML = "<div style='text-align:center;color:var(--jet-gray);padding:20px;font-size:13px;'>Sin datos en este período</div>";
      return;
    }
    const tbl = document.createElement("table");
    tbl.className = "admin-table";
    tbl.innerHTML = "<thead><tr><th>Empleado</th><th>Días</th><th>Turnos</th><th>Horas comida</th><th>Horas trabajadas</th></tr></thead>";
    const tb = document.createElement("tbody");
    sorted.forEach(emp => {
      const t = empMap[emp];
      const tr = document.createElement("tr");
      tr.innerHTML = `<td><strong>${escapeHtml(emp)}</strong></td><td>${t.dias}</td><td>${t.turnos}</td><td>${fmtH(t.segsLunch)}</td><td><strong style="color:var(--jet-blue);">${fmtH(t.segs)}</strong></td>`;
      tb.appendChild(tr);
    });
    // Total row
    const totalTr = document.createElement("tr");
    totalTr.style.background = "var(--jet-blue-pale)";
    totalTr.style.fontWeight = "700";
    totalTr.innerHTML = `<td>TOTAL</td><td>${days.size}</td><td>${rows.length}</td><td>${fmtH(totalLunchSec)}</td><td style="color:var(--jet-blue);">${fmtH(totalSec)}</td>`;
    tb.appendChild(totalTr);
    tbl.appendChild(tb);
    byEmp.appendChild(tbl);
  }

  // ── Render: Active list ──────────────────────────────────────────────────
  function renderActive() {
    $("#admin-active-count").textContent = cache.empleados.length;
    const list = $("#admin-active-list");
    list.innerHTML = "";
    if (!cache.empleados.length) {
      list.innerHTML = "<div style='text-align:center;color:var(--jet-gray);padding:20px;font-size:13px;'>Sin empleados aprobados</div>";
      return;
    }
    cache.empleados.forEach(e => {
      const div = document.createElement("div");
      div.className = "week-row";
      div.innerHTML = `<span><strong>${escapeHtml(e.nombre)}</strong><br><small style="color:var(--jet-gray);font-size:11px;">${escapeHtml(e.email)}</small></span><span style="color:var(--jet-gray);font-size:12px;">${e.telefono || ""}</span>`;
      list.appendChild(div);
    });
  }

  // ── Approve / Reject ─────────────────────────────────────────────────────
  async function approveEmp(id) {
    showOverlay("Aprobando...");
    try {
      const userEmail = (await sb.auth.getUser()).data.user?.email || "admin";
      const { error } = await sb.from("empleados").update({
        activo: true,
        aprobado_at: new Date().toISOString(),
        aprobado_por: userEmail,
      }).eq("id", id);
      if (error) throw error;
      await load();
    } catch (e) {
      alert("Error: " + e.message);
    } finally {
      hideOverlay();
    }
  }

  async function rejectEmp(id) {
    if (!confirm("¿Rechazar y eliminar la solicitud?")) return;
    showOverlay("Rechazando...");
    try {
      const { error } = await sb.from("empleados").delete().eq("id", id);
      if (error) throw error;
      await load();
    } catch (e) {
      alert("Error: " + e.message);
    } finally {
      hideOverlay();
    }
  }

  // ── CSV Export ───────────────────────────────────────────────────────────
  function exportCSV() {
    if (!cache.periodTurnos.length) { alert("No hay datos para exportar"); return; }
    const headers = [
      "Fecha", "Empleado", "Punto", "Entrada", "Inicio descanso",
      "Fin descanso", "Salida", "Horas comida", "Horas trabajadas",
      "GPS entrada", "GPS salida"
    ];
    const rows = cache.periodTurnos.map(r => [
      r.fecha, r.empleado, r.punto || "",
      r.entrada || "", r.ini_descanso || "", r.fin_descanso || "", r.salida || "",
      r.horas_comida || "", r.horas_trab || "",
      r.gps_entrada || "", r.gps_salida || ""
    ]);

    // Compute totals row
    const totalSec = cache.periodTurnos.reduce((s, r) => s + parseHHMM(r.horas_trab), 0);
    rows.push([]);
    rows.push(["TOTAL", "", "", "", "", "", "", "", fmtHHMM(totalSec), "", ""]);

    const csv = [headers, ...rows].map(row =>
      row.map(cell => {
        const s = String(cell ?? "");
        return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(";")
    ).join("\r\n");

    const bom = "﻿"; // UTF-8 BOM для Excel
    const blob = new Blob([bom + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `JET_reporte_${cache.periodFrom}_${cache.periodTo}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, m => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[m]));
  }

  // ── Bind handlers ────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    const r = $("#btn-admin-refresh");
    if (r) r.addEventListener("click", load);
    $$(".period-tab").forEach(t => t.addEventListener("click", () => setPeriod(t.dataset.period)));
    const apply = $("#btn-period-apply");
    if (apply) apply.addEventListener("click", applyCustomPeriod);
    const exp = $("#btn-export-csv");
    if (exp) exp.addEventListener("click", exportCSV);

    // Default period inputs
    $("#period-from").value = dateOffset(7);
    $("#period-to").value = todayStr();
  });

  window.JETAdmin = { load };
})();
