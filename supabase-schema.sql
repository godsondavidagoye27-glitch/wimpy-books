-- Wimpy Books Database Schema with Row Level Security (RLS)
-- This is the single source of truth for the database structure.
-- Keep this in sync with server.js table usage.
-- Updated: 2026-09-01

-- ============================================
-- PROFILES TABLE
-- ============================================
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text unique,
  full_name text,
  avatar_url text,
  provider text,
  updated_at timestamptz default now()
);

alter table profiles enable row level security;

-- Users can only read/update their own profile
drop policy if exists "Users can read own profile" on profiles;
create policy "Users can read own profile" on profiles
  for select using (auth.uid() = id);

drop policy if exists "Users can update own profile" on profiles;
create policy "Users can update own profile" on profiles
  for update using (auth.uid() = id);

drop policy if exists "Service role can read all profiles" on profiles;
create policy "Service role can read all profiles" on profiles
  for select using (auth.jwt() ->> 'role' = 'service_role');

drop policy if exists "Service role can update profiles" on profiles;
create policy "Service role can update profiles" on profiles
  for update using (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- BOOKS TABLE
-- ============================================
create table if not exists books (
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
alter table books add column if not exists is_free boolean default true;
alter table books add column if not exists price numeric(10, 2) default 0;
alter table books add column if not exists file_name text;
alter table books add column if not exists file_type text;
alter table books add column if not exists file_data text;
alter table books add column if not exists status text default 'pending';
alter table books add column if not exists uploader_id uuid references auth.users(id) on delete set null;
alter table books add column if not exists uploader text;
alter table books add column if not exists updated_at timestamptz default now();
alter table books add column if not exists reads bigint default 0;
alter table books add column if not exists traffic bigint default 0;
alter table books add column if not exists sales bigint default 0;
alter table books add column if not exists rating numeric(3, 2) default 0;
alter table books add column if not exists ratings bigint default 0;

alter table books enable row level security;

-- Anyone can read approved books
drop policy if exists "Anyone can read approved books" on books;
create policy "Anyone can read approved books" on books
  for select using (status = 'approved');

-- Uploaders can read their own pending/rejected books
drop policy if exists "Uploaders can read own books" on books;
create policy "Uploaders can read own books" on books
  for select using (auth.uid() = uploader_id);

-- Admins can read all books
drop policy if exists "Admins can read all books" on books;
create policy "Admins can read all books" on books
  for select using (auth.jwt() ->> 'role' = 'service_role');

-- Authenticated users can insert (but will be pending until approved)
drop policy if exists "Authenticated users can upload books" on books;
create policy "Authenticated users can upload books" on books
  for insert with check (auth.uid() = uploader_id);

-- Only uploaders can update their own books (except status)
drop policy if exists "Uploaders can update their own books" on books;
create policy "Uploaders can update their own books" on books
  for update using (auth.uid() = uploader_id);

-- Only service role can update book status and metrics
drop policy if exists "Service role can update book metadata" on books;
create policy "Service role can update book metadata" on books
  for update using (auth.jwt() ->> 'role' = 'service_role');

-- Only uploaders can delete their own books
drop policy if exists "Uploaders can delete their own books" on books;
create policy "Uploaders can delete their own books" on books
  for delete using (auth.uid() = uploader_id);

-- ============================================
-- BOOK_PURCHASES TABLE
-- ============================================
create table if not exists book_purchases (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id bigint not null references books(id) on delete cascade,
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
-- SUBSCRIPTIONS TABLE
-- ============================================
create table if not exists subscriptions (
  id bigserial primary key,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  user_email text,
  active boolean default false,
  expires_at timestamptz,
  transaction_ref text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- Add missing columns if they don't exist
alter table subscriptions add column if not exists expires_at timestamptz;
alter table subscriptions add column if not exists transaction_ref text;
alter table subscriptions add column if not exists updated_at timestamptz default now();

alter table subscriptions enable row level security;

-- Users can only read their own subscription
drop policy if exists "Users can read own subscription" on subscriptions;
create policy "Users can read own subscription" on subscriptions
  for select using (auth.uid() = user_id);

-- Only service role can manage subscriptions
drop policy if exists "Service role can manage subscriptions" on subscriptions;
create policy "Service role can manage subscriptions" on subscriptions
  for all using (auth.jwt() ->> 'role' = 'service_role');

-- ============================================
-- READING_PROGRESS TABLE
-- ============================================
create table if not exists reading_progress (
  user_id uuid not null references auth.users(id) on delete cascade,
  book_id bigint not null references books(id) on delete cascade,
  position text default '0',
  time_spent integer default 0,
  last_read_at timestamptz default now(),
  primary key (user_id, book_id)
);

alter table reading_progress enable row level security;

-- Users can only read their own reading progress
drop policy if exists "Users can read own progress" on reading_progress;
create policy "Users can read own progress" on reading_progress
  for select using (auth.uid() = user_id);

-- Users can update their own reading progress
drop policy if exists "Users can update own progress" on reading_progress;
create policy "Users can update own progress" on reading_progress
  for update using (auth.uid() = user_id);

-- Users can insert their own reading progress
drop policy if exists "Users can insert own progress" on reading_progress;
create policy "Users can insert own progress" on reading_progress
  for insert with check (auth.uid() = user_id);

create index if not exists reading_progress_user_id_idx on reading_progress (user_id);

-- ============================================
-- BOOK_COMMENTS TABLE
-- ============================================
create table if not exists book_comments (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  user_name text,
  book_id bigint not null references books(id) on delete cascade,
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
    exists (select 1 from books where books.id = book_comments.book_id and books.status = 'approved')
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
  book_id bigint not null references books(id) on delete cascade,
  score numeric(2, 1) not null check (score >= 0 and score <= 5),
  created_at timestamptz default now(),
  primary key (user_id, book_id)
);

alter table book_ratings enable row level security;

-- Anyone can read ratings for approved books
drop policy if exists "Anyone can read ratings" on book_ratings;
create policy "Anyone can read ratings" on book_ratings
  for select using (
    exists (select 1 from books where books.id = book_ratings.book_id and books.status = 'approved')
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
create index if not exists books_status_idx on books (status);
create index if not exists books_uploader_id_idx on books (uploader_id);
create index if not exists books_created_at_idx on books (created_at desc);
create index if not exists subscriptions_user_id_idx on subscriptions (user_id);
create index if not exists subscriptions_expires_at_idx on subscriptions (expires_at);
