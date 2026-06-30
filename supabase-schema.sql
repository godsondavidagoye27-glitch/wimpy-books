create table if not exists profiles (
  id uuid primary key,
  email text unique,
  full_name text,
  avatar_url text,
  provider text,
  updated_at timestamptz default now()
);

create table if not exists reading_progress (
  user_id uuid not null,
  book_id text not null,
  position integer default 0,
  time_spent integer default 0,
  last_read_at timestamptz default now(),
  primary key (user_id, book_id)
);

create index if not exists reading_progress_user_id_idx on reading_progress (user_id);
