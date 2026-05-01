// ═══════════════════════════════════════════════════════════════════════
// JET — Configuración del cliente
// ═══════════════════════════════════════════════════════════════════════

window.JET_CONFIG = {
  // Supabase
  SUPABASE_URL: "https://erdbgzxzmezlhgworfvt.supabase.co",
  SUPABASE_KEY: "sb_publishable_0gQ_U-RW48hTNyL3XpMNrA_A24uw2pb",

  // Token de admin — generado automáticamente, guárdalo en lugar seguro
  ADMIN_TOKEN: "Xoslq3P4pXK5yZMYklCw_hbPlERd4-Bs",

  // Lista de empleados (editar para tu equipo real)
  EMPLEADOS: [
    "Juan Perez",
    "Maria Garcia",
    "Carlos Lopez",
  ],

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
};
