-- Migration: filings table + storage bucket for the Partner Filing API
-- Run in Supabase SQL editor (or via supabase db push)

-- ── 1. filings table ─────────────────────────────────────────────────────────
create table if not exists public.filings (
  id            uuid primary key default gen_random_uuid(),
  partner_id    text not null,
  external_id   text not null,
  form_type     text not null check (form_type in ('5472_1120', '1065')),
  tax_year      integer not null,
  company_name  text not null,
  company_ein   text not null,
  signer_name   text,
  signer_title  text,
  signer_ip     text,
  pdf_path      text,
  fax_id        text,
  status        text not null default 'submitted'
                  check (status in ('submitted', 'faxed', 'accepted', 'rejected', 'pending')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- Unique constraint: one active filing per partner/external_id/form_type/tax_year
create unique index if not exists filings_dedup_idx
  on public.filings (partner_id, external_id, form_type, tax_year)
  where status in ('submitted', 'faxed', 'accepted');

-- Auto-update updated_at
create or replace function public.set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists filings_updated_at on public.filings;
create trigger filings_updated_at
  before update on public.filings
  for each row execute function public.set_updated_at();

-- RLS: service key only (partner API uses SUPABASE_SERVICE_KEY)
alter table public.filings enable row level security;

-- ── 2. Storage bucket ─────────────────────────────────────────────────────────
-- Create the 'filings' bucket (private — no public access)
insert into storage.buckets (id, name, public)
values ('filings', 'filings', false)
on conflict (id) do nothing;

-- Service role can read/write all objects
create policy "service_role_all" on storage.objects
  for all
  to service_role
  using (bucket_id = 'filings')
  with check (bucket_id = 'filings');
