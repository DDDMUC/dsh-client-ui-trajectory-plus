// Source text of this package's own halves, for the mechanical scans.
//
// SOURCES is null in the shipped file and readSource() reads the real files. A test
// harness that runs this suite without a writable filesystem replaces that ONE line
// with the sources it holds in memory, so the scans run against exactly the text
// that ships. Nothing else in the suite changes.
export const SOURCES = null

export async function readSource(name) {
  if (SOURCES !== null && typeof SOURCES[name] === 'string') return SOURCES[name]
  const { readFile } = await import('node:fs/promises')
  const relative =
    name === 'index' ? '../src/index.js' : name === 'client' ? '../src/client.js' : name === 'package' ? '../package.json' : '../src/logic.js'
  return readFile(new URL(relative, import.meta.url), 'utf8')
}
