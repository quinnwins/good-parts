-- Good Parts server storage. Apply with `npx wrangler d1 execute good-parts --remote --file schema.sql`.

-- Claude's answer for each set of captions, so the next person who watches that video gets it instantly.
CREATE TABLE IF NOT EXISTS answers (key TEXT PRIMARY KEY, body TEXT NOT NULL, created INTEGER NOT NULL);

-- How many new videos each address asked Claude about each day (UTC), for the daily limit.
CREATE TABLE IF NOT EXISTS uses (ip TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (ip, day));
