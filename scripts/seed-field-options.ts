// Manual re-seed of a community's gotra + village dropdown lists. The same seed
// also runs automatically on server boot (see database/seedCommunityFields.ts);
// this CLI just lets you force a refresh from the bundled Khandelwal JSON.
//
// Usage:
//   npx ts-node scripts/seed-field-options.ts [slug] [--force]
//   COMMUNITY_SLUG=khandelwal npx ts-node scripts/seed-field-options.ts --force
// Without --force it only fills empty lists (same as boot); --force replaces them.
import dotenv from 'dotenv'
import pool from '../src/utils/db'
import { seedCommunityFields } from '../database/seedCommunityFields'

dotenv.config()

const args = process.argv.slice(2)
const force = args.includes('--force')
const slug = args.find(a => !a.startsWith('--')) ?? process.env.COMMUNITY_SLUG ?? 'khandelwal'

seedCommunityFields({ slug, force })
  .then(() => pool.end())
  .catch(err => { console.error(err); process.exit(1) })
