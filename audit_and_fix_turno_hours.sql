-- JET: audit and repair stored turno hour totals from source timestamps.
-- Scope: closed, non-deleted turnos only.
-- Review the first SELECT before committing if you run this manually.

begin;

create temp table _bad_turno_hours as
with computed as (
  select
    t.id,
    t.empleado_id,
    e.nombre,
    t.entrada_at,
    t.ini_descanso_at,
    t.fin_descanso_at,
    t.salida_at,
    coalesce(t.horas_comida_secs, 0) as stored_lunch_secs,
    coalesce(t.horas_trab_secs, 0) as stored_work_secs,
    case
      when t.ini_descanso_at is not null and t.fin_descanso_at is not null and t.fin_descanso_at >= t.ini_descanso_at
        then greatest(0, extract(epoch from (t.fin_descanso_at - t.ini_descanso_at))::int)
      else 0
    end as computed_lunch_secs,
    greatest(
      0,
      extract(epoch from (t.salida_at - t.entrada_at))::int
      - case
          when t.ini_descanso_at is not null and t.fin_descanso_at is not null and t.fin_descanso_at >= t.ini_descanso_at
            then greatest(0, extract(epoch from (t.fin_descanso_at - t.ini_descanso_at))::int)
          else 0
        end
    ) as computed_work_secs
  from public.turnos t
  left join public.empleados e on e.id = t.empleado_id
  where t.deleted_at is null
    and t.entrada_at is not null
    and t.salida_at is not null
    and t.salida_at >= t.entrada_at
)
select *
from computed
where stored_work_secs > 16 * 3600
   or abs(stored_work_secs - computed_work_secs) > 5 * 60
   or abs(stored_lunch_secs - computed_lunch_secs) > 5 * 60;

select
  id,
  nombre,
  entrada_at,
  salida_at,
  stored_lunch_secs,
  computed_lunch_secs,
  stored_work_secs,
  computed_work_secs
from _bad_turno_hours
order by entrada_at desc;

update public.turnos t
set
  horas_comida_secs = b.computed_lunch_secs,
  horas_trab_secs = b.computed_work_secs
from _bad_turno_hours b
where t.id = b.id;

select count(*) as repaired_turnos from _bad_turno_hours;

commit;
