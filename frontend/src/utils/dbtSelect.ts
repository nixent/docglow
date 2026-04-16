/**
 * Parse dbt model selection syntax and resolve to a set of model unique_ids.
 *
 * Supported syntax:
 *   model_name          — pin that model
 *   +model_name         — pin model + all upstream
 *   model_name+         — pin model + all downstream
 *   +model_name+        — pin model + upstream + downstream
 *   tag:finance         — pin all models with that tag
 *   stg_*               — glob pattern on model name
 *   fct_*+              — glob with downstream expansion
 *
 * Space-separated expressions are unioned:
 *   "+fct_orders +dim_customers tag:finance"
 */

import type { LineageNode, LineageEdge } from '../types'
import { getUpstream, getDownstream } from './graphTraversal'

export interface DbtSelectResult {
  matched: Set<string>
  errors: string[]
}

function globToRegex(pattern: string): RegExp {
  // Escape regex specials except * which we translate to .*
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`, 'i')
}

function isGlob(s: string): boolean {
  return s.includes('*')
}

/** Find nodes matching a single selector token (without +/+ markers). */
function matchToken(
  token: string,
  nodes: LineageNode[],
  nodesById: Map<string, LineageNode>,
): string[] {
  // tag:xyz
  if (token.startsWith('tag:')) {
    const tag = token.slice(4).toLowerCase()
    return nodes
      .filter(n => (n.tags ?? []).some(t => t.toLowerCase() === tag))
      .map(n => n.id)
  }

  // glob pattern
  if (isGlob(token)) {
    const regex = globToRegex(token)
    return nodes.filter(n => regex.test(n.name)).map(n => n.id)
  }

  // exact unique_id match
  if (nodesById.has(token)) return [token]

  // exact name match
  const byName = nodes.filter(n => n.name === token)
  if (byName.length > 0) return byName.map(n => n.id)

  // case-insensitive name match (last resort)
  const byNameCi = nodes.filter(n => n.name.toLowerCase() === token.toLowerCase())
  return byNameCi.map(n => n.id)
}

export function resolveDbtSelection(
  expression: string,
  nodes: LineageNode[],
  edges: LineageEdge[],
): DbtSelectResult {
  const matched = new Set<string>()
  const errors: string[] = []
  const nodesById = new Map(nodes.map(n => [n.id, n]))

  const tokens = expression.trim().split(/\s+/).filter(Boolean)

  for (const rawToken of tokens) {
    let token = rawToken
    const upstream = token.startsWith('+')
    if (upstream) token = token.slice(1)
    const downstream = token.endsWith('+')
    if (downstream) token = token.slice(0, -1)

    if (!token) {
      errors.push(`Empty selector in "${rawToken}"`)
      continue
    }

    const hits = matchToken(token, nodes, nodesById)
    if (hits.length === 0) {
      errors.push(`No matches for "${rawToken}"`)
      continue
    }

    for (const id of hits) {
      matched.add(id)
      if (upstream) {
        for (const u of getUpstream(id, edges)) matched.add(u)
      }
      if (downstream) {
        for (const d of getDownstream(id, edges)) matched.add(d)
      }
    }
  }

  return { matched, errors }
}
