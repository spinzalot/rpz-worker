-- Each rider's Strava sign-in (for the Power overlay). Shown to and used for that rider only;
-- no Strava activity data is stored.
CREATE TABLE strava_links (
  rider_id   TEXT PRIMARY KEY,
  athlete_id INTEGER,
  name       TEXT NOT NULL DEFAULT '',
  ftp        INTEGER NOT NULL DEFAULT 0,   -- from the rider's Strava profile, if shared
  access     TEXT NOT NULL,
  refresh    TEXT NOT NULL,
  expires_at INTEGER NOT NULL              -- epoch seconds
);
