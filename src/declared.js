/**
 * Declared sets: jobs kept in a file somewhere else (a repository, a home's
 * config) and applied here as a whole, the way `kubectl apply --prune` works
 * with an ApplySet. Each member is an ordinary stored job tagged
 * `declared: { set, key }`; applying a set creates the keys that are new,
 * changes only the fields that differ, and removes the members that left the
 * list. Jobs made with the tools and members of other sets are never touched.
 *
 * This module plans; `CronJobs.applyDeclared` carries the plan out.
 */
import { checkPatterns } from './events.js'
import { scheduleFromInput } from './schedule.js'

/** A declared set that cannot be applied; nothing was changed. `code` is invalid_set or invalid_job. */
export class DeclaredSetError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DeclaredSetError'
    this.code = code
  }
}

/** Set names and keys: letters, digits and . _ - (a key is usually a slug like plan-review). */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/u
export const MAX_DECLARED_JOBS = 1000

/** The fields a declared entry sets; everything else on a stored job (run state, dates) is the plugin's. */
export const MANAGED_FIELDS = Object.freeze(['title', 'prompt', 'command', 'schedule', 'on', 'once', 'coalesceSeconds', 'cwd', 'preset', 'target', 'deliver', 'model', 'timeoutSeconds', 'paused'])

const ENTRY_FIELDS = new Set(['key', 'adopt', 'title', 'prompt', 'command', 'cron', 'rrule', 'at', 'timeZone', 'on', 'once', 'coalesceSeconds', 'cwd', 'preset', 'target', 'sessionId', 'deliver', 'model', 'timeoutSeconds', 'paused'])

export function checkSetName(set) {
  if (typeof set !== 'string' || !NAME.test(set)) throw new DeclaredSetError('invalid_set', `set must be a name of letters, digits and . _ - (at most 100), not ${JSON.stringify(set)}`)
  return set
}

/**
 * One entry of a declared set as the managed fields of a stored job.
 * Entry fields follow the create tool (flat cron/rrule/at/timeZone,
 * deliver as "<service>:<address>" or "none"), plus `key`, `adopt`,
 * `preset`, `timeoutSeconds` and `paused`.
 * @returns {{ key: string, adopt?: string, desired: object }}
 * @throws {DeclaredSetError}
 */
export function desiredJob(entry, index = 0) {
  const where = `jobs[${index}]`
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new DeclaredSetError('invalid_job', `${where} must be an object`)
  const unknown = Object.keys(entry).filter(field => !ENTRY_FIELDS.has(field))
  if (unknown.length > 0) throw new DeclaredSetError('invalid_job', `${where}: unknown field ${unknown.join(', ')}`)
  const key = entry.key
  if (typeof key !== 'string' || !NAME.test(key)) throw new DeclaredSetError('invalid_job', `${where}: key must be a name of letters, digits and . _ - (at most 100)`)
  const at = `${where} (${key})`
  try {
    const title = typeof entry.title === 'string' ? entry.title.trim() : ''
    if (title === '') throw new Error('title must not be empty')
    if (title.length > 200) throw new Error('title is longer than 200 characters')
    const desired = { title }
    for (const field of ['prompt', 'command']) {
      if (entry[field] === undefined) continue
      if (typeof entry[field] !== 'string') throw new Error(`${field} must be a string`)
      if (entry[field].trim() !== '') desired[field] = entry[field]
    }
    if (!desired.prompt && !desired.command) throw new Error('a job needs a prompt, a command, or both')
    const scheduled = ['cron', 'rrule', 'at'].some(field => typeof entry[field] === 'string' && entry[field].trim() !== '')
    if (scheduled) desired.schedule = scheduleFromInput({ cron: entry.cron, rrule: entry.rrule, at: entry.at, timeZone: entry.timeZone })
    if (entry.on !== undefined) {
      if (!Array.isArray(entry.on)) throw new Error('on must be a list of channel patterns')
      const on = checkPatterns(entry.on)
      if (on.length > 0) desired.on = on
    }
    if (desired.schedule === undefined && desired.on === undefined) throw new Error('a job needs a schedule, on (event channels), or both')
    if (entry.once === true) desired.once = true
    else if (entry.once !== undefined && entry.once !== false) throw new Error('once must be true or false')
    for (const field of ['coalesceSeconds', 'timeoutSeconds']) {
      if (entry[field] === undefined) continue
      if (!Number.isInteger(entry[field]) || entry[field] < 0) throw new Error(`${field} must be a whole number, 0 or more`)
      desired[field] = entry[field]
    }
    for (const field of ['cwd', 'preset']) {
      if (entry[field] === undefined || entry[field] === '') continue
      if (typeof entry[field] !== 'string') throw new Error(`${field} must be a string`)
      desired[field] = entry[field]
    }
    desired.target = target(entry)
    const deliver = parseDeliver(entry.deliver)
    if (deliver !== undefined) desired.deliver = deliver
    if (entry.model !== undefined && entry.model !== null) desired.model = model(entry.model)
    if (entry.paused !== undefined && typeof entry.paused !== 'boolean') throw new Error('paused must be true or false')
    desired.paused = entry.paused === true
    if (entry.adopt !== undefined && (typeof entry.adopt !== 'string' || entry.adopt === '')) throw new Error('adopt must be a job id')
    return { key, ...(entry.adopt ? { adopt: entry.adopt } : {}), desired }
  } catch (error) {
    if (error instanceof DeclaredSetError) throw new DeclaredSetError(error.code, `${at}: ${error.message}`)
    throw new DeclaredSetError('invalid_job', `${at}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function target(entry) {
  if (entry.sessionId !== undefined && entry.sessionId !== '') {
    if (typeof entry.sessionId !== 'string') throw new Error('sessionId must be a string')
    return { kind: 'session', sessionId: entry.sessionId }
  }
  const kind = entry.target ?? 'new'
  if (kind !== 'new' && kind !== 'new_once') throw new Error('target must be new or new_once (or give sessionId)')
  return { kind }
}

/** "<service>:<address>", "none", or omitted / "default" for the plugin's target. */
export function parseDeliver(value) {
  if (value === undefined || value === null || value === 'default') return undefined
  if (value === false || value === 'none') return false
  if (typeof value === 'object' && !Array.isArray(value) && typeof value.via === 'string' && value.via !== '') return { via: value.via, to: String(value.to ?? '') }
  if (typeof value !== 'string') throw new Error('deliver must be "<service>:<address>", "none" or "default"')
  const colon = value.indexOf(':')
  const via = (colon === -1 ? value : value.slice(0, colon)).trim()
  const to = colon === -1 ? '' : value.slice(colon + 1).trim()
  if (!/^[A-Za-z_$][\w$.-]*$/u.test(via)) throw new Error(`deliver must be "<service>:<address>", "none" or "default", not ${JSON.stringify(value)}`)
  return { via, to }
}

function model(value) {
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('model must be an object')
  if (typeof value.provider !== 'string' || value.provider === '' || typeof value.model !== 'string' || value.model === '') throw new Error('model needs both provider and model')
  return { provider: value.provider, model: value.model, ...(typeof value.reasoningEffort === 'string' && value.reasoningEffort !== '' ? { reasoningEffort: value.reasoningEffort } : {}) }
}

/** The managed fields of a stored job, in the same shape as desiredJob's. */
export function currentJob(record) {
  const out = {}
  for (const field of MANAGED_FIELDS) {
    if (field === 'paused') out.paused = record.status === 'paused'
    else if (field === 'target') out.target = record.target?.kind === 'session' ? { kind: 'session', sessionId: record.target.sessionId } : { kind: record.target?.kind ?? 'new' }
    else if (record[field] !== undefined && !(field === 'on' && record.on.length === 0)) out[field] = record[field]
  }
  return out
}

/** Fields whose values differ: { field: { from, to } } (undefined = unset). */
export function differences(current, desired) {
  const changes = {}
  for (const field of MANAGED_FIELDS) {
    if (canonical(current[field]) !== canonical(desired[field])) changes[field] = { from: current[field], to: desired[field] }
  }
  return changes
}

function canonical(value) {
  if (value === undefined) return 'undefined'
  return JSON.stringify(value, (_key, inner) => (inner && typeof inner === 'object' && !Array.isArray(inner)
    ? Object.fromEntries(Object.keys(inner).sort().map(name => [name, inner[name]]))
    : inner))
}

/**
 * What applying `entries` as set `set` would do to `stored` (every stored job).
 * @param {{ set: string, entries: unknown[], stored: object[], prune?: boolean }} input
 * @returns {{ create: object[], update: object[], adopt: object[], remove: object[], unchanged: object[] }}
 * @throws {DeclaredSetError} for any invalid entry, a duplicate key, or an adopt that would take another set's job; nothing is planned then.
 */
export function planDeclared({ set, entries, stored, prune = true }) {
  checkSetName(set)
  if (!Array.isArray(entries)) throw new DeclaredSetError('invalid_set', 'jobs must be a list')
  if (entries.length > MAX_DECLARED_JOBS) throw new DeclaredSetError('invalid_set', `a set holds at most ${MAX_DECLARED_JOBS} jobs`)
  const wanted = entries.map((entry, index) => desiredJob(entry, index))
  const seen = new Set()
  for (const { key } of wanted) {
    if (seen.has(key)) throw new DeclaredSetError('invalid_set', `key ${key} appears twice`)
    seen.add(key)
  }
  const byId = new Map(stored.map(record => [record.id, record]))
  const members = new Map(stored.filter(record => record.declared?.set === set).map(record => [record.declared.key, record]))
  const plan = { create: [], update: [], adopt: [], remove: [], unchanged: [] }
  const adopted = new Set()
  for (const { key, adopt, desired } of wanted) {
    let record = members.get(key)
    let action = 'update'
    if (record === undefined && adopt !== undefined) {
      const candidate = byId.get(adopt)
      if (candidate?.declared && (candidate.declared.set !== set || members.has(candidate.declared.key))) {
        throw new DeclaredSetError('invalid_set', `${key}: job ${adopt} already belongs to ${candidate.declared.set}/${candidate.declared.key}`)
      }
      if (candidate !== undefined && candidate.status !== 'ended') {
        if (adopted.has(adopt)) throw new DeclaredSetError('invalid_set', `${key}: job ${adopt} is adopted twice`)
        adopted.add(adopt)
        record = candidate
        action = 'adopt'
      }
    }
    if (record === undefined) {
      plan.create.push({ key, title: desired.title, desired })
      continue
    }
    const changes = differences(currentJob(record), desired)
    const entry = { id: record.id, key, title: desired.title, desired, changes }
    if (action === 'adopt') plan.adopt.push(entry)
    else if (Object.keys(changes).length > 0) plan.update.push(entry)
    else plan.unchanged.push({ id: record.id, key, title: desired.title })
  }
  if (prune) {
    for (const [key, record] of members) {
      if (!seen.has(key)) plan.remove.push({ id: record.id, key, title: record.title })
    }
  }
  return plan
}
