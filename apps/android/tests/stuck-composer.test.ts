import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, RemoteSession } from '../src/types'

const { proxy } = vi.hoisted(() => ({ proxy: {
  sessionHistory: vi.fn(), messageFeedbackList: vi.fn(), sessionModels: vi.fn(),
  sessionExecuteCommand: vi.fn(), messageFeedbackPut: vi.fn(),
  sessionPrompt: vi.fn(), sessionCancel: vi.fn(),
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
import { isActiveChatItem } from '../src/state/event-reducer'
import { useAppStore } from '../src/state/store'

const harnessSession = (running: boolean): RemoteSession => ({ sessionId: 's1', backend: 'harness', running } as RemoteSession)

const userMessage = (): ChatItem => ({
  kind: 'message', id: 'u1', sessionId: 's1', role: 'user', text: 'hi', createdAt: 1,
})

/** A tool the Host finished, but whose `tool/result` frame never reached us. */
const staleRunningTool = (): ChatItem => ({
  kind: 'tool', id: 't1', sessionId: 's1', toolName: 'bash', state: 'running', createdAt: 1,
})

/** A permission request answered on the desktop Host, never announced to us. */
const unansweredApproval = (): ChatItem => ({
  kind: 'approval', id: 'approval:a1', sessionId: 's1', approvalId: 'a1', toolName: 'bash', createdAt: 1,
})

const finishedToolEvent = { event: {
  type: 'tool/result', seq: 9, time: 1, data: { callId: 't1', name: 'bash', message: { source: { callId: 't1' }, content: [{ type: 'text', text: 'done' }] } },
} }

const historyPage = (events: unknown[] = []) => ({ hasMore: false, events })

beforeEach(() => {
  vi.resetAllMocks()
  useAppStore.setState({ ...useAppStore.getInitialState() })
  proxy.messageFeedbackList.mockResolvedValue([])
  proxy.sessionModels.mockResolvedValue(undefined)
  proxy.sessionCancel.mockResolvedValue(undefined)
  proxy.sessionPrompt.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('opening a session releases a wedged composer', () => {
  it('settles a pending approval the desktop already answered', async () => {
    // The phone is showing an approval it can no longer answer, so the composer
    // renders stop-only and nothing the user taps can clear it.
    useAppStore.setState({
      selectedSession: harnessSession(false),
      sessions: [harnessSession(false)],
      messages: { s1: [userMessage(), unansweredApproval()] },
    })
    proxy.sessionHistory.mockResolvedValue(historyPage())

    expect(await useAppStore.getState().openSession(harnessSession(false))).toBe(true)

    const approval = useAppStore.getState().messages.s1!.find(item => item.kind === 'approval')
    expect(approval).toMatchObject({ outcome: 'unavailable' })
    expect(useAppStore.getState().messages.s1!.some(isActiveChatItem)).toBe(false)
  })

  it('settles a tool left running by a lost result frame', async () => {
    useAppStore.setState({
      selectedSession: harnessSession(false),
      sessions: [harnessSession(false)],
      messages: { s1: [userMessage(), staleRunningTool()] },
    })
    proxy.sessionHistory.mockResolvedValue(historyPage([finishedToolEvent]))

    await useAppStore.getState().openSession(harnessSession(false))

    expect(useAppStore.getState().messages.s1!.find(item => item.kind === 'tool')).toMatchObject({ state: 'finished' })
    expect(useAppStore.getState().messages.s1!.some(isActiveChatItem)).toBe(false)
  })

  it('re-resolves the session so a turn that ended while away stops reporting running', async () => {
    // The Android foreground path re-opens the session object it captured before
    // the reconnect refreshed the session list, so `running` stayed true.
    useAppStore.setState({
      selectedSession: harnessSession(true),
      sessions: [harnessSession(false)],
      messages: { s1: [userMessage()] },
    })
    proxy.sessionHistory.mockResolvedValue(historyPage())

    await useAppStore.getState().openSession(harnessSession(true))

    expect(useAppStore.getState().selectedSession?.running).toBe(false)
  })

  it('leaves a genuinely running turn alone', async () => {
    useAppStore.setState({
      selectedSession: harnessSession(true),
      sessions: [harnessSession(true)],
      messages: { s1: [userMessage(), staleRunningTool()] },
    })
    proxy.sessionHistory.mockResolvedValue(historyPage())

    await useAppStore.getState().openSession(harnessSession(true))

    expect(useAppStore.getState().messages.s1!.some(isActiveChatItem)).toBe(true)
  })
})

describe('stopping a session', () => {
  it('releases the composer even when the Host has nothing left to cancel', async () => {
    // `sessionCancel` fails precisely when the turn already ended, which is the
    // common shape of the wedge. Stop still has to free the user.
    proxy.sessionCancel.mockRejectedValueOnce(new Error('not running'))
    useAppStore.setState({
      selectedSession: harnessSession(true),
      sessions: [harnessSession(true)],
      messages: { s1: [userMessage(), staleRunningTool(), unansweredApproval()] },
    })

    await useAppStore.getState().stopSession()

    expect(useAppStore.getState().busyAction).toBeUndefined()
    expect(useAppStore.getState().selectedSession?.running).toBe(false)
    expect(useAppStore.getState().messages.s1!.some(isActiveChatItem)).toBe(false)
  })

  it('reports the failure but still releases the composer', async () => {
    proxy.sessionCancel.mockRejectedValueOnce(new Error('boom'))
    useAppStore.setState({ selectedSession: harnessSession(true), sessions: [harnessSession(true)] })

    await useAppStore.getState().stopSession()

    expect(useAppStore.getState().error).toBeTruthy()
    expect(useAppStore.getState().busyAction).toBeUndefined()
  })
})

describe('sending state watchdog', () => {
  it('releases the sending state when no Host frame ever arrives', async () => {
    vi.useFakeTimers()
    useAppStore.setState({ selectedSession: harnessSession(false), sessions: [harnessSession(false)] })

    expect(await useAppStore.getState().sendMessage('hello')).toBe(true)
    // `session.prompt` only acknowledges enqueueing; the store keeps the
    // sending state until a frame proves the turn began.
    expect(useAppStore.getState().busyAction).toBe('send-message')

    await vi.advanceTimersByTimeAsync(20_000)

    expect(useAppStore.getState().busyAction).toBeUndefined()
  })

  it('keeps the sending state while the acknowledgement window is still open', async () => {
    vi.useFakeTimers()
    useAppStore.setState({ selectedSession: harnessSession(false), sessions: [harnessSession(false)] })

    await useAppStore.getState().sendMessage('hello')
    await vi.advanceTimersByTimeAsync(5_000)

    expect(useAppStore.getState().busyAction).toBe('send-message')
  })

  it('releases early once a frame proves the turn began', async () => {
    vi.useFakeTimers()
    useAppStore.setState({ selectedSession: harnessSession(false), sessions: [harnessSession(false)] })

    await useAppStore.getState().sendMessage('hello')
    useAppStore.getState().handleMuxFrame({
      rpcId: '',
      payload: {
        type: 'session/event', sessionId: 's1',
        event: { type: 'turn/start', seq: 1, time: 1, data: {} },
      },
    } as never)

    expect(useAppStore.getState().busyAction).toBeUndefined()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(useAppStore.getState().busyAction).toBeUndefined()
  })

  it('does not arm a watchdog for a failed prompt', async () => {
    vi.useFakeTimers()
    proxy.sessionPrompt.mockRejectedValueOnce(new Error('nope'))
    useAppStore.setState({ selectedSession: harnessSession(false), sessions: [harnessSession(false)] })

    expect(await useAppStore.getState().sendMessage('hello')).toBe(false)
    expect(useAppStore.getState().busyAction).toBeUndefined()
  })
})
