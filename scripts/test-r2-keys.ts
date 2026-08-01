// Self-check for r2.ts pure logic (no network). Run: ts-node scripts/test-r2-keys.ts
import assert from 'assert'
import { parseDataUrl, photoKey } from '../src/utils/r2'

// base64 data URL round-trips to the right bytes + content type
const png = parseDataUrl('data:image/png;base64,aGVsbG8=')  // "hello"
assert(png !== null)
assert.equal(png!.contentType, 'image/png')
assert.equal(png!.body.toString('utf8'), 'hello')

// non-base64 (percent-encoded) data URL
const txt = parseDataUrl('data:text/plain,hi%20there')
assert.equal(txt!.body.toString('utf8'), 'hi there')

// non-data-URLs are rejected so the write path leaves them untouched
assert.equal(parseDataUrl('https://x/api/photos/1/photo'), null)
assert.equal(parseDataUrl(''), null)

// deterministic, unguessable keys
assert.equal(photoKey('abc-123', 'photo'), 'persons/abc-123/photo.jpg')
assert.equal(photoKey('abc-123', 'thumb'), 'persons/abc-123/thumb.jpg')

console.log('r2 key/parse self-check passed')
