/**
 * Tool presentation for the mobile wire: project each tool's declared render
 * intent into the `session/event` frame's `view` slot.
 *
 * Why this belongs in the bridge. Tools declare how their calls and results
 * should look (`ToolDefinition.presentCall` / `presentResult`), and the harness
 * persists the result-side payload as `meta` on `tool/result` — literally so a
 * UI bridge can reproduce the card on replay. Nothing on the wire, however,
 * carries the resulting `ToolCallView`/`ToolResultView`: the browser builds its
 * own cards client-side from the tool name, arguments and metadata, and the
 * phone has no tool definitions to do that with. So the phone's structured cards
 * (terminal, diff, read, search, web) never fired — it showed raw text for every
 * tool call.
 *
 * The bridge sits inside the host process, where the tool registry *is*
 * reachable, so it can ask each tool the same question the host would:
 * `presentCall(parsedArguments)` and `presentResult(parsedArguments, result)`,
 * with `result` reconstructed exactly from the durable event (content blocks,
 * `isError`, `meta`). No per-tool name tables live here, and a tool that adds a
 * card needs no bridge change.
 *
 * Everything is defensive: an absent registry, absent presenter, unparseable
 * arguments, or a presenter that throws all mean "no view", which the App
 * already renders as the generic raw-text card.
 */

/** The tool's own result shape, as the durable `tool/result` event carries it. */
interface ToolResultLike {
  content: unknown[]
  isError: boolean
  meta?: unknown
}

/** Structural view of one registered tool's presentation half. */
interface ToolPresenter {
  presentCall?: (args: unknown) => unknown
  presentResult?: (args: unknown, result: ToolResultLike) => unknown
}

/**
 * Structural view of the host's tool registry (`ctx.tools`).
 *
 * `get` takes the viewing scope: tools are registered per Agent scope, so the
 * global lookup alone finds almost nothing (the built-in file/terminal tools are
 * scoped). The caller supplies the scope for the event's session.
 */
export interface ToolRegistryLike {
  get: (name: string, scope?: object) => ToolPresenter | null | undefined
}

/** The `view` slot of a `session/event` frame. */
export type ToolEventView = { for: 'call'; view: unknown } | { for: 'result'; view: unknown }

/** Calls remembered per session so a result can find its tool and arguments. */
interface RememberedCall {
  name: string
  args: string
}

/** Cap on remembered calls per session; a long session must not grow forever. */
const MAX_REMEMBERED_CALLS = 500

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Projects tool calls and results into the wire `view` slot, remembering the
 * tool name and raw arguments of each call so the matching result can be
 * presented with them.
 */
export class ToolViews {
  private readonly calls = new Map<string, Map<string, RememberedCall>>()

  constructor(
    private readonly registry: () => ToolRegistryLike | undefined,
    /**
     * The tool-registry scope (the Agent) for one Session. Tools are registered
     * per Agent, so this is what makes a built-in tool's definition reachable.
     */
    private readonly scopeOf?: (sessionId: string) => object | undefined,
  ) {}

  /**
   * One durable event's presentation, ready to ride the frame's `view` slot.
   *
   * @param sessionId - session the event belongs to; calls are remembered per session.
   * @param event - the durable session event about to be published.
   * @returns the view slot, or undefined when nothing can present this event.
   */
  project(sessionId: string, event: unknown): ToolEventView | undefined {
    if (!isRecord(event)) return undefined
    const data = isRecord(event['data']) ? event['data'] : undefined
    if (data === undefined) return undefined
    if (event['type'] === 'tool/call') return this.callView(sessionId, data)
    if (event['type'] === 'tool/result') return this.resultView(sessionId, data)
    // PTC sub-calls stay plain rows in the App; they carry no card today.
    return undefined
  }

  private callView(sessionId: string, data: Record<string, unknown>): ToolEventView | undefined {
    const callId = nonEmpty(data['callId'])
    const name = nonEmpty(data['name'])
    if (callId === undefined || name === undefined) return undefined
    const args = typeof data['arguments'] === 'string' ? data['arguments'] : ''
    const remembered = this.remember(sessionId)
    // Re-announcing a call id (a replay) keeps the first recorded name/args.
    if (!remembered.has(callId)) remembered.set(callId, { name, args })
    const view = this.present(sessionId, name, args, { for: 'call' })
    return view === undefined ? undefined : { for: 'call', view }
  }

  private resultView(sessionId: string, data: Record<string, unknown>): ToolEventView | undefined {
    const message = isRecord(data['message']) ? data['message'] : undefined
    if (message === undefined) return undefined
    const source = isRecord(message['source']) ? message['source'] : undefined
    const callId = nonEmpty(message['toolCallId']) ?? (source === undefined ? undefined : nonEmpty(source['callId']))
    if (callId === undefined) return undefined
    const call = this.calls.get(sessionId)?.get(callId)
    if (call === undefined) return undefined
    const view = this.present(sessionId, call.name, call.args, {
      for: 'result',
      result: {
        content: Array.isArray(message['content']) ? message['content'] : [],
        isError: message['isError'] === true,
        ...(data['meta'] === undefined ? {} : { meta: data['meta'] }),
      },
    })
    return view === undefined ? undefined : { for: 'result', view }
  }

  /** Ask the registered tool; every failure mode means "no card". */
  private present(
    sessionId: string,
    name: string,
    args: string,
    phase: { for: 'call' } | { for: 'result'; result: ToolResultLike },
  ): unknown {
    const registry = this.registry()
    // Scoped first (how every built-in tool is registered), global second.
    const scope = this.scopeOf?.(sessionId)
    const tool = registry?.get(name, scope) ?? registry?.get(name)
    if (tool === undefined || tool === null) {
      this.diagnose(`${name}: ${registry === undefined ? 'no tool registry' : 'not registered'}`)
      return undefined
    }
    const parsed = this.parseArguments(args)
    if (parsed === undefined) {
      this.diagnose(`${name}: unparseable arguments`)
      return undefined
    }
    try {
      if (phase.for === 'call') {
        if (tool.presentCall === undefined) return this.diagnose(`${name}: no presentCall`)
        return tool.presentCall(parsed)
      }
      if (tool.presentResult === undefined) return this.diagnose(`${name}: no presentResult`)
      return tool.presentResult(parsed, phase.result)
    } catch {
      // A tool whose presenter rejects superseded logged output must not break
      // the stream: the App falls back to the raw result.
      return this.diagnose(`${name}: presenter threw`)
    }
  }

  /**
   * First-occurrence diagnostic per reason. A tool that shows raw text in the
   * App has exactly one of these causes — no registry, an unregistered name, an
   * absent presenter, unparseable arguments, or a throwing presenter — so the
   * host log should say which, once, instead of leaving it to guesswork. Bounded
   * by the number of distinct messages, not by traffic.
   */
  private readonly seen = new Set<string>()
  private diagnose(message: string): undefined {
    if (!this.seen.has(message)) {
      this.seen.add(message)
      console.log(`[mobile-bridge] tool view skipped: ${message}`)
    }
    return undefined
  }

  /**
   * Presenters take the parsed arguments. Free-form or partial JSON (which the
   * model can emit) has no parse, so that call stays generic.
   */
  private parseArguments(args: string): unknown | undefined {
    if (args === '') return {}
    try {
      const parsed: unknown = JSON.parse(args)
      return isRecord(parsed) ? parsed : undefined
    } catch {
      return undefined
    }
  }

  private remember(sessionId: string): Map<string, RememberedCall> {
    const existing = this.calls.get(sessionId)
    if (existing !== undefined) {
      // Map preserves insertion order, so the first key is the oldest call.
      if (existing.size >= MAX_REMEMBERED_CALLS) {
        const oldest = existing.keys().next().value
        if (oldest !== undefined) existing.delete(oldest)
      }
      return existing
    }
    const created = new Map<string, RememberedCall>()
    this.calls.set(sessionId, created)
    return created
  }
}
