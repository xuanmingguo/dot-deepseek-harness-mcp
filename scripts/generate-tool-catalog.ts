import { writeFile } from 'node:fs/promises'
import { createProductToolCatalog } from '../src/mcp-server/mcp-server-factory.js'

// A portable reference, never derived from this machine's environment.
const tools = await createProductToolCatalog()
await writeFile(new URL('../docs/tool-catalog.json', import.meta.url), `${JSON.stringify(tools, null, 2)}\n`)
