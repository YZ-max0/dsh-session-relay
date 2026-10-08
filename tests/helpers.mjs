/**
 * A minimal fake DSH host for testing `session-relay` without installing DSH.
 *
 * The plugin only ever touches a handful of surface points, so a faithful fake is
 * small and — crucially — makes the test suite **zero-dependency**: CI needs no
 * network, and the suite cannot break when `@deepseek-ai/*` publishes new versions.
 *
 * What is faked, and why each piece is needed:
 *
 *   - `Agent`        — the plugin calls `followup()` / `steer()` / `inject()` and reads
 *                      `id`, `status`, `session.header`, `session.snapshotEvents()`.
 *                      We record deliveries instead of driving a real loop.
 *   - `ctx.get(name)`— the plugin resolves every optional service through `ctx.get()`
 *                      (never `ctx.name`), which is exactly what DSH recommends for
 *                      optional dependencies. So the fake only has to implement `get`.
 *   - `sessionController.resolveAgent(id)`
 *                    — the authoritative target resolver. In DSH it also performs cold
 *                      resume and rejects subagent-owned sessions; here it consults a map
 *                      so tests can express "exists" / "missing" / "rejected" directly.
 *   - `ctx.tools.register(definition)`
 *                    — captures definitions so tests can validate their JSON Schema and
 *                      invoke their bodies, mirroring what the real registry does.
 *
 * The fake deliberately does **not** reimplement schema validation, message freezing or
 * inbox semantics: tests assert on the plugin's own behaviour, and the integration test
 * file covers the real DSH contracts when DSH happens to be installed.
 */

/** A recorded delivery on a fake agent. */
const deliveries = Symbol('deliveries')

/**
 * Build one fake agent.
 * @param options - identity, workspace, and behaviour switches.
 * @returns a fake Agent plus test-only helpers on a private symbol.
 */
export function makeAgent({
  id,
  cwd,
  status = 'idle',
  origin,
  parentSession,
  createdAt = 1_700_000_000_000,
  events = [],
} = {}) {
  if (typeof id !== 'string' || id === '') throw new Error('makeAgent requires a non-empty id')
  // A live log that grows as deliveries arrive, mirroring the real loop: DSH appends each
  // claimed inbox message as a `user/message` event (`agent-loop/src/agent.ts`). Tests that
  // depend on *what a session can see about its own history* — the report-target suggestion
  // reads the sender of the last relayed message — need this to be faithful, otherwise the
  // fake would silently under-report and look like a plugin bug.
  const log = [...events]
  const agent = {
    id,
    status,
    session: {
      header: {
        id,
        cwd,
        createdAt,
        ...origin === undefined ? {} : { origin },
        ...parentSession === undefined ? {} : { parentSession },
      },
      snapshotEvents: () => log,
    },
    // Deliveries land in one list so tests can tell queue/steer apart by order and
    // still assert on the message objects themselves.
    followup(message) { this[deliveries].push({ kind: 'followup', message }); append(message) },
    steer(message) { this[deliveries].push({ kind: 'steer', message }); append(message) },
    inject(message) { this[deliveries].push({ kind: 'inject', message }); append(message) },
  }
  // Waking and non-waking deliveries both become log events in DSH; a receipt is written by
  // the runtime *into the sender's* log, which is exactly what `inject` models here.
  const append = (message) => {
    log.push({ type: 'user/message', data: message, seq: log.length, time: 1_700_000_000_000 + log.length })
  }
  agent[deliveries] = []
  return agent
}

/** Every delivery recorded on a fake agent, in call order. */
export function deliveriesOf(agent) {
  return agent[deliveries]
}

/** Messages delivered via `followup`/`steer` (i.e. going to another collaborator). */
export function messagesDeliveredTo(agent) {
  return agent[deliveries].filter(entry => entry.kind !== 'inject').map(entry => entry.message)
}

/** Messages injected into this agent (i.e. runtime receipts written back to the sender). */
export function receiptsWrittenTo(agent) {
  return agent[deliveries].filter(entry => entry.kind === 'inject').map(entry => entry.message)
}

/**
 * Build a fake DSH context around a set of agents.
 *
 * @param options - agents, optional workspace listing, and optional resolver override.
 * @returns `{ ctx, tools, calls, agents }` for assertions.
 */
export function makeContext({
  agents = [],
  /** Extra session records returned by `sessionQuery.listSessions()` (cold sessions). */
  listedSessions,
  /** Extra role-registry seeding is done through the tool, like a real deployment. */
  rolesFile,
  /** Force `resolveAgent` behaviour: `(id) => ({ agent }) | ({ error }) | undefined`. */
  resolveAgent,
  /** Omit services to exercise the plugin's degraded paths. */
  omit = [],
} = {}) {
  const byId = new Map(agents.map(agent => [agent.id, agent]))
  const tools = new Map()
  const calls = []

  const omitted = new Set(omit)
  const service = (name, value) => (omitted.has(name) ? undefined : value)

  const ctx = {
    get(name) {
      switch (name) {
        case 'agents':
          return service('agents', {
            get: id => byId.get(id),
            list: () => [...byId.values()],
          })
        case 'sessions':
          return service('sessions', {
            get: id => byId.get(id)?.session,
            list: () => [...byId.values()].map(agent => agent.session),
          })
        case 'sessionQuery':
          return service('sessionQuery', {
            listSessions: async () => listedSessions ?? [...byId.values()].map(agent => ({
              header: agent.session.header,
              live: true,
              persisted: true,
            })),
          })
        case 'sessionProjections':
          return service('sessionProjections', {
            snapshot: () => ({ values: {} }),
          })
        case 'sessionProjectionCache':
          return service('sessionProjectionCache', { cachedSnapshot: () => undefined })
        case 'sessionController':
          return service('sessionController', {
            resolveAgent: async (id) => {
              if (resolveAgent !== undefined) {
                const outcome = resolveAgent(id)
                if (outcome !== undefined) return outcome
              }
              const agent = byId.get(id)
              return agent === undefined
                ? { error: new Error(`session "${id}" not found`) }
                : { agent }
            },
          })
        default:
          return undefined
      }
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    effect(factory) {
      const disposer = factory()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    logger: { warn() {}, info() {}, error() {} },
    // The role registry writes to disk; tests redirect it via the plugin config env.
    // Exposed for symmetry with real DSH contexts.
    on() { return () => {} },
    emit() {},
    calls,
  }

  return { ctx, tools, calls, agents: byId, rolesFile }
}

/**
 * Invoke a captured tool definition the way the real registry would: validate the
 * value shape lightly, then call the body.
 * @param tools - map captured from `makeContext`.
 * @param name - tool name.
 * @param args - model-supplied arguments.
 * @param exec - execution context; `agent` and `signal` are the fields the plugin uses.
 * @returns the tool's value, or throws whatever the plugin throws.
 */
export async function callTool(tools, name, args, exec = {}) {
  const definition = tools.get(name)
  if (definition === undefined) throw new Error(`tool "${name}" is not registered`)
  return definition.execute(args, { signal: new AbortController().signal, ...exec })
}

/**
 * Run a tool and capture whether it rejected, since the plugin signals every failure by
 * throwing (the real registry turns that into an `isError` result). Tests assert on the
 * message text, so returning it beats `expect(...).rejects` noise.
 * @param tools - map captured from `makeContext`.
 * @param name - tool name.
 * @param args - model-supplied arguments.
 * @param exec - execution context.
 * @returns `{ ok, value, error }`.
 */
export async function tryTool(tools, name, args, exec = {}) {
  try {
    return { ok: true, value: await callTool(tools, name, args, exec) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}
