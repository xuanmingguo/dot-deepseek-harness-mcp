import path from 'node:path'

/** Check local inline/reference Markdown destinations against the package inventory. */
export function validatePackageDocLinks(documents, filePaths) {
  const files = new Set(filePaths)
  const errors = []
  let localLinks = 0
  for (const [source, markdown] of documents) {
    const text = markdown.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1\s*$/gm, '')
      .replace(/(`+)[^\n]*?\1/g, '')
    const inline = /!?\[[^\]\n]*\]\(\s*(<[^>\n]+>|(?:\\.|[^()\s]|\([^()\n]*\))+)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*\)/g
    const references = /^ {0,3}\[[^\]\n]+\]:\s*(<[^>\n]+>|[^\s]+)/gm
    for (const match of [...text.matchAll(inline), ...text.matchAll(references)]) {
      const destination = match[1].replace(/^<|>$/g, '').replace(/\\([ ()])/g, '$1')
      if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(destination)) continue
      const encoded = destination.split(/[?#]/, 1)[0]
      if (!encoded) continue
      localLinks++
      let target
      try { target = decodeURIComponent(encoded) }
      catch { errors.push(`${source}: malformed link ${destination}`); continue }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(source), target))
      if (target.startsWith('/') || resolved === '..' || resolved.startsWith('../')) {
        errors.push(`${source}: link escapes package: ${destination}`)
      } else if (!files.has(resolved)) {
        errors.push(`${source}: missing packaged link target ${resolved} (${destination})`)
      }
    }
  }
  return { valid: errors.length === 0, localLinks, errors }
}
