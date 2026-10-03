import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MuxStreamFrame, NativeSessionEvent, RemoteSession } from '../src/types'

const { proxy } = vi.hoisted(() => ({ proxy: {
  sessionHistory: vi.fn(), messageFeedbackList: vi.fn(), sessionModels: vi.fn(),
  sessionCancel: vi.fn(),
} }))
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

const session = { sessionId: 's1', backend: 'harness', running: false } as RemoteSession

function chunkFrame(step: number, text: string): MuxStreamFrame {
  const event = {
    type: 'assistant/chunk', seq: step, time: 1700000000000 + step,
    data: { turn: 1, step, chunk: { type: 'text-delta', text } },
  } as unknown as NativeSessionEvent
  return { rpcId: '', payload: { type: 'session/event', sessionId: 's1', event } as never }
}

beforeEach(() => {
  vi.useRealTimers()
  vi.resetAllMocks()
  useAppStore.setState({ ...useAppStore.getInitialState(), selectedSession: session, sessions: [session] })
  proxy.messageFeedbackList.mockResolvedValue([])
  proxy.sessionModels.mockResolvedValue(undefined)
  proxy.sessionCancel.mockResolvedValue(undefined)
})

describe('batched mux frames', () => {
  it('applies a whole batch in a single state update', () => {
    // The Host streams faster than the screen refreshes. One update per batch
    // keeps the render rate bounded instead of tracking the Host frame rate.
    // Chunks of one assistant step accumulate into a single streaming row.
    const before = useAppStore.getState().messages.s1?.length ?? 0
    useAppStore.getState().handleMuxFrames([chunkFrame(1, 'a'), chunkFrame(1, 'b'), chunkFrame(1, 'c')])
    const items = useAppStore.getState().messages.s1 ?? []
    expect(items.length).toBe(before + 1)
    expect(items.at(-1)).toMatchObject({ streaming: true, text: 'abc' })
  })

  it('ignores an empty batch', () => {
    const before = useAppStore.getState().messages
    useAppStore.getState().handleMuxFrames([])
    expect(useAppStore.getState().messages).toBe(before)
  })

  it('produces the same result whether frames arrive one by one or batched', () => {
    const frames = [chunkFrame(1, 'x'), chunkFrame(2, 'y'), chunkFrame(3, 'z')]
    useAppStore.getState().handleMuxFrames(frames)
    const batched = useAppStore.getState().messages.s1

    useAppStore.setState({ ...useAppStore.getInitialState(), selectedSession: session, sessions: [session] })
    for (const frame of frames) useAppStore.getState().handleMuxFrame(frame)
    const oneByOne = useAppStore.getState().messages.s1

    expect(oneByOne).toEqual(batched)
  })

  it('keeps turn lifecycle tracking correct across a batch', () => {
    const start = { rpcId: '', payload: { type: 'session/event', sessionId: 's1', event: { type: 'turn/start', seq: 1, time: 1, data: {} } } } as never
    const end = { rpcId: '', payload: { type: 'session/event', sessionId: 's1', event: { type: 'turn/end', seq: 2, time: 2, data: {} } } } as never
    useAppStore.getState().handleMuxFrames([chunkFrame(1, 'a'), start, end])
    expect(useAppStore.getState().selectedSession?.running).toBe(false)
  })

  it('releases a pending prompt from a batched frame', () => {
    useAppStore.setState({ busyAction: 'send-message' })
    useAppStore.getState().handleMuxFrames([chunkFrame(1, 'a')])
    expect(useAppStore.getState().busyAction).toBeUndefined()
  })
})
