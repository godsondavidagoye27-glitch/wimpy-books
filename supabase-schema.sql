-- Wimpy Books Database Schema with Row Level Security (RLS)
-- This is the single source of truth for the WimpyBooks-owned tables.
-- Keep this in sync with server.js table usage.
-- Updated: 2026-09-02
--
-- IMPORTANT — shared Supabase project:
-- WimpyID, WimpyPay, and WimpyBooks (and other Wimpy Cooperations products)
-- all live in ONE Supabase project. This file must only create/alter tables
-- that WimpyBooks itself owns (prefixed `book_`, per company convention).
-- It must NEVER create or alter `profiles` (owned by WimpyID, see
-- wimpyid/supabase/migrations/0001_create_profiles_table.sql) or
-- `subscriptions`/`plans` (owned by WimpyPay, see
-- wimpypay/supabase/migrations/0004_create_subscriptions_table.sql) —
-- doing so risks silently corrupting another product's schema. WimpyBooks
-- only ever SELECTs from those tables (see server.js: getUserSubscription).

-- ============================================
-- PROFILES TABLE — owned by WimpyID. NOT created or altered here.
-- WimpyID's signup trigger creates a row automatically; WimpyBooks only
-- updates full_name/avatar_url/updated_at on its own rows (see auth.js
-- persistSupabaseProfile), which WimpyID's existing RLS policies
-- ("Users can update own profile") already permit.
-- ============================================

-- ============================================
-- SUBSCRIPTIONS / PLANS TABLES — owned by WimpyPay. NOT created or
-- altered here. WimpyBooks reads WimpyPay's `subscriptions` joined to
-- `plans` (filtered to product_name = 'WimpyBooks') to check access, and
-- calls WimpyPay's POST /api/external/subscribe to activate one — see
-- server.js: getUserSubscription / subscribeViaWimpyPay.
-- A one-time setup step (outside this file) is required in WimpyPay: an
-- admin must create a `plans` row with
-- { product_name: 'WimpyBooks', name: 'Unlimited Monthly', price: <NGN>,
--   billing_interval: 'month' } via WimpyPay's admin create-plan endpoint.
-- ============================================

-- ============================================
-- BOOK_TITLES TABLE
-- ============================================
create table if not exists book_titles (
  id bigserial primary key,
  title text not null,
  author text not null,
  genre text,
  description text,
  preview text,
  cover text,
  cover_image_data text,
  is_free boolean default true,
  price numeric(10, 2) default 0,
  file_name text,
  file_type text,
  file_data text,
  status text default 'pending', -- pending, approved, rejected
  uploader_id uuid references auth.users(id) on delete set null,
  uploader text, -- legacy: email/name of uploader
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  reads bigint default 0,
  traffic bigint default 0,
  sales bigint default 0,
  rating numeric(3, 2) default 0,
  ratings bigint default 0
);

-- Add missing columns if they don't exist
alter table book_titles add column if not exists is_free boolean default true;
alter table book_titles add column if not exists price numeric(10, 2) default 0;
alter table book_titles add column if not exists file_name text;
alter table book_titles add column if not exists file_type text;
alter table book_titles add column if not exists file_data text;
alter table book_titles add column if not exists status text default 'pending';
alter table book_titles add column if not exists uploader_id uuid references auth.users(id) on delete set null;
alter table book_titles add column if not exists uploader text;
alter table book_titles add column if not exists updated_at timestamptz default now();
alter table book_titles add column if not exists reads bigint default 0;
alter table book_titles add column if not exists traffic bigint default 0;
alter table book_titles add column if not exists sales bigint default 0;
alter table book_titles add column if not exists rating numeric(3, 2) default 0;
alter table book_titles add column if not exists ratings bigint default 0;

alter table book_titles enable row level security;

-- Anyone can read approved books
drop policy if exists "Anyone can read approved books" on book_titles;
create policy "Anyone can read approved books" on book_titles
  for select using (status = 'approved');

-- Uploaders can read their own pending/rejected books
drop policy if exists "Uploaders can read own books" on book_titles;
create policy "Uploaders can read own books" on book_titles
  for select using (auth.uid() = uploader_id);

-- Admins can read all books
drop policy if exists "Admins can read all books" on book_titles;
create policy "Admins can read all books" on book_titles
  for select using (auth.jwt() ->> 'role' = 'service_role');

-- Authenticated users can insert (but will be pending until approved)
drop policy if exists "Authenticated users can upload books" on book_titles;
create policy "Authenticated users can upload books" on book_titles
  for insert with check (auth.uid() = uploader_id);

-- Only uploaders can update their own books (except status)
drop policy if exists "Uploaders can update their own books" on book_titles;
create policy "Uploaders can update their own books" on book_titles
  for update using (auth.uid() = uploader_id);

-- Only service role can update book status and metrics
drop policy if exists "Service role can update book metadata" on book_titles;
create policy "Service role can update book metadata" on book_titles
  for update using (auth.jwt() ->> 'role' = 'service_role');

-- Only uploaders can delete their own books
drop policy if exists "Uploaders can delete their own books" on book_titles;
create policy "Uploaders can delete their own books" on book_titles
  for delete using (auth.uid() = uploader_id);

-- ============================================
-- BOOK_PURCHASES TABLE
-- ============================================
create table if not exists book_purchases (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id bigint not null references book_titles(id) on delete cascade,
  amount numeric(10, 2) not null,
  transaction_ref text,
  metadata jsonb,
  created_at timestamptz default now()
);

alter table book_purchases enable row level security;

-- Users can only read their own purchases
drop policy if exists "Users can read own purchases" on book_purchases;
create policy "Users can read own purchases" on book_purchases
  for select using (auth.uid() = user_id);

-- Only service role can create purchases
drop policy if exists "Service role can create purchases" on book_purchases;
create policy "Service role can create purchases" on book_purchases
  for insert with check (auth.jwt() ->> 'role' = 'service_role');

-- Only service role can delete purchases
drop policy if exists "Service role can delete purchases" on book_purchases;
create policy "Service role can delete purchases" on book_purchases
  for delete using (auth.jwt() ->> 'role' = 'service_role');

create index if not exists book_purchases_user_id_idx on book_purchases (user_id);
create index if not exists book_purchases_book_id_idx on book_purchases (book_id);

-- ============================================
-- BOOK_READING_PROGRESS TABLE
-- ============================================
create table if not exists book_reading_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id bigint not null references book_titles(id) on delete cascade,
  position text default '0',
  time_spent integer default 0,
  last_read_at timestamptz default now(),
  primary key (user_id, book_id)
);

alter table book_reading_progress enable row level security;

-- Users can only read their own reading progress
drop policy if exists "Users can read own progress" on book_reading_progress;
create policy "Users can read own progress" on book_reading_progress
  for select using (auth.uid() = user_id);

-- Users can update their own reading progress
drop policy if exists "Users can update own progress" on book_reading_progress;
create policy "Users can update own progress" on book_reading_progress
  for update using (auth.uid() = user_id);

-- Users can insert their own reading progress
drop policy if exists "Users can insert own progress" on book_reading_progress;
create policy "Users can insert own progress" on book_reading_progress
  for insert with check (auth.uid() = user_id);

create index if not exists book_reading_progress_user_id_idx on book_reading_progress (user_id);

-- ============================================
-- BOOK_COMMENTS TABLE
-- ============================================
create table if not exists book_comments (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_name text,
  book_id bigint not null references book_titles(id) on delete cascade,
  text text not null,
  created_at timestamptz default now()
);

-- Add missing columns if they don't exist
alter table book_comments add column if not exists user_name text;

alter table book_comments enable row level security;

-- Anyone can read comments on approved books
drop policy if exists "Anyone can read comments" on book_comments;
create policy "Anyone can read comments" on book_comments
  for select using (
    exists (select 1 from book_titles where book_titles.id = book_comments.book_id and book_titles.status = 'approved')
  );

-- Authenticated users can create comments
drop policy if exists "Authenticated users can create comments" on book_comments;
create policy "Authenticated users can create comments" on book_comments
  for insert with check (auth.uid() = user_id);

-- Comment authors can delete their own comments
drop policy if exists "Users can delete own comments" on book_comments;
create policy "Users can delete own comments" on book_comments
  for delete using (auth.uid() = user_id);

create index if not exists book_comments_book_id_idx on book_comments (book_id);
create index if not exists book_comments_user_id_idx on book_comments (user_id);

-- ============================================
-- BOOK_RATINGS TABLE
-- ============================================
create table if not exists book_ratings (
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id bigint not null references book_titles(id) on delete cascade,
  score numeric(2, 1) not null check (score >= 0 and score <= 5),
  created_at timestamptz default now(),
  primary key (user_id, book_id)
);

alter table book_ratings enable row level security;

-- Anyone can read ratings for approved books
drop policy if exists "Anyone can read ratings" on book_ratings;
create policy "Anyone can read ratings" on book_ratings
  for select using (
    exists (select 1 from book_titles where book_titles.id = book_ratings.book_id and book_titles.status = 'approved')
  );

-- Authenticated users can create/update their own ratings
drop policy if exists "Authenticated users can rate books" on book_ratings;
create policy "Authenticated users can rate books" on book_ratings
  for all using (auth.uid() = user_id);

create index if not exists book_ratings_book_id_idx on book_ratings (book_id);
create index if not exists book_ratings_user_id_idx on book_ratings (user_id);

-- ============================================
-- BOOK_NEWSLETTER_SIGNUPS TABLE
-- ============================================
create table if not exists book_newsletter_signups (
  id bigserial primary key,
  email text unique not null,
  created_at timestamptz default now()
);

alter table book_newsletter_signups enable row level security;

-- Only service role can access newsletter signups
drop policy if exists "Service role only" on book_newsletter_signups;
create policy "Service role only" on book_newsletter_signups
  for all using (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- BOOK_CONTACT_MESSAGES TABLE
-- ============================================
create table if not exists book_contact_messages (
  id bigserial primary key,
  name text not null,
  email text not null,
  subject text,
  message text not null,
  created_at timestamptz default now()
);

alter table book_contact_messages enable row level security;

-- Only service role can access contact messages
drop policy if exists "Service role only" on book_contact_messages;
create policy "Service role only" on book_contact_messages
  for all using (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- INDEXES FOR PERFORMANCE
-- ============================================
create index if not exists book_titles_status_idx on book_titles (status);
create index if not exists book_titles_uploader_id_idx on book_titles (uploader_id);
create index if not exists book_titles_created_at_idx on book_titles (created_at desc);