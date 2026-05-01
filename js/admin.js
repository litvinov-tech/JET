"use strict";
// JET Admin module — depends on window.JET (set in app.js)

(function () {
  const { sb, $, $$, CFG } = window.JET;

  function todayStr() { return new Date().toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE }); }
  function getMondayStr() {
    const d = new Date();
    const day = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - day);
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

  function showOverlay(t) { $("#overlay-text").textContent = t || "Cargando..."; $("#overlay").classList.remove("hidden"); }
  function hideOverlay() { $("#overlay").classList.add("hidden"); }

  async function load() {
    showOverlay();
    try {
      const today = todayStr();
      const monday = getMondayStr();

      const { data: pending } = await sb.from("empleados")
        .select("id, nombre, telefono, created_at")
        .eq("activo", false)
        .order("created_at", { ascending: false });

      const { data: active } = await sb.from("empleados")
        .select("id, nombre, telefono")
        .eq("activo", true)
        .order("nombre");

      const { data: todayRows } = await sb.from("turnos")
        .select("*")
        .eq("fecha", today)
        .order("entrada", { ascending: true });

      const { data: weekRows } = await sb.from("turnos")
        .select("empleado, fecha, horas_trab")
        .gte("fecha", monday);

      render({
        pending: pending || [], active: active || [],
        today: todayRows || [], week: weekRows || [],
        todayStr: today, mondayStr: monday,
      });
    } catch (e) {
      alert("Error cargando admin: " + e.message);
    } finally {
      hideOverlay();
    }
  }

  function render(d) {
    // Pending registrations
    const pendingCard = $("#admin-pending-card");
    $("#admin-pending-count").textContent = d.pending.length;
    if (d.pending.length === 0) {
      pendingCard.style.display = "none";
    } else {
      pendingCard.style.display = "block";
      const list = $("#admin-pending-list");
      list.innerHTML = "";
      const tbl = document.createElement("table");
      tbl.className = "admin-table";
      tbl.innerHTML = "<thead><tr><th>Nombre</th><th>Teléfono</th><th>Solicitado</th><th></th></tr></thead>";
      const tb = document.createElement("tbody");
      d.pending.forEach(e => {
        const tr = document.createElement("tr");
        const dt = new Date(e.created_at).toLocaleString("es-MX", { timeZone: CFG.TIMEZONE, dateStyle: "short", timeStyle: "short" });
        tr.innerHTML = `
          <td><strong>${e.nombre}</strong></td>
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

    // Today
    $("#admin-today-date").textContent = d.todayStr;
    const todayList = $("#admin-today-list");
    todayList.innerHTML = "";
    if (!d.today.length) {
      todayList.innerHTML = "<div style='text-align:center;color:var(--jet-gray);padding:20px;font-size:13px;'>Aún nadie ha fichado hoy</div>";
    } else {
      const tbl = document.createElement("table");
      tbl.className = "admin-table";
      tbl.innerHTML = "<thead><tr><th>Empleado</th><th>Punto</th><th>Entrada</th><th>Salida</th><th>Horas</th><th>Fotos</th></tr></thead>";
      const tb = document.createElement("tbody");
      d.today.forEach(r => {
        const photos = [
          r.foto_entrada && `<a class="photo-link" href="${r.foto_entrada}" target="_blank">▶</a>`,
          r.foto_ini_desc && `<a class="photo-link" href="${r.foto_ini_desc}" target="_blank">🍴</a>`,
          r.foto_fin_desc && `<a class="photo-link" href="${r.foto_fin_desc}" target="_blank">↩</a>`,
          r.foto_salida && `<a class="photo-link" href="${r.foto_salida}" target="_blank">⏹</a>`,
        ].filter(Boolean).join(" ");
        const tr = document.createElement("tr");
        tr.innerHTML = `<td>${r.empleado}</td><td>${r.punto}</td><td>${r.entrada || "—"}</td><td>${r.salida || "—"}</td><td>${r.horas_trab || "—"}</td><td>${photos}</td>`;
        tb.appendChild(tr);
      });
      tbl.appendChild(tb);
      todayList.appendChild(tbl);
    }

    // Week summary
    $("#admin-week-since").textContent = "desde " + d.mondayStr;
    const totals = {};
    d.week.forEach(r => {
      if (!totals[r.empleado]) totals[r.empleado] = { dias: 0, segs: 0 };
      totals[r.empleado].dias++;
      totals[r.empleado].segs += parseHHMM(r.horas_trab);
    });
    const weekList = $("#admin-week-list");
    weekList.innerHTML = "";
    const sorted = Object.keys(totals).sort();
    if (!sorted.length) {
      weekList.innerHTML = "<div style='text-align:center;color:var(--jet-gray);padding:20px;font-size:13px;'>Sin datos esta semana</div>";
    } else {
      sorted.forEach(emp => {
        const t = totals[emp];
        const div = document.createElement("div");
        div.className = "week-row";
        div.innerHTML = `<span>${emp}</span><span><strong>${fmtH(t.segs)}</strong> · ${t.dias} días</span>`;
        weekList.appendChild(div);
      });
    }

    // Active employees
    $("#admin-active-count").textContent = d.active.length;
    const activeList = $("#admin-active-list");
    activeList.innerHTML = "";
    if (!d.active.length) {
      activeList.innerHTML = "<div style='text-align:center;color:var(--jet-gray);padding:20px;font-size:13px;'>Sin empleados aún</div>";
    } else {
      d.active.forEach(e => {
        const div = document.createElement("div");
        div.className = "week-row";
        div.innerHTML = `<span>${e.nombre}</span><span style="color:var(--jet-gray);font-size:12px;">${e.telefono || ""}</span>`;
        activeList.appendChild(div);
      });
    }
  }

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
    if (!confirm("¿Eliminar esta solicitud?")) return;
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

  document.addEventListener("DOMContentLoaded", () => {
    const r = $("#btn-admin-refresh");
    if (r) r.addEventListener("click", load);
  });

  window.JETAdmin = { load };
})();
