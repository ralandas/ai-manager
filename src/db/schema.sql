-- AI Manager schema. Multi-tenant: each owner has their own apartments.
-- Apartments live in OUR db; an optional rc_apartment_id links a card to a
-- Realty Calendar object so booking/availability/payment can go through RC.

CREATE TABLE IF NOT EXISTS users (
  id          BIGSERIAL PRIMARY KEY,
  email       TEXT UNIQUE,
  phone       TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  name        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_or_phone CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS apartments (
  id            BIGSERIAL PRIMARY KEY,
  owner_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  address       TEXT,
  price         INTEGER,                 -- nightly base price, minor units
  rules         TEXT,
  checkin_instructions TEXT,
  wifi_name     TEXT,
  wifi_password TEXT,
  extra         TEXT,
  rc_apartment_id TEXT,                  -- link to Realty Calendar object (optional)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_apartments_owner ON apartments(owner_id);
CREATE INDEX IF NOT EXISTS idx_apartments_rc ON apartments(rc_apartment_id);

CREATE TABLE IF NOT EXISTS apartment_photos (
  id            BIGSERIAL PRIMARY KEY,
  apartment_id  BIGINT NOT NULL REFERENCES apartments(id) ON DELETE CASCADE,
  file_name     TEXT NOT NULL,           -- stored under data/photos/<apartment_id>/
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_photos_apartment ON apartment_photos(apartment_id);
