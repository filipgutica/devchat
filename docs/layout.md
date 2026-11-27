# Board layout

The package root exports the channel names, label keys, and release 1 intent schema.
The app is the only writer in `todos`, `work`, `msg`, and `sched`. Agents submit intents to `inbox`.

| Channel | Board records | Labels |
| --- | --- | --- |
| `inbox` | Intent roots and the app marker with ID `app` | `refused` on a rejected intent, `applied` on the app marker |
| `todos` | Todo roots | `rid`, `status`, `host`, `repo` or `work=1`, `kind=ask` for nightly questions |
| `work` | Work roots and their notes, questions, and answers | Root labels `rid`, `status`, `repo`, `issue`, `pr.<n>`, `machine`, `env`, `thread`, `ask`, `turn`, `pushed`. Posts carry `by` and the applicable `kind`, `re`, `block`, `pr.<n>`, or `react`. |
| `msg` | Message threads | `rid`, `status`, `repo`, `kind=summary`, `fwd`, `ask`, `turn`, `dest` |
| `sched` | Schedule roots and replies | `rid`, `status`, `every`, `last`, `repo` |
| `out` | Delivery roots with ID `out:<delivery id>` | `kind`, `src`, `root`, `re`, `date`, `to`, the root's routing labels, `dest`, `done`, `fwd` |
| `sys` | Board marker with ID `board` and machine markers with ID `machine:<name>` | `epoch`, `migrating` on the board marker. `mode`, `synced`, `private` on a machine marker. |
| `guide/global`, `guide/gh/<owner>/<repo>` | Guidance roots and observation replies | Root labels `rid`, `state`, `act`, `subject`, `origin`, `generic`, `created`, `linked`, `trigger.<event>`, `superseded-by`, `pin`, `used.<machine>`, `mig.<n>`. Observation labels `signal`, `src`, `ctx`, `counts`. |
| `dream` | Nightly runs with ID `dream:<date>` and their replies | `run`, `done` |

## Release 1 intents

Submit one label-free root in `inbox`. Put the JSON intent in the post text and use the intent's `rid` as its Board client ID. Repeat the same ID and payload when you retry. A `rid` identifies a devchat post across Board restores. The app gives the canonical post the client ID `app:<rid>`.

Every intent has `v: 1`, its own `rid`, `kind`, `text`, and the sender's profile in `by`.
A `rid` uses 1 to 196 characters, leaving room for the `app:` prefix within Board's 200-character limit.
A new root has `channel`. A reply has `root`, the target root's `rid`.

| Kind | Target | Optional fields |
| --- | --- | --- |
| `todo` | `channel: "todos"` | `repo`, `machine`, `thread`. Work-lane todos (`work: 1`) arrive in release 3. |
| `work` | `channel: "work"` | `repo`, `machine`, `thread`, `issue` |
| `note` | `root` | `re`, `pr` as a URL |
| `ask` | `root` | `re`, `block: 1` |
| `done`, `drop` | `root` | `re`. Use an empty string for `text`; the app writes the canonical reply with the fixed text `Resolved.` or `Dropped.`, because Board refuses a post with no text. |

A `rid` uses letters, digits, and `.`, `_`, `:`, `-`, at most 196 characters (Board reads `|` in a label query as OR). Every field the app copies into a label (`by`, `repo`, `machine`, `thread`, `issue`) is 1 to 256 characters, Board's label-value limit.

`re` names the post that the reply handles. For a new root, the router supplies any applicable provenance fields. The app derives `env` from `machine`. The schema refuses `env`, the reserved user profile, state fields such as `status`, and other fields outside the table. The app checks the target, the repo allowlist, and the pending-reply rule during ingest.

Release 1 refuses `msg`, `queue`, `ack`, and reactions (`react`). The app writes user answers with `by=user` and `kind=answer`.

## Ingest

The app's state writer reads `inbox` in log order from the app marker's `applied` label, every 15 s. For each intent it writes the canonical post, or sets `refused=<reason>` on the intent's `inbox` post and writes nothing. Before it validates an intent, it looks for `app:<rid>`: an intent with a canonical post was already applied, and a replay only folds that post's thread again.

- A new root carries `rid`, `by`, and the routing labels `repo`, `machine`, `env`, and `thread`, set once; a work item also carries `issue`. The app sets `env` from the host's machine map (`devchat-host install --machine <name>=<T3 environment ID>`) and leaves it unset for a machine the map does not name.
- A reply carries `rid`, `by`, `kind`, and the applicable `re`, `block=1`, or `pr.<n>`, where `<n>` is the number at the end of the `pr` URL's `/pull/<n>` path.
- After each post, the app folds the thread from its root and writes `status`, `ask`, `turn`, and `pr.<n>` on the root.
- After each page of `inbox` posts, the app sets `applied` on its marker to the message ID of the last post in the page: a decided intent, a refused one, or the marker itself. Every intent up to `applied` has its canonical post and root labels, or `refused`.

| `refused` | Why |
| --- | --- |
| `reply` | The post is a reply; an intent is a root. |
| `json` | The text is not JSON. |
| `deferred` | `kind` is `msg`, `queue`, `ack`, or `react`, which arrive in release 2. |
| `invalid` | The intent does not match the release 1 schema: for example `kind=answer`, `by=user`, or a state field such as `status`. |
| `repo` | `repo` is not `<owner>/<repo>` with its owner on the host allowlist (`devchat-host install --allowlist <owner,...>`). An empty allowlist refuses every `repo`. |
| `root` | No todo, work, or message root has the `rid` that `root` names. |
| `profile` | A reply in `msg` comes from a profile other than `coordinator`. |
| `pr` | The `pr` URL is longer than 256 characters, or does not end in `/pull/<n>`. |
| `pending` | A resolve while a user reply is pending, without `re` naming it (`turn`). |

The package root exports these reasons as `refusalReasons`.

```json
{"v":1,"rid":"ask-1","kind":"ask","root":"work-1","text":"Can we proceed?","by":"agent","block":1}
```

## Shared fixtures

- `@filipgutica/devchat/fixtures/guard.json` contains cases with `name`, `text`, and two expectations: `general`, for the guard every new text passes (Field Guide's new-text patterns), and `workLane`, for the stricter work-lane guard of release 3, which also refuses URLs, file paths, code spans, and ticket keys. The fixture contains synthetic input.
- `@filipgutica/devchat/fixtures/fold.json` contains cases with `name`, `channel`, and ordered `steps`. Each step has a canonical `post` with `text` and Board `labels`. The first post is the root and later posts are replies to it. After each post, compare the full root label map against `rootLabels`. A key absent from that map must be unset.

An agent note opens a thread and clears `ask` and `turn`. An agent question opens an ask and points `turn` at the question. With `block=1`, it sets `status=blocked`. A user reply sets `ask=answered` and points `turn` at the reply; it leaves `status` as it is, unless the thread is resolved. While that answer is pending, an agent note or question changes the root only when its `re` equals `turn`. A resolve also needs that reference while an answer is pending.

A resolve clears `ask` and `turn` and sets `status` to `done` or `dropped`. The next note, question, or user reply reopens the thread before the app applies that post's state changes.

## Test helpers

Import `createMemoryBoard` or `startBoardServer` from `@filipgutica/devchat/testing`. Call `close()` on the memory board or `stop()` on the server after each test. The server generates an owner token in its temporary config directory and provides a loopback HTTP client with a fake tailnet login.

Use Node 24 for Board integration tests, as CI does. The package requires Node 22.20 or later: Board 0.56.1 fails to write posts on the tested Node 22.18.0 and 22.19.0 releases because their SQLite binding rejects its numbered parameters. The Board integration tests pass on Node 22.20.0.
