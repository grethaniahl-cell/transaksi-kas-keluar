-- Jalankan pada Supabase SQL Editor. Gunakan publishable key pada frontend,
-- jangan pernah menggunakan service_role key di browser.

create extension if not exists pgcrypto;

create table if not exists public.chart_of_accounts (
  id uuid primary key default gen_random_uuid(),
  account_code text not null unique,
  account_name text not null,
  normal_balance text not null check (normal_balance in ('debit', 'credit')),
  report_classification text not null check (
    report_classification in ('asset', 'liability', 'equity', 'revenue', 'expense')
  ),
  created_at timestamptz not null default now()
);

create table if not exists public.journal_headers (
  id uuid primary key default gen_random_uuid(),
  transaction_date date not null,
  reference_number text not null unique,
  description text not null,
  status_posting text not null default 'draft' check (status_posting in ('draft', 'posted')),
  reverses_header_id uuid references public.journal_headers(id) on delete restrict,
  created_at timestamptz not null default now()
);

alter table public.journal_headers
  add column if not exists reverses_header_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'journal_headers_reverses_header_id_fkey'
      and conrelid = 'public.journal_headers'::regclass
  ) then
    alter table public.journal_headers
      add constraint journal_headers_reverses_header_id_fkey
      foreign key (reverses_header_id)
      references public.journal_headers(id)
      on delete restrict;
  end if;
end;
$$;

create unique index if not exists journal_headers_one_reversal_per_source
  on public.journal_headers (reverses_header_id)
  where reverses_header_id is not null;

create table if not exists public.journal_lines (
  id uuid primary key default gen_random_uuid(),
  header_id uuid not null references public.journal_headers(id) on delete restrict,
  account_id uuid not null references public.chart_of_accounts(id) on delete restrict,
  debit numeric(18, 2) not null default 0 check (debit >= 0),
  credit numeric(18, 2) not null default 0 check (credit >= 0),
  check (debit > 0 or credit > 0)
);

create or replace function public.prevent_posted_journal_header_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.status_posting = 'posted' then
    raise exception 'Jurnal POSTED tidak dapat diubah atau dihapus. Buat jurnal pembalik (storno).'
      using errcode = '55000';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create or replace function public.prevent_posted_journal_line_mutation()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  header_status text;
begin
  if tg_op <> 'INSERT' then
    select jh.status_posting into header_status
    from public.journal_headers as jh
    where jh.id = old.header_id
    for update;

    if header_status = 'posted' then
      raise exception 'Baris jurnal POSTED tidak dapat diubah atau dihapus. Buat jurnal pembalik (storno).'
        using errcode = '55000';
    end if;
  end if;

  if tg_op <> 'DELETE' then
    select jh.status_posting into header_status
    from public.journal_headers as jh
    where jh.id = new.header_id
    for update;

    if header_status = 'posted' then
      raise exception 'Baris tidak dapat ditambahkan ke jurnal POSTED.'
        using errcode = '55000';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

drop trigger if exists journal_headers_posted_immutable on public.journal_headers;
create trigger journal_headers_posted_immutable
  before update or delete on public.journal_headers
  for each row execute function public.prevent_posted_journal_header_mutation();

drop trigger if exists journal_lines_posted_immutable on public.journal_lines;
create trigger journal_lines_posted_immutable
  before insert or update or delete on public.journal_lines
  for each row execute function public.prevent_posted_journal_line_mutation();

create or replace function public.assert_journal_is_balanced(p_header_id uuid)
returns void
language plpgsql
set search_path = ''
as $$
declare
  journal_status text;
  debit_total numeric;
  credit_total numeric;
  line_count bigint;
begin
  select jh.status_posting
  into journal_status
  from public.journal_headers as jh
  where jh.id = p_header_id;

  if not found or journal_status <> 'posted' then
    return;
  end if;

  select count(*), coalesce(sum(jl.debit), 0), coalesce(sum(jl.credit), 0)
  into line_count, debit_total, credit_total
  from public.journal_lines as jl
  where jl.header_id = p_header_id;

  if line_count = 0 then
    raise exception 'Jurnal POSTED harus memiliki minimal satu baris.'
      using errcode = '23514', constraint = 'journal_must_have_lines';
  end if;

  if debit_total <> credit_total then
    raise exception 'Jurnal % tidak seimbang: total debit %, total kredit %.',
      p_header_id, debit_total, credit_total
      using errcode = '23514', constraint = 'journal_must_balance';
  end if;
end;
$$;

create or replace function public.enforce_journal_balance()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'journal_headers' then
    perform public.assert_journal_is_balanced(new.id);
  elsif tg_op = 'INSERT' then
    perform public.assert_journal_is_balanced(new.header_id);
  elsif tg_op = 'DELETE' then
    perform public.assert_journal_is_balanced(old.header_id);
  else
    perform public.assert_journal_is_balanced(old.header_id);
    if new.header_id is distinct from old.header_id then
      perform public.assert_journal_is_balanced(new.header_id);
    end if;
  end if;
  return null;
end;
$$;

drop trigger if exists journal_headers_balance_check on public.journal_headers;
create constraint trigger journal_headers_balance_check
  after insert or update on public.journal_headers
  deferrable initially deferred
  for each row execute function public.enforce_journal_balance();

drop trigger if exists journal_lines_balance_check on public.journal_lines;
create constraint trigger journal_lines_balance_check
  after insert or update or delete on public.journal_lines
  deferrable initially deferred
  for each row execute function public.enforce_journal_balance();

create or replace function public.create_journal_entry(
  p_transaction_date date,
  p_reference_number text,
  p_description text,
  p_lines jsonb
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  new_header_id uuid;
  line_item jsonb;
  line_account_id uuid;
  line_debit numeric;
  line_credit numeric;
  debit_total numeric := 0;
  credit_total numeric := 0;
  line_count integer;
begin
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Baris jurnal harus dikirim sebagai daftar.';
  end if;
  line_count := jsonb_array_length(p_lines);
  if line_count < 2 then
    raise exception 'Jurnal harus memiliki minimal dua baris.';
  end if;

  for line_item in select value from jsonb_array_elements(p_lines)
  loop
    line_account_id := nullif(line_item->>'account_id', '')::uuid;
    line_debit := coalesce(nullif(line_item->>'debit', '')::numeric, 0);
    line_credit := coalesce(nullif(line_item->>'credit', '')::numeric, 0);

    if line_account_id is null then
      raise exception 'Setiap baris jurnal harus memiliki akun.';
    end if;
    if line_debit < 0 or line_credit < 0 then
      raise exception 'Nominal debit dan kredit tidak boleh negatif.';
    end if;
    if round(line_debit, 2) <> line_debit or round(line_credit, 2) <> line_credit then
      raise exception 'Nominal debit dan kredit maksimal memiliki dua angka desimal.';
    end if;
    if (line_debit > 0) = (line_credit > 0) then
      raise exception 'Setiap baris harus mengisi debit atau kredit, tetapi tidak keduanya.';
    end if;

    debit_total := debit_total + line_debit;
    credit_total := credit_total + line_credit;
  end loop;

  if debit_total = 0 or debit_total <> credit_total then
    raise exception 'Jurnal tidak balance: total debit %, total kredit %.',
      debit_total, credit_total
      using errcode = '23514', constraint = 'journal_must_balance';
  end if;

  insert into public.journal_headers (
    transaction_date, reference_number, description, status_posting
  ) values (
    p_transaction_date, p_reference_number, p_description, 'draft'
  ) returning id into new_header_id;

  for line_item in select value from jsonb_array_elements(p_lines)
  loop
    insert into public.journal_lines (header_id, account_id, debit, credit)
    values (
      new_header_id,
      (line_item->>'account_id')::uuid,
      coalesce(nullif(line_item->>'debit', '')::numeric, 0),
      coalesce(nullif(line_item->>'credit', '')::numeric, 0)
    );
  end loop;

  update public.journal_headers
  set status_posting = 'posted'
  where id = new_header_id;

  return new_header_id;
end;
$$;

create or replace function public.reverse_journal(
  p_header_id uuid,
  p_transaction_date date,
  p_reference_number text
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  source_header public.journal_headers%rowtype;
  source_line record;
  reversal_header_id uuid;
begin
  select * into source_header
  from public.journal_headers
  where id = p_header_id
  for update;

  if not found then
    raise exception 'Jurnal sumber tidak ditemukan.';
  end if;
  if source_header.status_posting <> 'posted' then
    raise exception 'Hanya jurnal POSTED yang dapat dibalik.';
  end if;
  if exists (
    select 1 from public.journal_headers
    where reverses_header_id = p_header_id
  ) then
    raise exception 'Jurnal ini sudah memiliki jurnal pembalik.';
  end if;

  insert into public.journal_headers (
    transaction_date, reference_number, description, status_posting, reverses_header_id
  ) values (
    p_transaction_date,
    p_reference_number,
    'Pembalikan jurnal ' || source_header.reference_number,
    'draft',
    p_header_id
  ) returning id into reversal_header_id;

  for source_line in
    select account_id, debit, credit
    from public.journal_lines
    where header_id = p_header_id
  loop
    insert into public.journal_lines (header_id, account_id, debit, credit)
    values (
      reversal_header_id,
      source_line.account_id,
      source_line.credit,
      source_line.debit
    );
  end loop;

  update public.journal_headers
  set status_posting = 'posted'
  where id = reversal_header_id;

  return reversal_header_id;
end;
$$;

-- Kas keluar dibuat dalam satu transaksi database: semua baris masuk, atau tidak ada yang masuk.
create or replace function public.create_cash_out_journal(
  p_transaction_date date,
  p_reference_number text,
  p_description text,
  p_expense_account_id uuid,
  p_cash_account_id uuid,
  p_amount numeric
)
returns uuid
language plpgsql
set search_path = ''
as $$
declare
  new_header_id uuid;
  expense_classification text;
  cash_classification text;
begin
  if p_amount is null or p_amount <= 0 then
    raise exception 'Nominal kas keluar harus lebih besar dari nol.';
  end if;
  if p_expense_account_id = p_cash_account_id then
    raise exception 'Akun beban dan akun kas harus berbeda.';
  end if;

  select coa.report_classification into expense_classification
  from public.chart_of_accounts as coa where coa.id = p_expense_account_id;
  select coa.report_classification into cash_classification
  from public.chart_of_accounts as coa where coa.id = p_cash_account_id;

  if expense_classification is distinct from 'expense' then
    raise exception 'Akun debit harus memiliki klasifikasi beban.';
  end if;
  if cash_classification is distinct from 'asset' then
    raise exception 'Akun kredit harus memiliki klasifikasi aset.';
  end if;

  insert into public.journal_headers (
    transaction_date, reference_number, description, status_posting
  ) values (
    p_transaction_date, p_reference_number, p_description, 'draft'
  ) returning id into new_header_id;

  insert into public.journal_lines (header_id, account_id, debit, credit)
  values
    (new_header_id, p_expense_account_id, p_amount, 0),
    (new_header_id, p_cash_account_id, 0, p_amount);

  update public.journal_headers
  set status_posting = 'posted'
  where id = new_header_id;

  return new_header_id;
end;
$$;

-- Kebijakan anon ini memudahkan demo tanpa login, tetapi memberi akses baca/tulis
-- kepada siapa pun yang mengetahui URL dan publishable key. Untuk publikasi nyata,
-- ganti dengan Supabase Auth dan kebijakan berbasis identitas/organisasi.
alter table public.chart_of_accounts enable row level security;
alter table public.journal_headers enable row level security;
alter table public.journal_lines enable row level security;

drop policy if exists "demo anon can manage chart of accounts" on public.chart_of_accounts;
drop policy if exists "demo anon can manage journal headers" on public.journal_headers;
drop policy if exists "demo anon can manage journal lines" on public.journal_lines;

create policy "demo anon can manage chart of accounts"
  on public.chart_of_accounts for all to anon
  using (true) with check (true);
create policy "demo anon can manage journal headers"
  on public.journal_headers for all to anon
  using (true) with check (true);
create policy "demo anon can manage journal lines"
  on public.journal_lines for all to anon
  using (true) with check (true);

grant usage on schema public to anon;
grant select, insert, update, delete on public.chart_of_accounts to anon;
grant select, insert, update, delete on public.journal_headers to anon;
grant select, insert, update, delete on public.journal_lines to anon;
grant execute on function public.create_journal_entry(date, text, text, jsonb) to anon;
grant execute on function public.create_cash_out_journal(date, text, text, uuid, uuid, numeric) to anon;
grant execute on function public.reverse_journal(uuid, date, text) to anon;

notify pgrst, 'reload schema';
