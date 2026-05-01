"""Apply RPC functions to Supabase Postgres."""
import psycopg2

conn = psycopg2.connect(
    host="db.erdbgzxzmezlhgworfvt.supabase.co",
    port=5432, database="postgres", user="postgres",
    password="Wanton36.b.82", connect_timeout=20,
)
conn.autocommit = True
cur = conn.cursor()

rpcs = []

rpcs.append(("fn_my_empleado_id", r"""
create or replace function public.my_empleado_id()
returns bigint language plpgsql security definer
as $$
declare v_id bigint;
begin
  select id into v_id from public.empleados where auth_user_id = auth.uid() and activo = true;
  if v_id is null then raise exception 'No tienes cuenta activa'; end if;
  return v_id;
end $$;
"""))

rpcs.append(("fn_is_admin", r"""
create or replace function public.is_admin()
returns boolean language sql security definer stable
as $$
  select exists(select 1 from public.admins where email = (auth.jwt() ->> 'email'))
$$;
"""))

rpcs.append(("fn_start_shift", r"""
create or replace function public.start_shift(
  p_punto text, p_foto_url text, p_lat double precision, p_lng double precision
) returns json language plpgsql security definer
as $$
declare v_emp_id bigint; v_active_id bigint; v_new_id bigint;
begin
  v_emp_id := public.my_empleado_id();
  select id into v_active_id from public.turnos where empleado_id = v_emp_id and salida_at is null limit 1;
  if v_active_id is not null then
    raise exception 'Ya tienes un turno activo. Ciérralo primero.';
  end if;
  insert into public.turnos (empleado_id, punto, entrada_at, foto_entrada, gps_entrada)
    values (v_emp_id, p_punto, now(), p_foto_url, p_lat::text || ',' || p_lng::text)
    returning id into v_new_id;
  return json_build_object('ok', true, 'turno_id', v_new_id, 'entrada_at', now());
end $$;
"""))

rpcs.append(("fn_start_lunch", r"""
create or replace function public.start_lunch(p_foto_url text)
returns json language plpgsql security definer
as $$
declare v_emp_id bigint; v_turno record;
begin
  v_emp_id := public.my_empleado_id();
  select * into v_turno from public.turnos where empleado_id = v_emp_id and salida_at is null
                                                                    order by entrada_at desc limit 1;
  if v_turno is null then raise exception 'No hay turno activo'; end if;
  if v_turno.ini_descanso_at is not null then raise exception 'Descanso ya iniciado'; end if;
  update public.turnos set ini_descanso_at = now(), foto_ini_desc = p_foto_url where id = v_turno.id;
  return json_build_object('ok', true, 'time', now());
end $$;
"""))

rpcs.append(("fn_end_lunch", r"""
create or replace function public.end_lunch(p_foto_url text)
returns json language plpgsql security definer
as $$
declare v_emp_id bigint; v_turno record;
begin
  v_emp_id := public.my_empleado_id();
  select * into v_turno from public.turnos where empleado_id = v_emp_id and salida_at is null
                                                                    order by entrada_at desc limit 1;
  if v_turno is null then raise exception 'No hay turno activo'; end if;
  if v_turno.ini_descanso_at is null then raise exception 'No iniciaste descanso'; end if;
  if v_turno.fin_descanso_at is not null then raise exception 'Descanso ya cerrado'; end if;
  update public.turnos set fin_descanso_at = now(), foto_fin_desc = p_foto_url where id = v_turno.id;
  return json_build_object('ok', true, 'time', now());
end $$;
"""))

rpcs.append(("fn_end_shift", r"""
create or replace function public.end_shift(
  p_foto_url text, p_lat double precision, p_lng double precision
) returns json language plpgsql security definer
as $$
declare
  v_emp_id bigint; v_turno record;
  v_now timestamptz := now();
  v_total_secs int; v_lunch_secs int; v_work_secs int;
begin
  v_emp_id := public.my_empleado_id();
  select * into v_turno from public.turnos where empleado_id = v_emp_id and salida_at is null
                                                                    order by entrada_at desc limit 1;
  if v_turno is null then raise exception 'No hay turno activo'; end if;
  v_total_secs := extract(epoch from (v_now - v_turno.entrada_at))::int;
  if v_turno.ini_descanso_at is not null and v_turno.fin_descanso_at is not null then
    v_lunch_secs := extract(epoch from (v_turno.fin_descanso_at - v_turno.ini_descanso_at))::int;
  else
    v_lunch_secs := 0;
  end if;
  v_work_secs := v_total_secs - v_lunch_secs;
  update public.turnos set
    salida_at = v_now, foto_salida = p_foto_url,
    gps_salida = p_lat::text || ',' || p_lng::text,
    horas_comida_secs = v_lunch_secs, horas_trab_secs = v_work_secs
  where id = v_turno.id;
  return json_build_object('ok', true, 'time', v_now,
                           'work_secs', v_work_secs, 'lunch_secs', v_lunch_secs);
end $$;
"""))

rpcs.append(("fn_request_correction", r"""
create or replace function public.request_correction(
  p_turno_id bigint, p_fecha date, p_tipo text, p_field_name text,
  p_proposed_time timestamptz, p_motivo text
) returns json language plpgsql security definer
as $$
declare v_emp_id bigint; v_req_id bigint;
begin
  v_emp_id := public.my_empleado_id();
  if length(coalesce(p_motivo, '')) < 5 then
    raise exception 'Motivo demasiado corto (mín. 5 caracteres)';
  end if;
  insert into public.correction_requests
    (empleado_id, turno_id, fecha, tipo, field_name, proposed_time, motivo)
    values (v_emp_id, p_turno_id, p_fecha, p_tipo, p_field_name, p_proposed_time, p_motivo)
    returning id into v_req_id;
  return json_build_object('ok', true, 'request_id', v_req_id);
end $$;
"""))

rpcs.append(("fn_approve_correction", r"""
create or replace function public.approve_correction(p_req_id bigint, p_admin_note text default null)
returns json language plpgsql security definer
as $$
declare v_req record; v_admin_email text;
begin
  if not public.is_admin() then raise exception 'Solo admin'; end if;
  v_admin_email := auth.jwt() ->> 'email';
  select * into v_req from public.correction_requests where id = p_req_id and status = 'pending' for update;
  if v_req is null then raise exception 'Solicitud no encontrada o ya resuelta'; end if;

  if v_req.turno_id is not null and v_req.field_name is not null and v_req.proposed_time is not null then
    execute format('update public.turnos set %I = $1, source = ''manual_correction'' where id = $2',
                   v_req.field_name) using v_req.proposed_time, v_req.turno_id;
    update public.turnos t set
      horas_comida_secs = case
        when t.ini_descanso_at is not null and t.fin_descanso_at is not null
        then extract(epoch from (t.fin_descanso_at - t.ini_descanso_at))::int else 0 end,
      horas_trab_secs = case
        when t.salida_at is not null
        then extract(epoch from (t.salida_at - t.entrada_at))::int -
             case when t.ini_descanso_at is not null and t.fin_descanso_at is not null
                  then extract(epoch from (t.fin_descanso_at - t.ini_descanso_at))::int else 0 end
        else null end
      where id = v_req.turno_id;
  end if;

  update public.correction_requests set
    status = 'approved', admin_email = v_admin_email, admin_note = p_admin_note,
    resolved_at = now()
  where id = p_req_id;
  return json_build_object('ok', true);
end $$;
"""))

rpcs.append(("fn_reject_correction", r"""
create or replace function public.reject_correction(p_req_id bigint, p_admin_note text default null)
returns json language plpgsql security definer
as $$
declare v_admin_email text;
begin
  if not public.is_admin() then raise exception 'Solo admin'; end if;
  v_admin_email := auth.jwt() ->> 'email';
  update public.correction_requests set
    status = 'rejected', admin_email = v_admin_email, admin_note = p_admin_note,
    resolved_at = now()
  where id = p_req_id and status = 'pending';
  if not found then raise exception 'Solicitud no encontrada o ya resuelta'; end if;
  return json_build_object('ok', true);
end $$;
"""))

rpcs.append(("Grant RPC perms", """
grant execute on function public.start_shift(text,text,double precision,double precision) to authenticated;
grant execute on function public.start_lunch(text) to authenticated;
grant execute on function public.end_lunch(text) to authenticated;
grant execute on function public.end_shift(text,double precision,double precision) to authenticated;
grant execute on function public.request_correction(bigint,date,text,text,timestamptz,text) to authenticated;
grant execute on function public.approve_correction(bigint,text) to authenticated;
grant execute on function public.reject_correction(bigint,text) to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.my_empleado_id() to authenticated;
"""))

for label, sql in rpcs:
    try:
        cur.execute(sql)
        print(f"OK: {label}")
    except Exception as e:
        print(f"FAIL {label}: {str(e)[:200]}")

# List all RPCs
cur.execute("""
  select p.proname, pg_get_function_arguments(p.oid) as args
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname = 'public' and p.proname in
    ('my_empleado_id','is_admin','start_shift','start_lunch','end_lunch','end_shift',
     'request_correction','approve_correction','reject_correction')
  order by p.proname
""")
print("\n=== Public RPC functions ===")
for r in cur.fetchall(): print(f"  - {r[0]}({r[1]})")

cur.close(); conn.close()
