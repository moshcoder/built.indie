/**
 * The shared Profullstack profile (@profullstack/profile): email, first and last
 * name, company domain, job title and LinkedIn URL, in the package's own
 * `user_profiles` table keyed by users.id. Private to the member: nothing here is
 * shown on a public page.
 */
import type { Database } from 'bun:sqlite'
import { createProfileStore, migrate, splitFullName, type ProfileStore } from '@profullstack/profile'

/** The store, and `ready` once its table exists (created when the database opens). */
export function openProfiles(db: Database): { store: ProfileStore; ready: Promise<ProfileStore> } {
  const store = createProfileStore(db, { keyType: 'text' })
  const ready = migrate(store).then(async () => {
    await backfill(db, store)
    return store
  })
  ready.catch((error) => console.error(`[profile] migration failed: ${(error as Error).message}`))
  return { store, ready }
}

/**
 * One-time and idempotent: a display name typed as "First Last" becomes the
 * profile's names. A single word is a handle, not a name, and is left alone, and
 * fillBlanks never overwrites what a member saved.
 */
async function backfill(db: Database, store: ProfileStore) {
  const rows = db.query(`SELECT u.id, u.email, u.display_name FROM users u
    WHERE instr(trim(u.display_name), ' ') > 0 AND NOT EXISTS (SELECT 1 FROM user_profiles p WHERE p.user_id = u.id)`)
    .all() as { id: string; email: string; display_name: string }[]
  for (const row of rows) {
    const email = row.email.endsWith('.invalid') ? {} : { email: row.email }
    try { await store.fillBlanks(row.id, { ...splitFullName(row.display_name), ...email }) } catch { /* a name the validator refuses is skipped */ }
  }
}
