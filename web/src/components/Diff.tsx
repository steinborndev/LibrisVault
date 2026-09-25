/**
 * A unified diff, rendered (TASKS-DEFECT-PATHS 3.7).
 *
 * The server produces the diff (`diffOf`, a real longest-common-subsequence walk, so a removed
 * line does not make every line after it read as changed); this only colours it. Deliberately
 * no parsing beyond the first character of each line: what arrives is the diff the apply was
 * planned against, and a renderer that reinterpreted it could show something the write does
 * not do.
 *
 * THE LINES ARE VAULT TEXT. They render as data - monospace, wrapped, never styled as prose -
 * because a page's own sentences appearing in the dashboard's voice is how a reader stops
 * being able to tell what the service wrote from what the vault says.
 */

import React from 'react'

/** Which kind a diff line is, from its first character alone. */
function kindOf(line: string): 'add' | 'del' | 'meta' | 'ctx' {
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  if (line.startsWith('@')) return 'meta'
  return 'ctx'
}

export function Diff({ text, max = 60 }: { text: string; max?: number }): React.ReactElement {
  const lines = text.split('\n')
  const shown = lines.slice(0, max)
  return (
    <div className="diff">
      {shown.map((line, i) => (
        <div className={`diff-line ${kindOf(line)}`} key={i}>
          {line === '' ? ' ' : line}
        </div>
      ))}
      {lines.length > shown.length && <div className="diff-line meta">… {lines.length - shown.length} further line(s)</div>}
    </div>
  )
}
