# Session record segments: evaluation set

Forty segments of real sessions, written down so that a change to how a
session record shows its segments (`segmentsOf` and `formatSessionRecord`,
`src/mcp/left_off.ts`) can be judged on the same segments again, and twenty
more from other sessions (the second set, at the end), to judge a change on
segments it was not made from. See the backlog item "Session record segments
too large for two lines".

## How they were picked (2026-10-06)

From the index as of 2026-10-06 01:05 UTC: interactive sessions whose record
shows segments (two or more) and whose last message is before 2026-10-06, so
their segments no longer change. Each segment is keyed by
sha1(session id + segment start), and the segments are taken in key order,
at most one per session in each group:

| Group | Rule | Taken |
|---|---|---|
| big-edits | 40 or more requests, edited a file | 12 |
| big-noedits | 40 or more requests, edited nothing | 4 (of 11) |
| mid-edits | 10 to 39 requests, edited a file | 10 |
| mid-noedits | 10 to 39 requests, edited nothing | 10 |
| small | 2 to 9 requests | 4 |

## How they were judged

Each segment's record lines were read against its requests (up to 30, spread
evenly over the segment):

- **What** (Y, P, N): can a reader of the record lines alone tell what the
  segment mainly worked on? Y when they name what most of its requests were
  about, P when only part of it (often only its first or last topic), N
  when not.
- **Where** (Y, N): can a reader tell where the work stood at the segment's
  end: a result, a state or the next step, not only an answer to the last
  question.

Three versions of the lines were judged: "before" is the first request
and the last reply; "work" adds the `Work:` line (files edited, commits,
skills and slash commands run; tried, then taken out); "topics" also adds
a `Topics:` line: the backticked terms that two or more of the segment's
replies mention, most mentioned first, up to six, leaving out commit
hashes, numbers and the file names the `Work:` line shows. The code shows
the `Topics:` line alone, as in the second agent's "topics only" below.

Two judges. The author of the `Work:` line judged "before" and "work",
knowing which was which. Then a separate agent judged all three versions
blind: 120 items in a shuffled order, each with the segment's requests and
one version of its lines, and no word of which version it was. A second
agent, new to the task, judged "before" and "topics only" the same way
(80 items), with the `Topics:` line built without the `Work:` line's file
rule; the line changed in 5 of the 40 segments.

A third agent, new to the task, judged the lines the code showed from then
on ("shipped": first request, `Topics:` and last reply) against the same
with a `Last change (request n of m):` line ("last change"), 80 items. Its
instructions defined the line as the tool's description does: the reply
that closed the segment's latest request that edited a file or ran a
commit, merge or push, when a later request followed. That rule was made
by reading the segments of this set the earlier judges found unclear about
where the work stood, so a fourth agent judged it again on the second set.

## Results

| Judge | Version | What Y | What P | What N | Where Y | What Y and where Y |
|---|---|---|---|---|---|---|
| Author, not blind | before | 19 | 19 | 2 | 27 | 17 |
| Author, not blind | work | 26 | 13 | 1 | 27 | 21 |
| Agent, blind | before | 25 | 14 | 1 | 23 | 17 |
| Agent, blind | work | 25 | 14 | 1 | 23 | 17 |
| Agent, blind | topics | 33 | 7 | 0 | 23 | 19 |
| Second agent, blind | before | 28 | 11 | 1 | 27 | 22 |
| Second agent, blind | topics only | 35 | 5 | 0 | 27 | 24 |
| Third agent, blind | shipped | 30 | 10 | 0 | 26 | 20 |
| Third agent, blind | last change | 34 | 6 | 0 | 32 | 27 |

The blind judge saw no gain from the `Work:` line, where the author saw 19
to 26: take the author's count as biased. The `Topics:` line raised what Y
from 25 to 33 under the blind judge (segments 7, 19, 20, 23, 25, 28, 31
and 34 went from P to Y, segment 16 from N to P), most in segments without
edits (mid-noedits 5 to 8 of 10). Neither line changed where: 17 of the 40
end where a reader cannot tell how the work stood.

The second agent agreed with the first on "before" in 37 of 40 segments for
what and 36 for where, and saw the same gain from the `Topics:` line alone:
what Y from 28 to 35 (segments 7, 10, 19, 20, 25, 28 and 34 from P to Y, 16
from N to P), where unchanged. With or without the `Work:` line, the
`Topics:` line is judged Y in the same segments but two (10 and 35).

The `Last change` line shows on 17 of the 40. It raised where Y from 26 to
32 (segments 7, 18, 19, 23, 26 and 34 from N to Y; in most of them the
segment ended on a side question after the reply that told what was done)
and what Y from 30 to 34 (7, 10, 19 and 27 from P to Y); no segment went
down. The third agent labeled the 23 segments whose lines are the same in
both versions the same both times.

## Segments

| # | Session | Segment start (UTC) | Requests | Group | Author: what before, work, where | Blind: what before, work, topics, where | Second blind: what before, topics only, where | Third blind: what shipped, last change; where shipped, last change | About |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 54b13785-0de8-418c-a8d6-72cd79b2a5be | 2026-06-17T04:45:27.981Z | 206 | big-edits | P P Y | Y Y Y Y | Y Y Y | Y Y Y Y | docs search tool: dependencies, file types, agent docs, site indexing |
| 2 | 970a8651-554a-4c83-9a6f-e94f7e3d58ca | 2026-08-24T06:39:27.054Z | 102 | big-edits | P Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | tag extraction prompt and its output format |
| 3 | 019e04e5-baf5-71c2-aac2-c804feb102ea | 2026-05-08T01:09:42.010Z | 91 | big-edits | Y Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | plugin workflow state, verify runner, hooks |
| 4 | 2373781f-42a7-4423-ad3e-081a54bb0d58 | 2026-07-15T06:30:56.233Z | 76 | big-edits | P Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | completion notifications, then a desktop mascot |
| 5 | 93f4d58f-8939-46cd-94d2-94bd080c386f | 2026-07-08T03:19:39.051Z | 90 | big-edits | Y Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | image force sync: design, edge cases, tests |
| 6 | 01a0ac91-b55e-7033-926f-41bfee79dc17 | 2026-09-16T23:33:58.417Z | 49 | big-edits | P Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | game-playing learning model: plan, build, improve |
| 7 | 019e3484-28e7-75a1-abef-e8f190ca0b86 | 2026-05-17T10:50:48.703Z | 81 | big-edits | N N N | P P Y N | P Y N | P Y N Y | writing skills and how they are routed; a memory deleted by mistake |
| 8 | 88248acc-d8c6-466c-8411-1dc32452979a | 2026-09-30T14:36:14.346Z | 55 | big-edits | P Y Y | P P P Y | P P Y | P P Y Y | writing-style rules: research, revise, test, publish |
| 9 | e8932d3e-b9f9-418a-9445-ac63668e847e | 2026-10-01T00:20:59.975Z | 44 | big-edits | Y Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | README check, merge, then a blind comparison of replies |
| 10 | c70ec046-3619-4180-84e4-832f85e57c5a | 2026-07-20T23:55:10.415Z | 136 | big-edits | P P Y | P P P Y | P Y Y | P Y Y Y | skill set review and how to distribute it |
| 11 | 3aa930fa-e925-4be6-87f7-49034e6d0e6f | 2026-07-03T16:58:53.555Z | 50 | big-edits | Y Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | dashboard: what it shows and why it is slow |
| 12 | 9daedf1c-e759-43d1-81b9-9f7185c59d31 | 2026-09-02T23:28:28.311Z | 141 | big-edits | P P Y | P P P Y | P P Y | P P Y Y | prompt caching questions, then merge and push |
| 13 | 019e0004-e043-7ab3-9176-32c35235355b | 2026-05-07T01:19:44.223Z | 57 | big-noedits | Y Y Y | Y Y Y N | Y Y Y | Y Y Y Y | a skill that runs two reviewers |
| 14 | 4386c3cb-8cac-448d-a794-62d371eb6313 | 2026-08-07T06:25:33.621Z | 72 | big-noedits | Y Y Y | Y Y Y N | Y Y Y | Y Y N N | why a project did not work out |
| 15 | 760556a4-ec1c-4c0c-b767-881f077609d9 | 2026-08-26T04:20:13.278Z | 55 | big-noedits | P Y N | Y Y Y N | Y Y N | Y Y N N | web search accuracy: research with an agent team |
| 16 | 970a8651-554a-4c83-9a6f-e94f7e3d58ca | 2026-08-31T00:41:26.794Z | 40 | big-noedits | N P N | N N P N | N P N | P P N N | planning storage wiring around several enums |
| 17 | e8932d3e-b9f9-418a-9445-ac63668e847e | 2026-09-28T01:22:44.874Z | 37 | mid-edits | Y Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | plans for tool improvements, first batch built |
| 18 | 6e30990d-a5d4-4753-a939-337822d605fe | 2026-09-23T02:15:51.327Z | 23 | mid-edits | P P N | P P P N | P P N | P P N Y | impressions of a plugin, turning parts off, a UI tool test |
| 19 | 92a877f5-2ed4-4429-8cb7-1dcfe798809e | 2026-07-17T05:30:34.543Z | 16 | mid-edits | P Y N | P P Y N | P Y N | P Y N Y | judging a repository, bringing its agents in |
| 20 | 019dbf6c-5e14-7160-ab07-02f1223b274c | 2026-04-26T06:21:33.544Z | 35 | mid-edits | P P Y | P P Y Y | P Y Y | Y Y Y Y | retrieval chunk size, one commit, a rename |
| 21 | fe59f031-1de5-400e-abe7-8c72da3d3dae | 2026-09-29T03:48:07.219Z | 35 | mid-edits | Y Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | a skill that checks whether a plan can be built |
| 22 | d99f19a7-2851-4d13-98f7-3af9ab67206c | 2026-07-05T06:02:00.784Z | 36 | mid-edits | Y Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | index size, language model install command |
| 23 | b3302b99-a396-4868-9f19-bd53b709746b | 2026-07-08T09:10:14.035Z | 11 | mid-edits | P P N | P P Y N | Y Y N | Y Y N Y | what text to store, leaving out automated runs |
| 24 | 7c6f01ea-5564-4ca3-b09a-7a4fa74b020f | 2026-08-04T04:08:40.106Z | 14 | mid-edits | Y Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | a size cap, committed and checked on a sandbox |
| 25 | 6f8ba310-8d57-4993-9aeb-f34d71dfc536 | 2026-06-23T01:02:15.800Z | 13 | mid-edits | P P N | P P Y N | P Y N | Y Y N N | a test-loop skill that missed a compile error |
| 26 | 019e0cec-1ecc-7521-8290-b90b23630ed5 | 2026-05-12T11:53:23.086Z | 17 | mid-edits | P Y N | Y Y Y N | Y Y N | Y Y N Y | reviewing and fixing a skill generator |
| 27 | 0aefcd57-4da5-4b84-9045-811ed73a59a0 | 2026-08-05T00:16:01.662Z | 10 | mid-noedits | Y Y Y | P P P Y | P P Y | P Y Y Y | wrapping up a feature, a bug fix, token use |
| 28 | 019d93e5-c2d2-7de3-a749-a918efcad620 | 2026-04-16T01:27:36.432Z | 11 | mid-noedits | P P N | P P Y N | P Y N | Y Y N N | PR review by points, a cache key, an agent role |
| 29 | 01a02346-b145-77c2-876d-c02dff752886 | 2026-08-25T05:27:29.457Z | 20 | mid-noedits | Y Y Y | Y Y Y N | Y Y Y | Y Y Y Y | why web search results are poor |
| 30 | 01a01813-ef35-7c12-b5ac-84b7896e517f | 2026-08-19T03:54:44.573Z | 27 | mid-noedits | Y Y N | Y Y Y N | Y Y N | Y Y N N | prompt caching, forcing a tool |
| 31 | 019d896a-1c4f-7400-a4c5-436099d4a172 | 2026-04-14T06:23:03.000Z | 11 | mid-noedits | P P Y | P P Y Y | Y Y Y | Y Y Y Y | search cache code questions, a check blocked by settings |
| 32 | 019e87d9-c5da-7fd2-b5df-eee8b2253ab4 | 2026-06-02T10:48:13.301Z | 13 | mid-noedits | Y Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | reviewing two skills over several fixes |
| 33 | 019e91ec-a8f8-7721-9201-f6d208834a00 | 2026-06-04T10:15:21.299Z | 13 | mid-noedits | Y Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | which skills to add, reviewing two |
| 34 | cf2321da-b354-4b45-9804-f0cbee38bedd | 2026-09-11T05:26:33.793Z | 10 | mid-noedits | P P Y | P P Y N | P Y N | Y Y N Y | branch state, a new field, a consumer error |
| 35 | b97b4f7c-e490-4a1f-9ddc-8a40dd93e906 | 2026-09-21T05:51:44.983Z | 36 | mid-noedits | P P N | P P P N | Y Y Y | P P Y Y | a branch review, then song lyrics |
| 36 | 019ebfd8-49b9-7970-bac9-b010eb09541c | 2026-06-13T10:18:42.728Z | 30 | mid-noedits | P P N | Y Y Y N | Y Y N | Y Y N N | a code graph design for reading less |
| 37 | 88248acc-d8c6-466c-8411-1dc32452979a | 2026-10-02T02:51:38.451Z | 9 | small | Y Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | blind comparison of three style guides |
| 38 | 019eb629-bae9-7773-909d-b7265247ab71 | 2026-06-11T14:18:46.392Z | 2 | small | Y Y N | Y Y Y N | Y Y N | Y Y N N | a hook question |
| 39 | 019e3dd2-a787-7550-b35f-68c9a3630fff | 2026-05-20T13:01:47.578Z | 2 | small | Y Y Y | Y Y Y Y | Y Y Y | P P Y Y | a heap dump taken, to continue later |
| 40 | 019df6d0-8d2b-7c23-a0b7-35b0f560af43 | 2026-05-05T10:42:47.432Z | 6 | small | Y Y Y | Y Y Y Y | Y Y Y | Y Y Y Y | a template bug, how to start the next phase |

## Second set (2026-10-06)

Twenty segments by the same rule from the same index, half of each group's
count (big-edits 6, big-noedits 2, mid-edits 5, mid-noedits 5, small 2),
leaving out the sessions of the first set. A segment's edited files are
counted as the `Work:` line counted them, outside temporary folders; with
that count, the first set's segments all fall in the groups they were picked
in. A fourth agent, new to the task, judged "shipped" and "last change"
blind, 40 items, with the third agent's instructions.

| Version | What Y | What P | What N | Where Y | What Y and where Y |
|---|---|---|---|---|---|
| shipped | 16 | 4 | 0 | 11 | 9 |
| last change | 17 | 3 | 0 | 14 | 12 |

The `Last change` line shows on 6 of the 20. Where went from N to Y in 3 of
them (3, 9 and 11) and down in none. The agent called 11 a close call: its
last change is the reply to request 1 of 21, and the 20 requests after it
raised a question the lines do not show. The 14 segments whose lines are
the same in both versions got the same labels both times.

| # | Session | Segment start (UTC) | Requests | Group | Fourth blind: what shipped, last change; where shipped, last change | About |
|---|---|---|---|---|---|---|
| 1 | 5f9ff5e7-a8f7-4062-976a-45c17c99d452 | 2026-07-05T11:01:05.849Z | 99 | big-edits | P P N N | a merged change to stats output, then how a recall request should work |
| 2 | 019e213e-fd0d-7bf3-a58d-cdf9cbf33228 | 2026-05-13T12:14:39.246Z | 53 | big-edits | Y Y Y Y | a dual review of a skill generator, and fixes for both hosts |
| 3 | b91af4bf-2986-42fb-9f6a-d16d49326fb0 | 2026-06-15T08:47:42.330Z | 74 | big-edits | Y Y N Y | how much a context tool saved, and why using it failed |
| 4 | f8215a19-256e-4bf2-95c2-fab90285ec74 | 2026-06-29T13:38:45.725Z | 157 | big-edits | P P Y Y | why assistant text was not stored, and storing it |
| 5 | 019dcc25-1304-7021-95fc-bb9710be750c | 2026-04-28T05:05:21.022Z | 43 | big-edits | Y Y Y Y | a consumer's buffer timeout error and backpressure |
| 6 | 12ef5286-4933-4091-a261-5a70dfb1dfb1 | 2026-09-22T04:31:57.348Z | 126 | big-edits | Y Y Y Y | adding two filters to a search |
| 7 | 019e156d-1355-74f0-ad71-8c850a5a59e0 | 2026-05-11T05:05:33.989Z | 79 | big-noedits | Y Y Y Y | an ingress upgrade, checked against the cluster |
| 8 | 8b19b59c-0131-45bd-8685-ecf4fbaf6b28 | 2026-08-14T07:26:38.402Z | 114 | big-noedits | Y Y N N | why a service fails when one zone goes down |
| 9 | 019dd6ae-87f7-7a63-aa11-18de1a1bec87 | 2026-04-30T00:49:16.412Z | 16 | mid-edits | Y Y N Y | what a usage credit costs, and a fix to the cost code |
| 10 | 3eb482e2-8056-4fa1-bef1-cba32028c0c1 | 2026-07-02T23:25:49.116Z | 17 | mid-edits | P Y Y Y | removing token cost reporting, then the MCP tools |
| 11 | a0377df3-cc58-44c1-8fe5-816e537e8c4e | 2026-07-10T05:34:02.062Z | 21 | mid-edits | P P N Y | a build checked end to end, then why its token savings fell |
| 12 | abd0edc6-ea0f-45e7-97c6-ae7266ec9ae6 | 2026-09-30T07:07:56.356Z | 17 | mid-edits | Y Y Y Y | narrowing a project's CLAUDE.md on a new branch |
| 13 | 019e057a-a370-7ee3-a82a-7f68be98143d | 2026-05-08T10:00:49.382Z | 11 | mid-edits | Y Y Y Y | whether an ExecPlan and plans.md fit a workflow |
| 14 | 019e1a2c-4f34-7d82-a84c-0d279651fce5 | 2026-05-12T03:50:21.641Z | 26 | mid-noedits | Y Y N N | what a context tool stores: questions, answers or both |
| 15 | 019df045-f5dd-7bf1-af26-c56465c54162 | 2026-05-04T01:19:11.569Z | 35 | mid-noedits | Y Y N N | what an article on harness engineering says |
| 16 | d8fef919-3433-41fe-ac40-cab21e1921ed | 2026-08-19T00:04:28.537Z | 15 | mid-noedits | Y Y Y Y | a PR review workflow that reads the whole code |
| 17 | 019db7a8-23e4-7d03-9a85-0495c14732c5 | 2026-04-23T05:32:28.562Z | 25 | mid-noedits | Y Y N N | whether a Kafka binder can consume in batches |
| 18 | 8aa6e957-2e90-46f0-b49e-e44599bef63b | 2026-09-18T13:41:24.561Z | 30 | mid-noedits | Y Y Y Y | whether a game really runs on fly neuron data |
| 19 | 838ede85-842b-4730-b61b-868bc693e080 | 2026-10-02T08:09:28.466Z | 6 | small | Y Y Y Y | model names in generated skills, updated |
| 20 | 019eb1d2-db35-71a1-b7c7-d6cebe727bd9 | 2026-06-11T00:42:39.084Z | 5 | small | Y Y N N | reviewing an implementation over several fixes |
