-- RedditPZ challenge features: one table per tab of the Google Sheet prototype.
-- Lives in its own D1 database (binding RPZ_DB): rider progress is written on every sync, and
-- sourdoughrides.com's core pages must never wait behind those writes.

CREATE TABLE challenges (
  id                   TEXT PRIMARY KEY,          -- e.g. CW-PZ, PZ60Plus, P29
  name                 TEXT NOT NULL,
  kind                 TEXT NOT NULL,             -- Library | Program
  instructors          TEXT NOT NULL DEFAULT '',  -- comma-separated, or Multiple
  types                TEXT NOT NULL DEFAULT '',  -- comma-separated types that count
  count_from           TEXT,                      -- YYYY-MM-DD, rides counted from this day (inclusive)
  count_to             TEXT,                      -- YYYY-MM-DD, through this day (inclusive)
  status               TEXT NOT NULL DEFAULT 'Active',
  library_refreshed_on TEXT,                      -- ISO time of the last library load
  hidden_by_default    INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE classes (
  challenge_id     TEXT NOT NULL,
  peloton_class_id TEXT NOT NULL,
  class_key        TEXT NOT NULL,                 -- snapped air epoch | length | normalized title
  title            TEXT NOT NULL,
  instructor       TEXT NOT NULL DEFAULT '',
  length_min       INTEGER NOT NULL,
  type             TEXT NOT NULL,
  air_epoch        INTEGER NOT NULL,
  week             INTEGER,                       -- programs only
  slot             TEXT NOT NULL DEFAULT '',      -- programs only: Mon, Wed, Thu, Sat
  retired          INTEGER NOT NULL DEFAULT 0,
  added_on         TEXT,
  source           TEXT NOT NULL DEFAULT 'Library', -- Library | Program
  seq              INTEGER NOT NULL DEFAULT 0,    -- load order; twins sharing a key are credited in this order
  PRIMARY KEY (challenge_id, peloton_class_id)
);
-- Progress and buddies read one challenge's classes (the primary key covers that);
-- sync matches rides by key.
CREATE INDEX classes_by_key ON classes (class_key);

CREATE TABLE type_rules (
  ord            INTEGER NOT NULL,                -- first matching rule wins
  title_contains TEXT NOT NULL,
  type           TEXT NOT NULL,
  grid_order     INTEGER
);

CREATE TABLE riders (
  rider_id         TEXT PRIMARY KEY,              -- google:<sub>
  email            TEXT NOT NULL DEFAULT '',
  peloton_username TEXT NOT NULL,
  discord_name     TEXT NOT NULL DEFAULT '',
  buddy_opt_in     INTEGER NOT NULL DEFAULT 0,    -- legacy; Visibility replaced it
  joined_on        TEXT,
  last_sync_on     TEXT,
  status           TEXT NOT NULL DEFAULT 'Active',
  visibility       TEXT NOT NULL DEFAULT '',      -- Everyone | Friends | Nobody
  challenge_view   TEXT NOT NULL DEFAULT ''       -- '-ID' hides a default challenge, '+ID' shows a hidden one
);
CREATE INDEX riders_by_username ON riders (peloton_username COLLATE NOCASE);

-- One row per matched ride. A ride (rider + start time) is stored once, under one class key.
CREATE TABLE completions (
  rider_id  TEXT NOT NULL,
  ridden_at INTEGER NOT NULL,                     -- ride start, epoch seconds
  class_key TEXT NOT NULL,
  source    TEXT NOT NULL DEFAULT 'sync',
  PRIMARY KEY (rider_id, ridden_at)
);
-- Buddies: everyone's rides of one challenge's class keys.
CREATE INDEX completions_by_key ON completions (class_key, rider_id);

CREATE TABLE friends (                            -- one-way lists
  rider_id  TEXT NOT NULL,
  friend_id TEXT NOT NULL,
  added_on  TEXT,
  PRIMARY KEY (rider_id, friend_id)
);
-- Buddies: who lists me (decides whether a Friends-only rider shares with me).
CREATE INDEX friends_by_friend ON friends (friend_id);

CREATE TABLE manual (                             -- gray checks a rider set by hand
  rider_id         TEXT NOT NULL,
  challenge_id     TEXT NOT NULL,
  peloton_class_id TEXT NOT NULL,
  added_on         TEXT,
  PRIMARY KEY (rider_id, challenge_id, peloton_class_id)
);
-- Buddies: everyone's manual marks on one challenge.
CREATE INDEX manual_by_challenge ON manual (challenge_id);

CREATE TABLE admins (
  email TEXT PRIMARY KEY
);
