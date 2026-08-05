# Working constraints

- Never bump `pg` past 8.11 — 8.12 changes numeric parsing from string to
  float and silently corrupts money columns; the migration is blocked on
  issue #482 and the workaround in `src/db/money.ts` depends on the string
  form.
- The staging database is shared with the analytics team: schema changes
  applied before 14:00 UTC break their morning ETL and page their on-call.
  Land migrations after 15:00 UTC or coordinate in #data-eng first.
- `npm test` green locally but red in CI usually means your Docker Postgres
  is 15 while CI still runs 13 — check `integration/checkout.test.ts`
  first; it leans on `MERGE`, which 13 does not have.
- The `orders.status` enum cannot gain values in place: the ORM caches enum
  OIDs per connection, so deploys that alter it need the two-phase pattern
  in `docs/enum-migrations.md` or reads return stale labels for about ten
  minutes after rollout.
- Rate limits on the payments sandbox reset at 00:00 Pacific, not UTC —
  batch replay jobs scheduled "at midnight" were double-billed twice
  (incidents 2024-03 and 2024-09) before we pinned them to 09:00 UTC.
- `SESSION_SECRET` rotation requires keeping the old value in
  `SESSION_SECRET_PREVIOUS` for 24 hours, or every active cart is dropped
  at the next request; the 2024-06 revenue dip was exactly this.
- Cursor pagination on `/api/orders` breaks if you sort by `updated_at`:
  the column is not unique and the vendor webhook rewrites it in bulk. Sort
  by `(created_at, id)` — the composite index exists for this reason.
