-- Trigram indexes for fast `ilike '%term%'`. Idempotent; the coordinator turns this into a hand-written drizzle migration.
-- pg_trgm is a trusted extension on PG13+, so a non-superuser with CREATE on the database can install it.
-- Plan note: `col ilike '%x%'` (as built by likeContains) uses a GIN gin_trgm_ops index on that exact column/expression via a
-- bitmap scan; OR across columns becomes a BitmapOr. Terms shorter than 3 chars cannot use trigrams (seq scan, small tables only),
-- which is why search requires q >= 2 and the tenant filter (organization_id) still narrows the heap fetch. Partial indexes
-- match `deleted_at is null`, which every read adds. The `%` typo operator is NOT used: it needs a similarity threshold and
-- would diverge from the ilike plan.
create extension if not exists pg_trgm;

-- contacts list search (contacts.repository.ts list/count: ilike first_name)
create index if not exists contacts_first_name_trgm_idx on contacts using gin (first_name gin_trgm_ops) where deleted_at is null;
-- contacts list search (ilike last_name)
create index if not exists contacts_last_name_trgm_idx on contacts using gin (last_name gin_trgm_ops) where deleted_at is null;
-- contacts list search + global search (ilike email)
create index if not exists contacts_email_trgm_idx on contacts using gin (email gin_trgm_ops) where deleted_at is null;
-- global search contacts (search.service.ts: ilike btrim(first_name || ' ' || coalesce(last_name, ''))), enables "john smith"
create index if not exists contacts_full_name_trgm_idx on contacts using gin ((btrim(first_name || ' ' || coalesce(last_name, ''))) gin_trgm_ops) where deleted_at is null;

-- leads list search (leads.repository.ts list/count: ilike first_name)
create index if not exists leads_first_name_trgm_idx on leads using gin (first_name gin_trgm_ops) where deleted_at is null;
-- leads list search (ilike last_name)
create index if not exists leads_last_name_trgm_idx on leads using gin (last_name gin_trgm_ops) where deleted_at is null;
-- leads list search + global search (ilike email)
create index if not exists leads_email_trgm_idx on leads using gin (email gin_trgm_ops) where deleted_at is null;
-- leads list search + global search (ilike company_name)
create index if not exists leads_company_name_trgm_idx on leads using gin (company_name gin_trgm_ops) where deleted_at is null;
-- global search leads (ilike btrim(first_name || ' ' || coalesce(last_name, '')))
create index if not exists leads_full_name_trgm_idx on leads using gin ((btrim(first_name || ' ' || coalesce(last_name, ''))) gin_trgm_ops) where deleted_at is null;

-- companies list search + global search (companies.repository.ts: ilike name)
create index if not exists companies_name_trgm_idx on companies using gin (name gin_trgm_ops) where deleted_at is null;

-- deals list search + global search (sales.repository.ts: ilike title)
create index if not exists deals_title_trgm_idx on deals using gin (title gin_trgm_ops) where deleted_at is null;
