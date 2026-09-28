import { describe, expect, it, vi } from 'vitest'
import { ToolViews, type ToolRegistryLike } from '../src/tool-views.js'

function registry(tools: Record<string, unknown>): ToolRegistryLike {
  return { get: name => tools[name] as never }
}

function callEvent(callId: string, name: string, args: string): unknown {
  return { type: 'tool/call', seq: 1, time: 1, data: { turn: 1, step: 1, callId, name, arguments: args } }
}

function resultEvent(callId: string, extra: Record<string, unknown> = {}): unknown {
  return {
    type: 'tool/result', seq: 2, time: 2,
    data: {
      turn: 1, step: 1,
      message: { toolCallId: callId, content: [{ type: 'text', text: 'out' }], isError: false, source: { kind: 'tool', callId } },
      ...extra,
    },
  }
}

describe('ToolViews', () => {
  it('asks the registered tool for its call card', () => {
    const presentCall = vi.fn(() => ({ card: 'read', title: 'Read app.ts' }))
    const views = new ToolViews(() => registry({ read: { presentCall } }))

    expect(views.project('s1', callEvent('c1', 'read', '{"file_path":"app.ts"}'))).toEqual({
      for: 'call',
      view: { card: 'read', title: 'Read app.ts' },
    })
    expect(presentCall).toHaveBeenCalledWith({ file_path: 'app.ts' })
  })

  it('reconstructs the result the tool declared, from the durable event alone', () => {
    const presentResult = vi.fn(() => ({ card: 'terminal', output: 'out', exitCode: 0 }))
    const views = new ToolViews(() => registry({ bash: { presentResult } }))
    views.project('s1', callEvent('c1', 'bash', '{"command":"echo out"}'))

    expect(views.project('s1', resultEvent('c1', { meta: { exitCode: 0 } }))).toEqual({
      for: 'result',
      view: { card: 'terminal', output: 'out', exitCode: 0 },
    })
    // The tool sees parsed arguments plus content/isError/meta — the same shape
    // the host hands its own presenters.
    expect(presentResult).toHaveBeenCalledWith(
      { command: 'echo out' },
      { content: [{ type: 'text', text: 'out' }], isError: false, meta: { exitCode: 0 } },
    )
  })

  it('declines whenever it cannot present, so the App falls back to raw text', () => {
    const throwing = new ToolViews(() => registry({ bash: { presentCall: () => { throw new Error('superseded log') } } }))
    expect(throwing.project('s1', callEvent('c1', 'bash', '{"command":"ls"}'))).toBeUndefined()

    const noPresenter = new ToolViews(() => registry({ bash: {} }))
    expect(noPresenter.project('s1', callEvent('c1', 'bash', '{"command":"ls"}'))).toBeUndefined()

    const unknownTool = new ToolViews(() => registry({}))
    expect(unknownTool.project('s1', callEvent('c1', 'bash', '{"command":"ls"}'))).toBeUndefined()

    const noRegistry = new ToolViews(() => undefined)
    expect(noRegistry.project('s1', callEvent('c1', 'bash', '{"command":"ls"}'))).toBeUndefined()

    // Free-form arguments have no parse, so the call stays generic.
    const unparseable = new ToolViews(() => registry({ apply_patch: { presentCall: vi.fn() } }))
    expect(unparseable.project('s1', callEvent('c1', 'apply_patch', '*** Begin Patch'))).toBeUndefined()

    // A result whose call was never seen has no name to present with.
    const orphan = new ToolViews(() => registry({ bash: { presentResult: vi.fn(() => ({ card: 'terminal' })) } }))
    expect(orphan.project('s1', resultEvent('missing'))).toBeUndefined()
  })

  it('presents an argument-less call and ignores non-tool events', () => {
    const presentCall = vi.fn(() => ({ card: 'generic', title: 'List agents' }))
    const views = new ToolViews(() => registry({ list_agents: { presentCall } }))

    expect(views.project('s1', callEvent('c1', 'list_agents', ''))).toEqual({
      for: 'call',
      view: { card: 'generic', title: 'List agents' },
    })
    expect(presentCall).toHaveBeenCalledWith({})
    expect(views.project('s1', { type: 'user/message', seq: 3, time: 3, data: {} })).toBeUndefined()
    // PTC sub-calls stay plain rows in the App.
    expect(views.project('s1', { type: 'tool/ptc-dispatch', seq: 4, time: 4, data: {} })).toBeUndefined()
  })

  it('keeps calls per session and bounded in number', () => {
    const presentResult = vi.fn(() => ({ card: 'terminal' }))
    const views = new ToolViews(() => registry({ bash: { presentResult } }))
    views.project('s1', callEvent('c1', 'bash', '{"command":"one"}'))
    // The same call id in another session is not a match for this one.
    views.project('s2', callEvent('c2', 'bash', '{"command":"two"}'))
    expect(views.project('s2', resultEvent('c1'))).toBeUndefined()
    expect(views.project('s1', resultEvent('c1'))).toMatchObject({ for: 'result' })

    for (let index = 0; index < 600; index += 1) {
      views.project('s3', callEvent(`bulk-${index}`, 'bash', '{"command":"x"}'))
    }
    // The oldest call aged out; the newest still presents.
    expect(views.project('s3', resultEvent('bulk-0'))).toBeUndefined()
    expect(views.project('s3', resultEvent('bulk-599'))).toMatchObject({ for: 'result' })
  })
})
