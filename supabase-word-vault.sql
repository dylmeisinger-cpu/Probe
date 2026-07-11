create table if not exists public.word_vault_users (
  id text primary key,
  name text not null,
  email text not null unique,
  password_hash text not null,
  password_salt text not null,
  verified boolean not null default false,
  verify_token text unique,
  player_token text not null unique,
  avatar text,
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  verified_at timestamptz
);

alter table public.word_vault_users
  add column if not exists avatar text;

create table if not exists public.word_vault_sessions (
  token text primary key,
  user_id text not null references public.word_vault_users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.word_vault_daily_leaderboard (
  id text primary key,
  day text not null,
  name text not null,
  account_id text references public.word_vault_users(id) on delete set null,
  verified boolean not null default false,
  score integer not null,
  elapsed_ms integer not null,
  guesses integer not null,
  completed_at timestamptz not null default now()
);

create index if not exists word_vault_users_email_idx on public.word_vault_users(email);
create index if not exists word_vault_users_player_token_idx on public.word_vault_users(player_token);
create index if not exists word_vault_sessions_user_id_idx on public.word_vault_sessions(user_id);
create index if not exists word_vault_daily_day_score_idx on public.word_vault_daily_leaderboard(day, score desc, elapsed_ms asc, guesses asc);

alter table public.word_vault_users enable row level security;
alter table public.word_vault_sessions enable row level security;
alter table public.word_vault_daily_leaderboard enable row level security;

-- The Word Vault server uses the Supabase service role key, which bypasses RLS.
-- Do not expose SUPABASE_SERVICE_ROLE_KEY in client-side code.
