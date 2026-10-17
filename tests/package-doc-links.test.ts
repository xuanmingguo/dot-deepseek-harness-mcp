import assert from 'node:assert/strict'
import test from 'node:test'
// @ts-expect-error build/publication policy is shared as native ESM JavaScript.
import { validatePackageDocLinks } from '../scripts/package-doc-links.mjs'

test('package links resolve from each Markdown file, including encoded paths and references', () => {
  const result = validatePackageDocLinks([
    ['README.md', '[Docs](docs/TOOLS.md#permissions) [upstream][pin]\n[pin]: UPSTREAM.json\n[web](https://example.com/missing.md) [section](#local)'],
    ['docs/TOOLS.md', '[Home](../README.md) [space](<A%20B.md>) ![plot](plot(1).svg)'],
  ], ['README.md', 'UPSTREAM.json', 'docs/TOOLS.md', 'docs/A B.md', 'docs/plot(1).svg'])
  assert.equal(result.valid, true, result.errors.join('\n'))
  assert.equal(result.localLinks, 5)
})

test('missing and escaping package link targets fail even if the source repository has them', () => {
  const result = validatePackageDocLinks([
    ['README.md', '[ops](docs/OPERATIONS.md) [escape](../private.md) [absolute](/opt/private.md) [bad](bad%ZZ.md)'],
  ], ['README.md'])
  assert.equal(result.valid, false)
  assert.equal(result.errors.length, 4)
  assert.match(result.errors[0], /missing packaged link target docs\/OPERATIONS.md/)
  assert.match(result.errors[1], /escapes package/)
})

test('code examples do not require hypothetical files in the package', () => {
  const result = validatePackageDocLinks([
    ['README.md', '```md\n[example](not-shipped.md)\n```\n`[inline](not-shipped.md)`\n[real](UPSTREAM.json)'],
  ], ['README.md', 'UPSTREAM.json'])
  assert.equal(result.valid, true)
  assert.equal(result.localLinks, 1)
})
