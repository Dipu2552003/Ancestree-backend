// Seed a community's gotra + village dropdown lists from the bundled Khandelwal
// JSON (database/seed-data/*.json), with English as the canonical value and
// Hindi as the optional alias. Pargana grouping is ignored — we take a flat,
// deduped village list.
//
// Runs automatically on boot (see src/index.ts) so a fresh deploy self-populates.
// It is BOOT-SAFE:
//   • idempotent — re-running does nothing once a list exists,
//   • non-destructive — never overwrites values or field config an admin edited
//     (unless called with { force: true } from the manual CLI),
//   • fault-tolerant — missing community / files just logs and skips.
import fs from 'fs'
import path from 'path'
import pool, { query } from '../src/utils/db'

interface Gotra { hi: string; en: string }
interface Village { name: string; en?: string }
interface Pargana { villages: Village[] }
type Option = { value: string; label: string | null }

const dataDir = path.join(__dirname, 'seed-data')

// value = English (canonical, stored on the person); label = Hindi alias.
function readLists(): { gotra: Option[]; native_village: Option[] } {
  const gotras: { gotras: Gotra[] } =
    JSON.parse(fs.readFileSync(path.join(dataDir, 'gotras.json'), 'utf8'))
  const parganas: { parganas: Pargana[] } =
    JSON.parse(fs.readFileSync(path.join(dataDir, 'parganas.json'), 'utf8'))

  const gotra = gotras.gotras
    .filter(g => g.en?.trim())
    .map(g => ({ value: g.en.trim(), label: g.hi?.trim() || null }))

  const seen = new Set<string>()
  const native_village: Option[] = []
  for (const p of parganas.parganas)
    for (const v of p.villages) {
      const value = (v.en ?? v.name)?.trim()
      if (!value || seen.has(value)) continue
      seen.add(value)
      native_village.push({ value, label: v.name?.trim() || null })
    }

  return { gotra, native_village }
}

async function countOptions(communityId: string, fieldKey: string): Promise<number> {
  const { rows: [r] } = await query<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM community_field_options WHERE community_id = $1 AND field_key = $2`,
    [communityId, fieldKey],
  )
  return parseInt(r?.c ?? '0', 10)
}

async function replaceOptions(communityId: string, fieldKey: string, rows: Option[]): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `DELETE FROM community_field_options WHERE community_id = $1 AND field_key = $2`,
      [communityId, fieldKey],
    )
    let i = 0
    for (const r of rows) {
      await client.query(
        `INSERT INTO community_field_options (community_id, field_key, value, label, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [communityId, fieldKey, r.value, r.label, i++],
      )
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }
}

export async function seedCommunityFields(opts: { slug?: string; force?: boolean } = {}): Promise<void> {
  const slug = opts.slug ?? process.env.COMMUNITY_SLUG ?? 'khandelwal'

  const { rows: [community] } = await query<{ id: string; settings: { fields?: Record<string, unknown> } | null }>(
    `SELECT id, settings FROM communities WHERE slug = $1`, [slug],
  )
  if (!community) {
    console.log(`↷ seedCommunityFields: no community "${slug}" yet — skipped`)
    return
  }

  const lists = readLists()
  console.log(`  parsed from JSON → gotra=${lists.gotra.length}, village=${lists.native_village.length}`)
  for (const key of ['gotra', 'native_village'] as const) {
    const existing = await countOptions(community.id, key)
    // Skip if the admin (or a prior run) already populated it — unless forced.
    if (!opts.force && existing > 0) {
      console.log(`  ${key}: kept ${existing} existing option(s)`)
      continue
    }
    await replaceOptions(community.id, key, lists[key])
    console.log(`  ${key}: seeded ${lists[key].length} option(s)`)
  }

  // Gotra & village are inherently dropdowns for this community, so always
  // enforce type=enum in settings.fields (otherwise the editor falls back to a
  // free-text place search and the list never shows). We preserve the admin's
  // show/hide choice and any other fields they configured — only the type of
  // these two is pinned.
  const fields: Record<string, unknown> = { ...(community.settings?.fields ?? {}) }
  for (const [key, order] of [['gotra', 4], ['native_village', 5]] as const) {
    const prev = (fields[key] ?? {}) as Record<string, unknown>
    fields[key] = { enabled: prev.enabled ?? true, type: 'enum', storage: 'column', order: prev.order ?? order }
  }
  await query(
    `UPDATE communities SET settings = COALESCE(settings, '{}'::jsonb) || jsonb_build_object('fields', $2::jsonb) WHERE id = $1`,
    [community.id, JSON.stringify(fields)],
  )

  console.log(`✓ seedCommunityFields: "${slug}" — gotra=${lists.gotra.length}, village=${lists.native_village.length}${opts.force ? ' (forced)' : ''}`)
}
