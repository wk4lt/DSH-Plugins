import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'

const require = createRequire(import.meta.url)

test('installed ssh2 is the documented JS-only vendor copy without build hooks or binaries', () => {
  const manifestPath = require.resolve('ssh2/package.json')
  const root = path.dirname(manifestPath)
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.name, 'ssh2')
  assert.equal(manifest.version, '1.17.0')
  assert.equal(manifest.scripts, undefined)
  assert.equal(manifest.optionalDependencies, undefined)
  assert.equal(manifest.devDependencies, undefined)
  assert(existsSync(path.join(root, 'VENDOR.md')))
  assert(existsSync(path.join(root, 'LICENSE')))
  assert(!existsSync(path.join(root, 'lib/protocol/crypto/src')))
  const checkTree = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue
      assert(!['install.js', 'binding.gyp'].includes(entry.name), entry.name)
      assert(!entry.name.endsWith('.node'), entry.name)
      if (entry.isDirectory()) checkTree(path.join(dir, entry.name))
    }
  }
  checkTree(root)
  assert.equal(typeof require('ssh2').Client, 'function')
  const crypto = require('ssh2/lib/protocol/crypto.js')
  assert.equal(crypto.bindingAvailable, false)
  assert.equal(Object.keys(crypto.CIPHER_INFO).length, 23)
})
