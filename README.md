# JET — Sistema de Asistencia

Web app para registro de asistencia con verificación GPS y foto.

**Stack:** GitHub Pages (frontend) + Supabase (DB + storage). Sin servidor propio.

## Estructura

- `index.html` — pantalla del empleado
- `admin.html` — panel de admin
- `css/styles.css` — estilos
- `js/config.js` — URL, key, lista de empleados, coordenadas de parques
- `js/app.js` — lógica del cliente

## Setup paso a paso

### 1. Configurar Supabase

#### a) Crear proyecto

1. [supabase.com](https://supabase.com) → Sign in con GitHub
2. **New project** → nombre `jet-asistencia` → región más cercana
3. Espera ~2 min mientras se crea

#### b) Crear tabla — SQL Editor → New query → pegar y Run:

```sql
create table public.turnos (
  id              bigserial primary key,
  empleado        text not null,
  fecha           date not null,
  punto           text not null,
  entrada         time,
  foto_entrada    text,
  ini_descanso    time,
  foto_ini_desc   text,
  fin_descanso    time,
  foto_fin_desc   text,
  salida          time,
  foto_salida     text,
  gps_entrada     text,
  gps_salida      text,
  horas_comida    text,
  horas_trab      text,
  created_at      timestamptz default now(),
  unique (empleado, fecha)
);
create index idx_turnos_empleado_fecha on public.turnos (empleado, fecha desc);

alter table public.turnos enable row level security;
create policy "anon insert turnos" on public.turnos for insert to anon with check (true);
create policy "anon select turnos" on public.turnos for select to anon using (true);
create policy "anon update turnos" on public.turnos for update to anon using (true) with check (true);
```

#### c) Crear bucket de fotos

1. **Storage** → **New bucket** → nombre `fotos` → **Public bucket: ON** → Create

#### d) Permitir subir/leer fotos — SQL Editor:

```sql
create policy "anon upload fotos" on storage.objects
  for insert to anon with check (bucket_id = 'fotos');
create policy "anon read fotos" on storage.objects
  for select to anon using (bucket_id = 'fotos');
```

### 2. Editar `js/config.js`

```javascript
window.JET_CONFIG = {
  SUPABASE_URL: "https://erdbgzxzmezlhgworfvt.supabase.co",  // ← ya está
  SUPABASE_KEY: "sb_publishable_...",                          // ← ya está
  ADMIN_TOKEN: "cambiar_a_algo_secreto",                       // ← ¡cambiar!
  EMPLEADOS: [ "Juan Perez", ... ],                            // ← editar lista real
  PARQUES: {
    "Parque el Reloj": { lat: 25.6571, lng: -100.3897, radius: 200 },
    // ← editar coordenadas reales
  },
  TIMEZONE: "America/Mexico_City",
};
```

#### Cómo obtener coordenadas reales

1. Google Maps → buscar el parque
2. Botón derecho sobre el punto exacto → aparecen 2 números
3. Primer número = `lat`, segundo = `lng`
4. `radius` en metros: tolerancia (200-300m está bien)

### 3. Subir a GitHub

```bash
cd C:\Users\faxfa\jet-asistencia
git init
git add .
git commit -m "Initial JET Asistencia"
git branch -M main
git remote add origin https://github.com/TU-USUARIO/jet-asistencia.git
git push -u origin main
```

(Antes crea repo vacío en github.com llamado `jet-asistencia`)

GitHub: **Settings → Pages → Branch: `main` / `(root)` → Save**.

### 4. URLs finales

- Empleados: `https://TU-USUARIO.github.io/jet-asistencia/`
- Admin:     `https://TU-USUARIO.github.io/jet-asistencia/admin.html`

## Cómo funciona

### Empleado
1. Abre el sitio en el móvil
2. Selecciona su nombre y punto de trabajo (1 vez, se guarda en localStorage)
3. Pulsa "Iniciar turno" → permite cámara + GPS → selfie automático
4. Si está lejos del parque → la app rechaza con mensaje "Estás a Xm de Y"
5. A lo largo del día: "Iniciar descanso" / "Volver al trabajo" / "Cerrar turno"

### Admin
1. Abre `/admin.html`
2. Ingresa el `ADMIN_TOKEN` de `config.js`
3. Ve la tabla de hoy (quién, cuándo, fotos) + resumen semanal por empleado

## Esquema de datos

Tabla `turnos` — 1 fila = 1 turno (1 día por empleado):

| Columna | Tipo | Cuándo se llena |
|---|---|---|
| `empleado`, `fecha`, `punto` | text/date | Al iniciar turno |
| `entrada`, `foto_entrada`, `gps_entrada` | time/text | Al iniciar turno |
| `ini_descanso`, `foto_ini_desc` | time/text | Al iniciar descanso |
| `fin_descanso`, `foto_fin_desc` | time/text | Al volver del descanso |
| `salida`, `foto_salida`, `gps_salida` | time/text | Al cerrar turno |
| `horas_comida`, `horas_trab` | text | Calculadas al cerrar turno |

`unique (empleado, fecha)` previene duplicados — un empleado solo puede tener 1 turno por día.

## Mantenimiento

- **Añadir empleado**: editar `EMPLEADOS` en `config.js` → commit → push
- **Cambiar coordenadas**: editar `PARQUES` en `config.js` → commit → push
- **Cambiar token admin**: editar `ADMIN_TOKEN` en `config.js` → commit → push
- **Ver datos crudos**: en Supabase → Table Editor → tabla `turnos`
- **Borrar registros**: en Supabase Table Editor o vía SQL

## Limitaciones conocidas

- Validación GPS es client-side (sotworek puede mentir editando JS) — pero foto + coords reales se guardan en DB, así que admin puede revisar
- Sin GPS, app rechaza la operación (es por diseño)
- La key publishable en config.js es expuesta — esto está bien por diseño de Supabase, pero verifica que las RLS policies estén bien
- Free tier de Supabase: 500MB DB + 1GB storage = ~5000 turnos con foto

## Seguridad

- Las fotos quedan en bucket público — cualquiera con la URL puede verlas. Si quieres acceso restringido, cambia bucket a privado y usa signed URLs.
- El `ADMIN_TOKEN` es chequeado solo en cliente (vía config.js). Para seguridad real, agrega autenticación de Supabase (en próxima versión).
