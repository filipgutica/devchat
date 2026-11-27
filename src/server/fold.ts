type Labels = Record<string, string>

/** The root labels the fold owns: every other root label is set once, when the root is written. */
export const isStateLabel = (key: string) => key === 'status' || key === 'ask' || key === 'turn' || key.startsWith('pr.')

/**
 * A root's state labels from its replies' labels, in board log order: the §2 fold table without
 * the reaction and queue rows (release 2). A new root reads as `status=open`.
 *
 * Pending guard: while `ask=answered`, an agent's note, question, or resolve changes the root only
 * when its `re` equals `turn`. Ingest refuses such a resolve, so it never reaches the log; the fold
 * still skips one, so the log alone gives the state.
 */
export function foldState(replies: readonly Labels[]): Labels {
  const state: Labels = { status: 'open' }
  const clearAsk = () => {
    delete state.ask
    delete state.turn
  }
  for (const post of replies) {
    const fromUser = post.by === 'user'
    const answersTurn = post.re !== undefined && post.re === state.turn
    if (!fromUser && state.ask === 'answered' && !answersTurn) continue
    switch (post.kind) {
      case 'answer':
        if (!fromUser || post.rid === undefined) break
        // A reply on a resolved thread reopens it before its own change applies.
        if (state.status === 'done' || state.status === 'dropped') state.status = 'open'
        state.ask = 'answered'
        state.turn = post.rid
        break
      case 'note':
        clearAsk()
        state.status = 'open'
        for (const [key, value] of Object.entries(post)) if (key.startsWith('pr.')) state[key] = value
        break
      case 'ask':
        if (post.rid === undefined) break
        state.ask = 'open'
        state.turn = post.rid
        state.status = post.block === '1' ? 'blocked' : 'open'
        break
      case 'done':
      case 'drop':
        clearAsk()
        state.status = post.kind === 'done' ? 'done' : 'dropped'
        break
    }
  }
  return state
}

/** The label change that makes a root's state labels `state`, or null when they already are. */
export function stateChange(current: Labels, state: Labels) {
  const set = Object.fromEntries(Object.entries(state).filter(([key, value]) => current[key] !== value))
  const unset = Object.keys(current).filter((key) => isStateLabel(key) && !(key in state))
  return Object.keys(set).length === 0 && unset.length === 0 ? null : { set, unset }
}
