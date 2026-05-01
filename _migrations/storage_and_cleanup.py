"""Make storage private + add auto-cleanup of auth.users on empleado delete."""
import psycopg2

conn = psycopg2.connect(
    host="db.erdbgzxzmezlhgworfvt.supabase.co", port=5432,
    database="postgres", user="postgres", password="Wanton36.b.82", connect_timeout=20,
)
conn.autocommit = True
cur = conn.cursor()

steps = [
    # ── Make bucket private + signed URLs ──────────────────────────────────
    ("Make fotos bucket private", "update storage.buckets set public = false where id = 'fotos'"),

    # Drop old policies
    ("Drop old storage policies", """
        do $$ begin
          drop policy if exists "anon upload fotos" on storage.objects;
          drop policy if exists "anon read fotos" on storage.objects;
          drop policy if exists "auth upload fotos" on storage.objects;
          drop policy if exists "auth read fotos" on storage.objects;
        end $$
    """),

    # Authenticated can upload
    ("Storage: auth upload", """
        create policy "auth upload fotos" on storage.objects
        for insert to authenticated with check (bucket_id = 'fotos')
    """),

    # Authenticated can read all (signed URLs work for anyone but we keep auth check)
    ("Storage: auth read", """
        create policy "auth read fotos" on storage.objects
        for select to authenticated using (bucket_id = 'fotos')
    """),

    # ── Auto-delete auth.users when empleado deleted ───────────────────────
    ("Function: cleanup auth user on empleado delete", r"""
        create or replace function public.cleanup_auth_user_on_empleado_delete()
        returns trigger language plpgsql security definer
        as $$
        begin
          if old.auth_user_id is not null then
            delete from auth.users where id = old.auth_user_id;
          end if;
          return old;
        end $$;
    """),
    ("Trigger: cleanup auth on empleado delete", """
        drop trigger if exists trg_cleanup_auth on public.empleados;
        create trigger trg_cleanup_auth
        after delete on public.empleados
        for each row execute function public.cleanup_auth_user_on_empleado_delete();
    """),

    # ── Mexican LFT jornadas in policy_rules (для будущего Banco de Tiempo) ─
    ("policy_rules table", """
        create table if not exists public.policy_rules (
          key text primary key,
          value text not null,
          updated_at timestamptz default now()
        );
    """),
    ("Seed jornadas (Mexico LFT)", """
        insert into public.policy_rules (key, value) values
          ('jornada_diurna_minutes', '480'),
          ('jornada_mixta_minutes', '450'),
          ('jornada_nocturna_minutes', '420'),
          ('diurna_start_hour', '6'),
          ('diurna_end_hour', '20'),
          ('mult_overtime_normal', '1.0'),
          ('mult_overtime_double', '2.0'),
          ('mult_weekend', '1.5'),
          ('mult_holiday', '2.0'),
          ('max_bank_minutes', '2400'),
          ('expira_meses', '6')
        on conflict (key) do nothing;
    """),
]

for label, sql in steps:
    try:
        cur.execute(sql)
        print(f"OK: {label}")
    except Exception as e:
        print(f"FAIL {label}: {str(e)[:200]}")

cur.execute("select id, public from storage.buckets where id='fotos'")
b = cur.fetchone()
print(f"\nBucket 'fotos': public={b[1]}")

cur.close(); conn.close()
