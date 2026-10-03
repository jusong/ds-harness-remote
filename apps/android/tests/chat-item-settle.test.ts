import { describe, expect, it } from 'vitest'
import type { ApprovalActivity, ChatItem, ChatMessage, ToolActivity } from '../src/types'
import { isActiveChatItem, settleChatItem, settleChatItems } from '../src/state/event-reducer'
import { mergeHistoryAndLive } from '../src/state/message-helpers'

const runningTool = (): ToolActivity => ({
  kind: 'tool', id: 't1', sessionId: 's1', toolName: 'bash', state: 'running', createdAt: 1,
})

const finishedTool = (): ToolActivity => ({
  kind: 'tool', id: 't1', sessionId: 's1', toolName: 'bash', state: 'finished',
  resultDetail: { text: 'ok', format: 'markdown' }, createdAt: 1,
})

const streamingMessage = (): ChatMessage => ({
  kind: 'message', id: 'stream:1:1', sessionId: 's1', role: 'assistant', text: 'partial',
  streaming: true, streamingPhase: 'text', createdAt: 1,
})

/** The same message once its turn finished: no streaming flags left. */
const settledMessage = (): ChatMessage => ({
  kind: 'message', id: 'm1', sessionId: 's1', role: 'assistant', text: 'answer', createdAt: 1,
})

const pendingApproval = (): ApprovalActivity => ({
  kind: 'approval', id: 'approval:a1', sessionId: 's1', approvalId: 'a1', toolName: 'bash', createdAt: 1,
})

describe('isActiveChatItem', () => {
  it('treats unfinished work as busy and settled work as idle', () => {
    expect(isActiveChatItem(runningTool())).toBe(true)
    expect(isActiveChatItem(streamingMessage())).toBe(true)
    expect(isActiveChatItem(pendingApproval())).toBe(true)
    expect(isActiveChatItem(finishedTool())).toBe(false)
    expect(isActiveChatItem(settledMessage())).toBe(false)
    expect(isActiveChatItem({ ...pendingApproval(), outcome: 'rejected' })).toBe(false)
  })
})

describe('settleChatItem', () => {
  it('drops the streaming flags so the message reads as a finished answer', () => {
    const settled = settleChatItem(streamingMessage())
    expect(settled).not.toHaveProperty('streaming')
    expect(settled).not.toHaveProperty('streamingPhase')
    expect(settled).toMatchObject({ kind: 'message', text: 'partial' })
    expect(isActiveChatItem(settled)).toBe(false)
  })

  it('finishes a tool whose result frame never arrived', () => {
    expect(settleChatItem(runningTool())).toMatchObject({ kind: 'tool', state: 'finished' })
  })

  it('closes decisions the Host can no longer answer', () => {
    expect(settleChatItem(pendingApproval())).toMatchObject({ kind: 'approval', outcome: 'unavailable' })
    expect(settleChatItem({
      kind: 'question', id: 'question:r1', sessionId: 's1', questions: [], createdAt: 1,
    })).toMatchObject({ kind: 'question', outcome: 'cancelled' })
  })

  it('leaves already settled items untouched', () => {
    const settled = finishedTool()
    expect(settleChatItem(settled)).toBe(settled)
  })

  it('settles every unfinished item in a list', () => {
    const items = settleChatItems([runningTool(), streamingMessage(), pendingApproval(), finishedTool()])
    expect(items.every(item => !isActiveChatItem(item))).toBe(true)
  })
})

describe('mergeHistoryAndLive settle state', () => {
  it('lets settled history retire a stale live tool that stayed running', () => {
    // The Host finished the tool and the `tool/result` frame was lost, so the
    // live copy still says "running". Re-opening folds history that already
    // has the result; a plain live-wins merge resurrects the stale state and
    // locks the composer.
    const merged = mergeHistoryAndLive([finishedTool()], [runningTool()])
    expect(merged).toHaveLength(1)
    expect(merged[0]).toMatchObject({ kind: 'tool', state: 'finished' })
    expect(isActiveChatItem(merged[0]!)).toBe(false)
  })

  it('adopts the authoritative tool outcome and result', () => {
    const failed = { ...finishedTool(), state: 'failed' as const, resultDetail: { text: 'boom', format: 'markdown' as const } }
    expect(mergeHistoryAndLive([failed], [runningTool()])[0]).toMatchObject({ state: 'failed', resultDetail: { text: 'boom' } })
  })

  it('keeps the live copy when it is already settled, so live content still wins', () => {
    const live: ToolActivity = { ...finishedTool(), summary: 'from live' }
    expect(mergeHistoryAndLive([finishedTool()], [live])[0]).toBe(live)
  })

  it('keeps both active when history has not settled the item yet', () => {
    const live = runningTool()
    expect(mergeHistoryAndLive([runningTool()], [live])[0]).toBe(live)
  })

  it('keeps live-only items that history does not mention', () => {
    const approval = pendingApproval()
    expect(mergeHistoryAndLive([], [approval])[0]).toBe(approval)
  })
})
