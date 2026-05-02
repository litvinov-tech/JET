"use strict";
// JET Horarios — gestión de turnos planificados (admin) + lectura propia (empleado)

(function () {
  const { sb, $, $$, CFG } = window.JET;

  let mode = "week"; // "week" | "month"
  let anchor = startOfWeek(new Date()); // primer día del rango actual
  let empleados = [];
  let assignments = {}; // key "empleado_id|fecha" -> row
  let workedSet = {};   // key "empleado_id|fecha" -> turno (faktyczny)
  let modalCtx = null;  // { empleadoId, fecha }

  function startOfWeek(d) {
    const dd = new Date(d);
    const day = (dd.getDay() + 6) % 7; // 0 = lunes
    dd.setDate(dd.getDate() - day);
    dd.setHours(0, 0, 0, 0);
    return dd;
  }
  function startOfMonth(d) { const dd = new Date(d); dd.setDate(1); dd.setHours(0,0,0,0); return dd; }
  function dStr(d) { return d.toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE }); }
  function addDays(d, n) { const dd = new Date(d); dd.setDate(dd.getDate() + n); return dd; }
  function daysInRange() {
    if (mode === "week") return 7;
    const next = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    return Math.round((next - anchor) / 86400000);
  }
  function escapeHtml(s) {
    return String(s ?? "").replace(/[&<>"']/g, m => ({
      "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
    }[m]));
  }

  async function open() {
    const isAdmin = window.JETAdmin && (await sb.from("admins").select("email").eq("email", window.JETAdmin.getMyEmail()).maybeSingle()).data;
    // Si admin: cargamos todos. Si empleado: filtramos a sí mismo.
    if (isAdmin) {
      $("#hor-title").textContent = "Horarios";
      $("#hor-subtitle").textContent = "Gestión de turnos del equipo";
      $("#hor-copy-prev").style.display = "";
    } else {
      $("#hor-title").textContent = "Mi horario";
      $("#hor-subtitle").textContent = "Tus turnos asignados";
      $("#hor-copy-prev").style.display = "none";
    }
    await load();
    render();
  }

  async function load() {
    const start = new Date(anchor);
    const end = addDays(start, daysInRange() - 1);

    // 1. Empleados activos (con puesto)
    const { data: empData } = await sb.from("empleados")
      .select("id, nombre, puesto").eq("activo", true).order("nombre");
    empleados = empData || [];

    // 2. Assignments en el rango
    const { data: asgn } = await sb.from("shift_assignments")
      .select("*")
      .gte("fecha", dStr(start))
      .lte("fecha", dStr(end));
    assignments = {};
    (asgn || []).forEach(a => assignments[`${a.empleado_id}|${a.fecha}`] = a);

    // 3. Turnos reales en el rango (para mostrar "trabajado")
    const { data: turnos } = await sb.from("turnos")
      .select("empleado_id, entrada_at, salida_at, horas_trab_secs")
      .is("deleted_at", null)
      .gte("entrada_at", dStr(start) + "T00:00:00")
      .lte("entrada_at", dStr(end) + "T23:59:59");
    workedSet = {};
    (turnos || []).forEach(t => {
      const d = new Date(t.entrada_at).toLocaleDateString("en-CA", { timeZone: CFG.TIMEZONE });
      workedSet[`${t.empleado_id}|${d}`] = t;
    });
  }

  function render() {
    // Update range label
    const start = new Date(anchor);
    const end = addDays(start, daysInRange() - 1);
    $("#hor-range").textContent = mode === "week"
      ? `${start.toLocaleDateString("es-MX")} → ${end.toLocaleDateString("es-MX")}`
      : start.toLocaleDateString("es-MX", { month: "long", year: "numeric" });

    // Build table
    const grid = $("#hor-grid");
    const today = dStr(new Date());
    const tbl = document.createElement("table");
    tbl.className = "hor-table";

    // Header
    let thead = "<thead><tr><th>Empleado</th>";
    for (let i = 0; i < daysInRange(); i++) {
      const d = addDays(start, i);
      const ds = dStr(d);
      const dow = d.toLocaleDateString("es-MX", { weekday: "short", timeZone: CFG.TIMEZONE }).replace(".","");
      const num = d.getDate();
      const todayCls = ds === today ? " is-today" : "";
      thead += `<th class="${todayCls.trim()}">${dow}<br>${num}</th>`;
    }
    thead += "</tr></thead>";
    tbl.innerHTML = thead;

    // Body
    const tb = document.createElement("tbody");
    if (!empleados.length) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td class="empty" colspan="${daysInRange() + 1}" style="padding:24px;text-align:center;">Sin empleados activos</td>`;
      tb.appendChild(tr);
    }
    empleados.forEach(emp => {
      const tr = document.createElement("tr");
      const roleBadge = window.JETAdmin?.renderRoleBadge ? window.JETAdmin.renderRoleBadge(emp.puesto) : "";
      let row = `<td class="emp-cell" title="${escapeHtml(emp.nombre)}">${escapeHtml(emp.nombre)}${roleBadge}</td>`;
      for (let i = 0; i < daysInRange(); i++) {
        const d = addDays(start, i);
        const ds = dStr(d);
        const key = `${emp.id}|${ds}`;
        const a = assignments[key];
        const w = workedSet[key];
        const todayCol = ds === today ? " is-today-col" : "";
        let cls = "hor-cell" + todayCol;
        let content = "+";
        if (a) {
          cls += " is-" + a.status.replace("_","-");
          if (a.status === "scheduled") {
            content = `<span class="hc-time">${(a.hora_inicio||"").slice(0,5)}</span><span class="hc-status">→ ${(a.hora_fin||"").slice(0,5)}</span>`;
          } else {
            const st = CFG.SHIFT_STATUS[a.status];
            content = `<span class="hc-time">${st?.icon || ""}</span><span class="hc-status">${st?.label || ""}</span>`;
          }
        } else if (w) {
          cls += " is-worked";
          const hours = w.horas_trab_secs ? `${Math.floor(w.horas_trab_secs/3600)}h${String(Math.floor((w.horas_trab_secs%3600)/60)).padStart(2,"0")}` : "•";
          content = `<span class="hc-time">✓</span><span class="hc-status">${hours}</span>`;
        } else {
          cls += " empty";
        }
        row += `<td><div class="${cls}" data-emp="${emp.id}" data-fecha="${ds}">${content}</div></td>`;
      }
      tr.innerHTML = row;
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    grid.innerHTML = "";
    grid.appendChild(tbl);

    // Bind cell clicks (только для админов — RLS блокирует не-админов)
    grid.querySelectorAll(".hor-cell:not(.empty), .hor-cell.empty").forEach(c => {
      c.addEventListener("click", () => openModal(c.dataset.emp, c.dataset.fecha));
    });
  }

  // ── Modal ─────────────────────────────────────────────────────────────────
  function openModal(empleadoId, fecha) {
    const key = `${empleadoId}|${fecha}`;
    const existing = assignments[key];
    const emp = empleados.find(e => String(e.id) === String(empleadoId));
    if (!emp) return;
    modalCtx = { empleadoId: parseInt(empleadoId), fecha, existing };

    $("#hor-modal-title").textContent = `${emp.nombre} · ${fecha}`;
    const status = existing?.status || "scheduled";
    setStatus(status);
    $("#hor-modal-inicio").value = existing?.hora_inicio?.slice(0,5) || "07:00";
    $("#hor-modal-fin").value = existing?.hora_fin?.slice(0,5) || "15:00";
    $("#hor-modal-notas").value = existing?.notas || "";
    $("#hor-modal-clear").style.display = existing ? "" : "none";
    $("#hor-modal").classList.remove("hidden");
  }
  function closeModal() {
    $("#hor-modal").classList.add("hidden");
    modalCtx = null;
  }
  function setStatus(status) {
    $$(".hor-status-btn").forEach(b => b.classList.toggle("active", b.dataset.status === status));
    $("#hor-modal-times").style.display = status === "scheduled" ? "" : "none";
    $("#hor-modal-presets").style.display = status === "scheduled" ? "" : "none";
  }
  function getStatus() {
    return $$(".hor-status-btn").find(b => b.classList.contains("active"))?.dataset.status || "scheduled";
  }

  async function saveModal() {
    if (!modalCtx) return;
    const status = getStatus();
    const payload = {
      empleado_id: modalCtx.empleadoId,
      fecha: modalCtx.fecha,
      status,
      hora_inicio: status === "scheduled" ? $("#hor-modal-inicio").value : null,
      hora_fin: status === "scheduled" ? $("#hor-modal-fin").value : null,
      notas: $("#hor-modal-notas").value.trim() || null,
      created_by: window.JETAdmin?.getMyEmail() || "admin",
    };
    try {
      if (modalCtx.existing) {
        const { error } = await sb.from("shift_assignments")
          .update(payload).eq("id", modalCtx.existing.id);
        if (error) throw error;
      } else {
        const { error } = await sb.from("shift_assignments").insert(payload);
        if (error) throw error;
      }
      closeModal();
      await load();
      render();
    } catch (e) { alert("Error: " + e.message); }
  }

  async function clearModal() {
    if (!modalCtx?.existing) return;
    if (!confirm("¿Borrar este día?")) return;
    try {
      const { error } = await sb.from("shift_assignments").delete().eq("id", modalCtx.existing.id);
      if (error) throw error;
      closeModal();
      await load();
      render();
    } catch (e) { alert("Error: " + e.message); }
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  async function navPrev() {
    if (mode === "week") anchor = addDays(anchor, -7);
    else anchor = new Date(anchor.getFullYear(), anchor.getMonth() - 1, 1);
    await load(); render();
  }
  async function navNext() {
    if (mode === "week") anchor = addDays(anchor, 7);
    else anchor = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 1);
    await load(); render();
  }
  async function navToday() {
    anchor = mode === "week" ? startOfWeek(new Date()) : startOfMonth(new Date());
    await load(); render();
  }
  async function setMode(m) {
    mode = m;
    anchor = m === "week" ? startOfWeek(new Date(anchor)) : startOfMonth(new Date(anchor));
    $$(".hor-mode-tab").forEach(t => t.classList.toggle("active", t.dataset.mode === m));
    await load(); render();
  }

  // ── Copy previous week ────────────────────────────────────────────────────
  async function copyPrev() {
    if (mode !== "week") { alert("Sólo en vista semana"); return; }
    if (!confirm("Copiar la semana anterior a esta? (no sobrescribe días que ya tienen registro)")) return;
    const prevStart = addDays(anchor, -7);
    const { data } = await sb.from("shift_assignments")
      .select("empleado_id, status, hora_inicio, hora_fin, notas")
      .gte("fecha", dStr(prevStart))
      .lte("fecha", dStr(addDays(prevStart, 6)));
    if (!data || !data.length) { alert("La semana anterior está vacía"); return; }
    const inserts = [];
    data.forEach(r => {
      const origDate = new Date(prevStart);
      // figure offset by reading source row's fecha
    });
    // Re-fetch with fecha included
    const { data: full } = await sb.from("shift_assignments")
      .select("empleado_id, fecha, status, hora_inicio, hora_fin, notas")
      .gte("fecha", dStr(prevStart))
      .lte("fecha", dStr(addDays(prevStart, 6)));
    (full || []).forEach(r => {
      const orig = new Date(r.fecha);
      const newDate = addDays(orig, 7);
      inserts.push({
        empleado_id: r.empleado_id,
        fecha: dStr(newDate),
        status: r.status,
        hora_inicio: r.hora_inicio,
        hora_fin: r.hora_fin,
        notas: r.notas,
        created_by: window.JETAdmin?.getMyEmail() || "admin",
      });
    });
    let ok = 0, skip = 0;
    for (const ins of inserts) {
      const { error } = await sb.from("shift_assignments").insert(ins);
      if (error) {
        if (error.code === "23505") skip++;
        else { alert("Error: " + error.message); return; }
      } else ok++;
    }
    alert(`${ok} días copiados, ${skip} ya existían (no sobrescritos)`);
    await load(); render();
  }

  // ── Bind ──────────────────────────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", () => {
    $$(".hor-mode-tab").forEach(t => t.addEventListener("click", () => setMode(t.dataset.mode)));
    const prev = $("#hor-prev"); if (prev) prev.addEventListener("click", navPrev);
    const next = $("#hor-next"); if (next) next.addEventListener("click", navNext);
    const today = $("#hor-today"); if (today) today.addEventListener("click", navToday);
    const copy = $("#hor-copy-prev"); if (copy) copy.addEventListener("click", copyPrev);

    $$(".hor-status-btn").forEach(b => b.addEventListener("click", () => setStatus(b.dataset.status)));
    $$(".hor-preset").forEach(b => b.addEventListener("click", () => {
      $("#hor-modal-inicio").value = b.dataset.inicio;
      $("#hor-modal-fin").value = b.dataset.fin;
      $$(".hor-preset").forEach(x => x.classList.toggle("active", x === b));
    }));

    const cancel = $("#hor-modal-cancel"); if (cancel) cancel.addEventListener("click", closeModal);
    const save = $("#hor-modal-save"); if (save) save.addEventListener("click", saveModal);
    const clr = $("#hor-modal-clear"); if (clr) clr.addEventListener("click", clearModal);
    const modal = $("#hor-modal");
    if (modal) modal.addEventListener("click", e => { if (e.target === modal) closeModal(); });
  });

  window.JETHorarios = { open };
})();
