-- Cole tudo isto no SQL Editor do Supabase e clique em Run.
-- Cria a tabela onde o painel guarda o seu progresso. Cada usuário só vê e altera as próprias linhas.

create table if not exists public.docs (
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  col text not null,
  id text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, col, id)
);

alter table public.docs enable row level security;

drop policy if exists "ler os proprios" on public.docs;
drop policy if exists "inserir os proprios" on public.docs;
drop policy if exists "alterar os proprios" on public.docs;
drop policy if exists "apagar os proprios" on public.docs;

create policy "ler os proprios" on public.docs for select using (auth.uid() = user_id);
create policy "inserir os proprios" on public.docs for insert with check (auth.uid() = user_id);
create policy "alterar os proprios" on public.docs for update using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy "apagar os proprios" on public.docs for delete using (auth.uid() = user_id);

-- Atualização ao vivo entre celular e computador.
alter table public.docs replica identity full;
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'docs'
  ) then
    alter publication supabase_realtime add table public.docs;
  end if;
end $$;
