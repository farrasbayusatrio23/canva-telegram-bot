-- Canva Access Manager v5 - redeem hotfix
-- Safe to run on an existing v3/v4 database.
-- This avoids ambiguous PL/pgSQL output-column names from the old RETURNS TABLE function.

create extension if not exists citext;
create extension if not exists pgcrypto;

create or replace function public.redeem_canva_token_v2(
  p_token_hash text,
  p_telegram_user_id bigint,
  p_telegram_username text,
  p_telegram_first_name text,
  p_email text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_token public.canva_access_tokens%rowtype;
  v_account public.canva_accounts%rowtype;
  v_package public.canva_packages%rowtype;
  v_existing public.canva_access%rowtype;
  v_access public.canva_access%rowtype;
  v_email citext := lower(trim(coalesce(p_email, '')))::citext;
  v_base timestamptz;
  v_now timestamptz := now();
begin
  if length(v_email::text) = 0 then
    raise exception 'EMAIL_INVALID';
  end if;

  select t.*
    into v_token
  from public.canva_access_tokens as t
  where t.token_hash = p_token_hash
  for update;

  if v_token.id is null then raise exception 'TOKEN_INVALID'; end if;
  if v_token.status = 'disabled' then raise exception 'TOKEN_DISABLED'; end if;
  if v_token.expires_at is not null and v_token.expires_at <= v_now then
    raise exception 'TOKEN_EXPIRED';
  end if;
  if v_token.used_count >= v_token.usage_limit or v_token.status = 'consumed' then
    raise exception 'TOKEN_USED';
  end if;

  select a.*
    into v_account
  from public.canva_accounts as a
  where a.id = v_token.account_id;

  if v_account.id is null or not v_account.is_active then
    raise exception 'ACCOUNT_DISABLED';
  end if;

  select p.*
    into v_package
  from public.canva_packages as p
  where p.id = v_token.package_id;

  if v_package.id is null or not v_package.is_active then
    raise exception 'PACKAGE_DISABLED';
  end if;

  select ca.*
    into v_existing
  from public.canva_access as ca
  where ca.account_id = v_account.id
    and ca.email = v_email
  for update;

  if v_existing.id is not null
     and v_existing.telegram_user_id <> p_telegram_user_id
     and v_existing.status = 'active'
     and v_existing.ends_at > v_now then
    raise exception 'EMAIL_ALREADY_BOUND';
  end if;

  if v_existing.id is not null
     and v_existing.status = 'active'
     and v_existing.ends_at > v_now then
    v_base := v_existing.ends_at;
  else
    v_base := v_now;
  end if;

  insert into public.canva_access as ca (
    telegram_user_id,
    telegram_username,
    telegram_first_name,
    email,
    account_id,
    package_id,
    last_token_id,
    status,
    starts_at,
    ends_at,
    removed_at,
    updated_at
  ) values (
    p_telegram_user_id,
    p_telegram_username,
    p_telegram_first_name,
    v_email,
    v_account.id,
    v_package.id,
    v_token.id,
    'active',
    case
      when v_existing.id is not null
       and v_existing.status = 'active'
       and v_existing.ends_at > v_now
      then v_existing.starts_at
      else v_now
    end,
    v_base + make_interval(days => v_package.duration_days),
    null,
    v_now
  )
  on conflict (account_id, email) do update set
    telegram_user_id = excluded.telegram_user_id,
    telegram_username = excluded.telegram_username,
    telegram_first_name = excluded.telegram_first_name,
    package_id = excluded.package_id,
    last_token_id = excluded.last_token_id,
    status = 'active',
    starts_at = excluded.starts_at,
    ends_at = excluded.ends_at,
    removed_at = null,
    updated_at = v_now
  returning ca.* into v_access;

  update public.canva_access_tokens as t
  set used_count = t.used_count + 1,
      status = case
        when t.used_count + 1 >= t.usage_limit then 'consumed'
        else t.status
      end,
      updated_at = v_now
  where t.id = v_token.id;

  insert into public.canva_audit(account_id, access_id, email, event, details)
  values (
    v_account.id,
    v_access.id,
    v_email,
    'token_redeemed',
    jsonb_build_object(
      'token_id', v_token.id,
      'package_id', v_package.id,
      'duration_days', v_package.duration_days,
      'telegram_user_id', p_telegram_user_id,
      'redeem_version', 2
    )
  );

  return jsonb_build_object(
    'access_id', v_access.id,
    'email', v_access.email,
    'account_id', v_account.id,
    'account_name', v_account.name,
    'package_id', v_package.id,
    'package_name', v_package.name,
    'duration_days', v_package.duration_days,
    'starts_at', v_access.starts_at,
    'ends_at', v_access.ends_at,
    'status', v_access.status,
    'invite_url', v_account.invite_url
  );
end;
$$;

revoke all on function public.redeem_canva_token_v2(text,bigint,text,text,text)
from public, anon, authenticated;

grant execute on function public.redeem_canva_token_v2(text,bigint,text,text,text)
to service_role;
