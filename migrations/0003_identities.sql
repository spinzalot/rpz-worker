-- Sign-in identities (Google, Discord, Reddit): each maps one provider account to one rider, so a rider
-- can sign in several ways. Bounded by riders x providers (a handful per rider); written only at join,
-- link and unlink. Existing riders (rider_id 'google:<sub>') get their Google identity here.
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,              -- 'google' | 'discord' | 'reddit'
  subject  TEXT NOT NULL,              -- the provider's stable account id
  rider_id TEXT NOT NULL,
  name     TEXT NOT NULL DEFAULT '',   -- display name from the provider, for the "signed in as" list
  added_on TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS identities_by_rider ON identities (rider_id);

INSERT OR IGNORE INTO identities (provider, subject, rider_id, name, added_on)
  SELECT 'google', substr(rider_id, 8), rider_id, '', joined_on FROM riders WHERE rider_id LIKE 'google:%';
