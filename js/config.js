// ═══════════════════════════════════════════════════════════════════════
// JET — Configuración del cliente
// ═══════════════════════════════════════════════════════════════════════

window.JET_CONFIG = {
  // Supabase
  SUPABASE_URL: "https://erdbgzxzmezlhgworfvt.supabase.co",
  SUPABASE_KEY: "sb_publishable_0gQ_U-RW48hTNyL3XpMNrA_A24uw2pb",

  // Coordenadas reales de cada punto de trabajo
  // Obtener: Google Maps > clic derecho en el punto > los 2 números
  // radius en metros — distancia máxima permitida del punto exacto
  PARQUES: {
    "Parque el Reloj":          { lat: 25.6571, lng: -100.3897, radius: 200 },
    "Parque Avante":            { lat: 25.6480, lng: -100.3550, radius: 200 },
    "Parque Cerro San Antonio": { lat: 25.6340, lng: -100.3700, radius: 250 },
    "Anillo de Circunvalacion": { lat: 25.6600, lng: -100.3800, radius: 300 },
    "Av. Tlalpan":              { lat: 25.6700, lng: -100.3600, radius: 300 },
  },

  TIMEZONE: "America/Mexico_City",

  // Puestos (roles) de los empleados
  ROLES: {
    conductor:        { label: "Conductor",        icon: "🚗", color: "#005bff", bg: "#e3edff" },
    asist_logistica:  { label: "Asist. Logística", icon: "📦", color: "#7b1fa2", bg: "#f3e5f5" },
    seguridad:        { label: "Seguridad",        icon: "🛡", color: "#00875a", bg: "#e3f7e8" },
  },

  // Estados de un día en horarios
  SHIFT_STATUS: {
    scheduled: { label: "Programado", icon: "📌", color: "#005bff", bg: "#e3edff" },
    day_off:   { label: "Libre",      icon: "🌴", color: "#00875a", bg: "#e3f7e8" },
    absent:    { label: "Falta",      icon: "❌", color: "#c62828", bg: "#fde8e8" },
    sick:      { label: "Enfermo",    icon: "🤒", color: "#b07a00", bg: "#fff3cd" },
  },
};
