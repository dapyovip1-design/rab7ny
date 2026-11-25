-- ربحني: طبقة أمان إضافية لقاعدة Supabase.
-- اقرأ README.md وخذ نسخة احتياطية قبل التنفيذ.
-- يفترض وجود الجداول: profiles, site_settings, site_tasks,
-- task_submissions, withdrawals, notifications بالأعمدة التي يستخدمها التطبيق.

create table if not exists public.user_roles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  role text not null check (role in ('admin'))
);

alter table public.user_roles enable row level security;
drop policy if exists "users cannot read roles" on public.user_roles;
create policy "users cannot read roles" on public.user_roles
  for select to authenticated using (user_id = auth.uid());

create or replace function public.is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = (select auth.uid()) and r.role = 'admin'
  );
$$;

revoke all on function public.is_platform_admin() from public;
grant execute on function public.is_platform_admin() to authenticated;

-- إنشاء ملف المستخدم تلقائياً عند التسجيل، بدل السماح للمستخدم بتعيين رصيده بنفسه.
create or replace function public.handle_new_rab7ny_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, balance, is_banned, ban_reason)
  values (new.id, new.email, 0, false, '')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_rab7ny on auth.users;
create trigger on_auth_user_created_rab7ny
after insert on auth.users
for each row execute procedure public.handle_new_rab7ny_user();

-- كل عمليات الرصيد الحساسة تتم داخل معاملة واحدة.
create or replace function public.request_withdrawal(p_wallet_info text, p_amount integer)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_email text;
  v_balance integer;
  v_min integer;
  v_max integer;
begin
  if v_user_id is null then raise exception 'يجب تسجيل الدخول أولاً'; end if;
  if p_wallet_info is null or length(trim(p_wallet_info)) < 4 then
    raise exception 'بيانات وسيلة السحب غير صحيحة';
  end if;
  if p_amount is null or p_amount <= 0 then raise exception 'عدد النقاط غير صحيح'; end if;

  select email into v_email from auth.users where id = v_user_id;
  select min_withdraw, max_withdraw into v_min, v_max
    from public.site_settings where id = 1;
  if v_min is null or v_max is null then raise exception 'إعدادات السحب غير متاحة'; end if;
  if p_amount < v_min or p_amount > v_max then raise exception 'المبلغ خارج حدود السحب'; end if;

  select balance into v_balance
    from public.profiles where id = v_user_id and coalesce(is_banned, false) = false
    for update;
  if not found then raise exception 'الحساب غير موجود أو موقوف'; end if;
  if v_balance < p_amount then raise exception 'رصيدك غير كافٍ'; end if;

  update public.profiles set balance = balance - p_amount where id = v_user_id;
  insert into public.withdrawals (user_id, email, wallet_info, amount, status)
  values (v_user_id, v_email, trim(p_wallet_info), p_amount, 'pending');

  return jsonb_build_object('success', true, 'balance', v_balance - p_amount);
end;
$$;

revoke all on function public.request_withdrawal(text, integer) from public;
grant execute on function public.request_withdrawal(text, integer) to authenticated;

create or replace function public.approve_task_submission(p_submission_id bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_sub public.task_submissions%rowtype;
  v_task public.site_tasks%rowtype;
begin
  if not public.is_platform_admin() then raise exception 'غير مصرح'; end if;

  select * into v_sub from public.task_submissions
    where id = p_submission_id for update;
  if not found then raise exception 'الإثبات غير موجود'; end if;
  if v_sub.status <> 'pending' then raise exception 'تمت معالجة هذا الإثبات مسبقاً'; end if;

  select * into v_task from public.site_tasks where id = v_sub.task_id;
  if not found then raise exception 'المهمة غير موجودة'; end if;

  update public.profiles
    set balance = balance + v_task.reward
    where id = v_sub.user_id;
  if not found then raise exception 'ملف المستخدم غير موجود'; end if;

  update public.task_submissions set status = 'approved' where id = p_submission_id;

  insert into public.notifications (user_id, message, is_read)
  values (v_sub.user_id,
    'تم قبول إثبات المهمة (' || v_task.title || ') وإضافة ' || v_task.reward || ' نقطة إلى رصيدك.',
    false);

  return jsonb_build_object('success', true, 'message', 'تمت الموافقة وإضافة المكافأة.');
end;
$$;

revoke all on function public.approve_task_submission(bigint) from public;
grant execute on function public.approve_task_submission(bigint) to authenticated;

create or replace function public.admin_adjust_balance(
  target_user_id uuid,
  points_change integer,
  reason_text text
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_balance integer;
begin
  if not public.is_platform_admin() then raise exception 'غير مصرح'; end if;
  if points_change is null or points_change = 0 then raise exception 'قيمة التعديل غير صحيحة'; end if;

  update public.profiles
    set balance = balance + points_change
    where id = target_user_id
      and balance + points_change >= 0
    returning balance into v_new_balance;
  if not found then raise exception 'المستخدم غير موجود أو الرصيد غير كافٍ'; end if;

  insert into public.notifications (user_id, message, is_read)
  values (target_user_id, coalesce(reason_text, 'تم تحديث رصيدك.'), false);
end;
$$;

revoke all on function public.admin_adjust_balance(uuid, integer, text) from public;
grant execute on function public.admin_adjust_balance(uuid, integer, text) to authenticated;

create or replace function public.admin_set_user_ban(
  target_user_id uuid,
  new_status boolean,
  reason_text text default ''
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_platform_admin() then raise exception 'غير مصرح'; end if;
  update public.profiles
    set is_banned = new_status,
        ban_reason = case when new_status then coalesce(reason_text, 'مخالفة شروط الاستخدام') else '' end
    where id = target_user_id;
  if not found then raise exception 'المستخدم غير موجود'; end if;
end;
$$;

revoke all on function public.admin_set_user_ban(uuid, boolean, text) from public;
grant execute on function public.admin_set_user_ban(uuid, boolean, text) to authenticated;

-- سياسات وصول مقترحة. يجب إزالة أي سياسات قديمة واسعة تسمح بـ USING (true)
-- أو WITH CHECK (true)؛ لأن سياسات RLS permissive تتجمع بمنطق OR.
alter table public.profiles enable row level security;
alter table public.site_settings enable row level security;
alter table public.site_tasks enable row level security;
alter table public.task_submissions enable row level security;
alter table public.withdrawals enable row level security;
alter table public.notifications enable row level security;

drop policy if exists "rab7ny_profiles_select" on public.profiles;
create policy "rab7ny_profiles_select" on public.profiles
for select to authenticated using (id = (select auth.uid()) or public.is_platform_admin());

drop policy if exists "rab7ny_settings_select" on public.site_settings;
create policy "rab7ny_settings_select" on public.site_settings
for select to authenticated using (true);
drop policy if exists "rab7ny_settings_admin_update" on public.site_settings;
create policy "rab7ny_settings_admin_update" on public.site_settings
for update to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists "rab7ny_tasks_select" on public.site_tasks;
create policy "rab7ny_tasks_select" on public.site_tasks
for select to authenticated using (true);
drop policy if exists "rab7ny_tasks_admin_all" on public.site_tasks;
create policy "rab7ny_tasks_admin_all" on public.site_tasks
for all to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists "rab7ny_submissions_select" on public.task_submissions;
create policy "rab7ny_submissions_select" on public.task_submissions
for select to authenticated using (user_id = (select auth.uid()) or public.is_platform_admin());
drop policy if exists "rab7ny_submissions_insert" on public.task_submissions;
create policy "rab7ny_submissions_insert" on public.task_submissions
for insert to authenticated with check (
  user_id = (select auth.uid()) and status = 'pending'
);
drop policy if exists "rab7ny_submissions_admin_update" on public.task_submissions;
create policy "rab7ny_submissions_admin_update" on public.task_submissions
for update to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists "rab7ny_withdrawals_select" on public.withdrawals;
create policy "rab7ny_withdrawals_select" on public.withdrawals
for select to authenticated using (user_id = (select auth.uid()) or public.is_platform_admin());
drop policy if exists "rab7ny_withdrawals_admin_update" on public.withdrawals;
create policy "rab7ny_withdrawals_admin_update" on public.withdrawals
for update to authenticated using (public.is_platform_admin()) with check (public.is_platform_admin());

drop policy if exists "rab7ny_notifications_select" on public.notifications;
create policy "rab7ny_notifications_select" on public.notifications
for select to authenticated using (user_id = (select auth.uid()) or public.is_platform_admin());
drop policy if exists "rab7ny_notifications_insert" on public.notifications;
create policy "rab7ny_notifications_insert" on public.notifications
for insert to authenticated with check (public.is_platform_admin() or user_id = (select auth.uid()));
drop policy if exists "rab7ny_notifications_update" on public.notifications;
create policy "rab7ny_notifications_update" on public.notifications
for update to authenticated using (user_id = (select auth.uid()) or public.is_platform_admin())
with check (user_id = (select auth.uid()) or public.is_platform_admin());

-- لا تمنح المستخدم صلاحية تعديل رصيده أو حالة الحظر مباشرة.
revoke insert, update, delete on public.profiles from anon, authenticated;
grant select on public.profiles to authenticated;
grant select on public.site_settings, public.site_tasks, public.task_submissions,
  public.withdrawals, public.notifications to authenticated;
grant insert on public.task_submissions to authenticated;
grant update on public.site_settings, public.site_tasks, public.task_submissions,
  public.withdrawals, public.notifications to authenticated;
grant insert, update, delete on public.site_tasks to authenticated;
