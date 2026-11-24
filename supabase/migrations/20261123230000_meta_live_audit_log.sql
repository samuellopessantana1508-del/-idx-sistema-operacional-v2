begin;

-- Registro de auditoria das otimizações feitas pelo sistema nas contas Meta.
-- Somente a função de servidor `meta-live` (service_role) grava; a equipe só lê.
create table if not exists public.meta_action_log (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clientes(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  user_email text,
  action text not null check (action in ('set_status', 'set_budget')),
  object_type text not null check (object_type in ('campaign', 'adset', 'ad')),
  object_id text not null,
  object_name text,
  before_value jsonb,
  after_value jsonb,
  ok boolean not null,
  error_message text,
  created_at timestamptz not null default now()
);

create index if not exists meta_action_log_client_idx
on public.meta_action_log (client_id, created_at desc);

alter table public.meta_action_log enable row level security;

drop policy if exists meta_action_log_read_member on public.meta_action_log;
create policy meta_action_log_read_member
on public.meta_action_log
for select
to authenticated
using (private.is_idx_member());

revoke all on public.meta_action_log from anon, authenticated;
grant select on public.meta_action_log to authenticated;

commit;
