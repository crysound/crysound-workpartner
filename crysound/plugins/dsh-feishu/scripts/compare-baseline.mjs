/** Compare top-level lib JavaScript bytes; write per-file SHA-256 evidence without importing either package. */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
const [source, published, report] = process.argv.slice(2)
const files = dir => readdirSync(dir).filter(name => name.endsWith('.js')).sort()
const built = files(source), packed = files(published)
const names = [...new Set([...built, ...packed])].sort()
const sha256 = data => createHash('sha256').update(data).digest('hex')
const rows = names.map(file => {
  const a = built.includes(file) ? readFileSync(join(source, file)) : undefined
  const b = packed.includes(file) ? readFileSync(join(published, file)) : undefined
  return { file, builtSha256: a && sha256(a), npmSha256: b && sha256(b), equal: a !== undefined && b !== undefined && a.equals(b) }
})
const result = { builtFiles: built.length, npmFiles: packed.length, identical: rows.every(row => row.equal), files: rows }
writeFileSync(report, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify({ ...result, files: rows.filter(row => !row.equal) }, null, 2))
process.exitCode = result.identical ? 0 : 1
