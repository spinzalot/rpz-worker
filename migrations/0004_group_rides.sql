-- Group rides (the Saturday ride, and later an early-bird one): who's in for each one.
-- An event id names one ride on one day, e.g. "sat-2026-11-28".
CREATE TABLE group_rsvps (
  event_id   TEXT NOT NULL,
  rider_id   TEXT NOT NULL,
  status     TEXT NOT NULL,          -- in | maybe | out
  updated_on TEXT NOT NULL,
  PRIMARY KEY (event_id, rider_id)
);
