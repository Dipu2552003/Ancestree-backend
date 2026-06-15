// tsc only compiles .ts files, so the raw .sql migrations are left out of dist/.
// The boot-time migrator (database/migrate.ts) reads them from
// dist/database/migrations at runtime, so copy them there after every build.
const fs = require('fs')
const path = require('path')

const src = path.join(__dirname, '..', 'database', 'migrations')
const dest = path.join(__dirname, '..', 'dist', 'database', 'migrations')

fs.mkdirSync(dest, { recursive: true })
fs.cpSync(src, dest, { recursive: true })
console.log(`✓ copied migrations → ${dest}`)
