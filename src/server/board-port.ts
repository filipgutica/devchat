import type { Board, PostOptions } from '@vercel/board'

type Post = Pick<PostOptions, 'text' | 'labels'> & { id: string }
type MessagePageQuery = { after?: string; limit?: number }
type ThreadsQuery = NonNullable<Parameters<Board['threads']>[0]>
type ThreadsByLabelQuery = Pick<ThreadsQuery, 'channel' | 'before' | 'limit'>
  & Required<Pick<ThreadsQuery, 'label'>>

export function createBoardPort(handle: Board) {
  return {
    post: (channel: string, input: Post) => handle.post(channel, input),
    reply: (rootId: string, input: Post) => handle.reply(rootId, input),
    readChannel: (channel: string, query?: MessagePageQuery) => handle.channel(channel).messages(query),
    readThread: handle.thread,
    getPost: handle.posted,
    threadsByLabel: (query: ThreadsByLabelQuery) => handle.threads(query),
    setLabels: handle.label,
    listSchedules: handle.schedules,
    cancelSchedule: handle.cancelSchedule,
    createGrants: handle.createGrants,
    revokeGrant: handle.revokeGrant,
  }
}

export type BoardPort = ReturnType<typeof createBoardPort>
