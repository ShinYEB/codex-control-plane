const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// A handoff is intent, never evidence of a sidebar mutation. Only the calling
// conversation can invoke the app tool and observe the host's pinned list.
export function hostPinning(threadId, requested = false) {
  return {
    requested,
    status: !requested ? 'not_requested' : UUID.test(threadId ?? '') ? 'host_action_required' : 'waiting_for_thread',
    confirmed: false,
    ...(requested && UUID.test(threadId ?? '') ? {
      hostAction: { tool: 'move_thread_to_sidebar_section', arguments: { threadId, sectionId: 'pinned' } },
      verification: { tool: 'list_threads', expectedThreadId: threadId, collection: 'pinnedThreads' },
    } : {}),
  };
}
