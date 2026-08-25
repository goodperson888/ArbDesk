import type { MultiVenueExecutionSession } from '../../shared/multi-venue'

export function undismissedRecoverySessions(
  sessions: MultiVenueExecutionSession[],
  dismissedSessionIds: ReadonlySet<string>
): MultiVenueExecutionSession[] {
  return sessions.filter((session) => !dismissedSessionIds.has(session.sessionId))
}
