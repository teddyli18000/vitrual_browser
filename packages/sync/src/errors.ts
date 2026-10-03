/**
 * Errors the window synchroniser raises.
 *
 * `code` exists so the HTTP layer can map a failure onto an `ApiError` without parsing English
 * out of `message`; the message itself is written to be shown to a user as-is.
 */

export type SyncErrorCode =
  | 'invalid_input'
  | 'unknown_profile'
  | 'not_running'
  | 'already_active'
  | 'closed'
  | 'attach_failed'
  | 'tiling_unavailable'

export class SyncError extends Error {
  readonly code: SyncErrorCode

  constructor(message: string, code: SyncErrorCode = 'invalid_input') {
    super(message)
    this.name = 'SyncError'
    this.code = code
  }
}
