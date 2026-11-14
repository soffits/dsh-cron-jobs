// The browser half registers itself under an id that must equal the package
// name, or DSH's module loader never finds it and the Cron tasks page breaks.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('client.js registers under the package name', async () => {
  let entry
  globalThis.window = { __ModuleLoader__: { load: (module) => { entry = module } } }
  try {
    const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
    new Function(source)()
  } finally {
    delete globalThis.window
  }
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(entry.id, pkg.name)
  assert.equal(typeof entry.factory, 'function')
})
