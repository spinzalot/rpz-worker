-- Data: Charlotte's 20 min Power Zone Max Ride, aired Fri 2026-11-27 1:30 AM ET (06:30 UTC), added to CW-PZ.
-- Only where CW-PZ exists (so test databases, seeded after migrations, are untouched); a re-run adds nothing.
INSERT OR IGNORE INTO classes (challenge_id, peloton_class_id, class_key, title, instructor, length_min, type, air_epoch,
                               week, slot, retired, added_on, source, seq)
SELECT 'CW-PZ', '097b16916cb94135a0d7a19d0b972b38', '1795761000|20|20 min power zone max ride', '20 min Power Zone Max Ride',
       'Charlotte Weidenbach', 20, 'PZMax', 1795761000, NULL, '', 0, '2026-11-28', 'Library',
       (SELECT COALESCE(MAX(seq), 0) + 1 FROM classes)
WHERE EXISTS (SELECT 1 FROM challenges WHERE id = 'CW-PZ');

-- Riders see the "sync" prompt for CW-PZ.
UPDATE challenges SET library_refreshed_on = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'CW-PZ';
