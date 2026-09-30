import { createNativeRpcId } from './api-proxy'
import { AndroidRemoteConnection } from './connection'
import { serverSession } from './server-session'
import type { DeviceIdentity, PromptImage, RemoteDevice, TransportPreference } from '../types'
import { resolveAutomaticPreferredTransports } from './network-route'

/**
 * Deliver a one-shot task to another Host without replacing the active chat
 * connection. The task is intentionally created as a fresh Harness session;
 * the remote Host remains the authority for its workspace and permissions.
 */
export async function sendTaskToRemoteHost(options: {
  baseUrl: string
  identity: DeviceIdentity
  device: RemoteDevice
  transportPreference: TransportPreference
  text: string
  images?: PromptImage[]
}): Promise<void> {
  const { api, credentials } = await serverSession.authenticate(options.baseUrl, options.identity)
  const forceRelay = options.transportPreference === 'relay'
  const preferredTransports = forceRelay
    ? ['relay'] as const
    : options.transportPreference === 'turn'
      ? ['turn', 'relay'] as const
      : await resolveAutomaticPreferredTransports()
  const connection = new AndroidRemoteConnection()
  try {
    await connection.connect(
      options.baseUrl,
      options.identity,
      options.device,
      credentials.accessToken,
      () => undefined,
      {
        preferredTransports: [...preferredTransports],
        forceRelay,
        fetchIceServers: connectionId => api.turnCredentials(connectionId),
      },
    )
    const proxy = connection.requireProxy()
    const { sessionId } = await proxy.sessionCreate()
    await proxy.sessionPrompt(sessionId, options.text, createNativeRpcId(), options.images ?? [])
  } finally {
    await connection.close()
  }
}
