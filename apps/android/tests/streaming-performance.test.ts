import { describe, expect, it, vi } from 'vitest'
import type { ChatItem, MuxStreamFrame, NativeSessionEvent, RemoteSession } from '../src/types'

const { proxy } = vi.hoisted(() => ({ proxy: { sessionHistory: vi.fn(), messageFeedbackList: vi.fn(), sessionModels: vi.fn() } }))
vi.mock('expo-haptics', () => ({
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
  impactAsync: vi.fn(async () => undefined),
  notificationAsync: vi.fn(async () => undefined),
}))
vi.mock('../src/services/network-route', () => ({}))
vi.mock('../src/services/connection', () => ({ AndroidRemoteConnection: class { requireProxy() { return proxy } } }))
vi.mock('../src/services/storage', () => ({ saveRecentWorkspaces: vi.fn() }))
vi.mock('../src/services/login', () => ({}))
vi.mock('../src/services/server-session', () => ({ serverSession: {} }))

import { useAppStore } from '../src/state/store'
import { chatSections, mergeReplyReasoning, mergeHistoryAndLive } from '../src/state/message-helpers'

const session = { sessionId: 's1', backend: 'harness', running: true } as RemoteSession

/**
 * Build a conversation that looks like a real long research session: many
 * messages and tool rows, with the chunky payloads (tool output) the reducer
 * and the text checks actually have to walk.
 */
function buildLongConversation(turns: number, bodyChars: number): ChatItem[] {
  const items: ChatItem[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    items.push({
      kind: 'message', id: `u${turn}`, sessionId: 's1', role: 'user',
      text: `问题 ${turn} ` + 'q'.repeat(bodyChars), createdAt: turn,
    })
    items.push({
      kind: 'tool', id: `t${turn}`, sessionId: 's1', toolName: 'bash', state: 'finished',
      resultDetail: { text: 'out'.repeat(bodyChars), format: 'markdown' }, createdAt: turn,
    })
    items.push({
      kind: 'message', id: `a${turn}`, sessionId: 's1', role: 'assistant', turn: String(turn),
      text: '答'.repeat(bodyChars), createdAt: turn,
    })
  }
  return items
}

function streamingFrame(turn: number, step: number, text: string): MuxStreamFrame {
  const event = {
    type: 'assistant/chunk', seq: turn * 1000 + step, time: Date.now(),
    data: { turn, step, chunk: { type: 'text-delta', text } },
  } as unknown as NativeSessionEvent
  return { rpcId: '', payload: { type: 'session/event', sessionId: 's1', event } as never }
}

function measure(frames: number, run: (index: number) => void): number {
  run(0) // warm up
  const start = process.hrtime.bigint()
  for (let index = 1; index <= frames; index += 1) run(index)
  return Number(process.hrtime.bigint() - start) / frames / 1e6
}

describe('streaming cost on a long conversation', () => {
  it('keeps the per-frame budget for a long session', () => {
    useAppStore.setState({ ...useAppStore.getInitialState(), selectedSession: session, sessions: [session] })
    const items = buildLongConversation(1000, 400)
    useAppStore.setState({ messages: { s1: items } })
    const count = useAppStore.getState().messages.s1!.length

    // Reducer: the path that runs for every streamed frame.
    const reduce = measure(200, index => {
      useAppStore.getState().handleMuxFrame(streamingFrame(1000, index, '增量文本'))
    })

    // Chat screen derivations, also re-run for every frame.
    const derive = measure(100, index => {
      const next = useAppStore.getState().messages.s1!
      const visible = mergeReplyReasoning(next).filter(item => item.kind !== 'message' || item.role !== 'system')
      chatSections(visible)
    })

    const budget = 16.7 // one 60fps frame
    const perFrame = reduce + derive
    console.log(
      `[perf] items=${count} reduce=${reduce.toFixed(3)}ms derive=${derive.toFixed(3)}ms `
      + `total=${perFrame.toFixed(3)}ms budget=${budget}ms ${perFrame > budget ? 'OVER BUDGET' : 'ok'}`,
    )
    expect(perFrame).toBeLessThan(budget)
  })

  it('does not rebuild the array when an event changes nothing', () => {
    useAppStore.setState({ ...useAppStore.getInitialState(), selectedSession: session, sessions: [session] })
    const items = buildLongConversation(50, 10)
    useAppStore.setState({ messages: { s1: items } })
    const before = useAppStore.getState().messages.s1

    // An event type the reducer ignores must leave the array reference alone so
    // the store selector can skip re-rendering the whole chat screen.
    useAppStore.getState().handleMuxFrame({
      rpcId: '',
      payload: { type: 'session/event', sessionId: 's1', event: { type: 'step/start', seq: 1, time: 1, data: {} } } as never,
    })

    expect(useAppStore.getState().messages.s1).toBe(before)
  })

  it('still enriches the items an event actually replaces', () => {
    useAppStore.setState({ ...useAppStore.getInitialState(), selectedSession: session, sessions: [session] })
    useAppStore.setState({ messages: { s1: buildLongConversation(1, 10) } })
    useAppStore.getState().handleMuxFrame(streamingFrame(7, 3, '新内容'))
    const streaming = useAppStore.getState().messages.s1!.find(item => item.kind === 'message' && item.streaming)
    expect(streaming).toMatchObject({ streaming: true, turn: '7', nativeSeq: 7003 })
  })

  it('merges a long history without degrading', () => {
    const history = buildLongConversation(1000, 200)
    const live = buildLongConversation(1000, 200)
    const start = process.hrtime.bigint()
    const merged = mergeHistoryAndLive(history, live)
    const ms = Number(process.hrtime.bigint() - start) / 1e6
    console.log(`[perf] mergeHistoryAndLive items=${history.length} took ${ms.toFixed(2)}ms`)
    expect(merged).toHaveLength(history.length)
    expect(ms).toBeLessThan(200)
  })
})
