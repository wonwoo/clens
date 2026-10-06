# Session record segments: evaluation set

Forty segments of real sessions, written down so that a change to how a
session record shows its segments (`segmentsOf` and `formatSessionRecord`,
`src/mcp/left_off.ts`) can be judged on the same segments again. See the
backlog item "Session record segments too large for two lines".

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

## Segments

| # | Session | Segment start (UTC) | Requests | Group | Author: what before, work, where | Blind: what before, work, topics, where | Second blind: what before, topics only, where | About |
|---|---|---|---|---|---|---|---|---|
| 1 | 54b13785-0de8-418c-a8d6-72cd79b2a5be | 2026-06-17T04:45:27.981Z | 206 | big-edits | P P Y | Y Y Y Y | Y Y Y | docs search tool: dependencies, file types, agent docs, site indexing |
| 2 | 970a8651-554a-4c83-9a6f-e94f7e3d58ca | 2026-08-24T06:39:27.054Z | 102 | big-edits | P Y Y | Y Y Y Y | Y Y Y | tag extraction prompt and its output format |
| 3 | 019e04e5-baf5-71c2-aac2-c804feb102ea | 2026-05-08T01:09:42.010Z | 91 | big-edits | Y Y Y | Y Y Y Y | Y Y Y | plugin workflow state, verify runner, hooks |
| 4 | 2373781f-42a7-4423-ad3e-081a54bb0d58 | 2026-07-15T06:30:56.233Z | 76 | big-edits | P Y Y | Y Y Y Y | Y Y Y | completion notifications, then a desktop mascot |
| 5 | 93f4d58f-8939-46cd-94d2-94bd080c386f | 2026-07-08T03:19:39.051Z | 90 | big-edits | Y Y Y | Y Y Y Y | Y Y Y | image force sync: design, edge cases, tests |
| 6 | 01a0ac91-b55e-7033-926f-41bfee79dc17 | 2026-09-16T23:33:58.417Z | 49 | big-edits | P Y Y | Y Y Y Y | Y Y Y | game-playing learning model: plan, build, improve |
| 7 | 019e3484-28e7-75a1-abef-e8f190ca0b86 | 2026-05-17T10:50:48.703Z | 81 | big-edits | N N N | P P Y N | P Y N | writing skills and how they are routed; a memory deleted by mistake |
| 8 | 88248acc-d8c6-466c-8411-1dc32452979a | 2026-09-30T14:36:14.346Z | 55 | big-edits | P Y Y | P P P Y | P P Y | writing-style rules: research, revise, test, publish |
| 9 | e8932d3e-b9f9-418a-9445-ac63668e847e | 2026-10-01T00:20:59.975Z | 44 | big-edits | Y Y Y | Y Y Y Y | Y Y Y | README check, merge, then a blind comparison of replies |
| 10 | c70ec046-3619-4180-84e4-832f85e57c5a | 2026-07-20T23:55:10.415Z | 136 | big-edits | P P Y | P P P Y | P Y Y | skill set review and how to distribute it |
| 11 | 3aa930fa-e925-4be6-87f7-49034e6d0e6f | 2026-07-03T16:58:53.555Z | 50 | big-edits | Y Y Y | Y Y Y Y | Y Y Y | dashboard: what it shows and why it is slow |
| 12 | 9daedf1c-e759-43d1-81b9-9f7185c59d31 | 2026-09-02T23:28:28.311Z | 141 | big-edits | P P Y | P P P Y | P P Y | prompt caching questions, then merge and push |
| 13 | 019e0004-e043-7ab3-9176-32c35235355b | 2026-05-07T01:19:44.223Z | 57 | big-noedits | Y Y Y | Y Y Y N | Y Y Y | a skill that runs two reviewers |
| 14 | 4386c3cb-8cac-448d-a794-62d371eb6313 | 2026-08-07T06:25:33.621Z | 72 | big-noedits | Y Y Y | Y Y Y N | Y Y Y | why a project did not work out |
| 15 | 760556a4-ec1c-4c0c-b767-881f077609d9 | 2026-08-26T04:20:13.278Z | 55 | big-noedits | P Y N | Y Y Y N | Y Y N | web search accuracy: research with an agent team |
| 16 | 970a8651-554a-4c83-9a6f-e94f7e3d58ca | 2026-08-31T00:41:26.794Z | 40 | big-noedits | N P N | N N P N | N P N | planning storage wiring around several enums |
| 17 | e8932d3e-b9f9-418a-9445-ac63668e847e | 2026-09-28T01:22:44.874Z | 37 | mid-edits | Y Y Y | Y Y Y Y | Y Y Y | plans for tool improvements, first batch built |
| 18 | 6e30990d-a5d4-4753-a939-337822d605fe | 2026-09-23T02:15:51.327Z | 23 | mid-edits | P P N | P P P N | P P N | impressions of a plugin, turning parts off, a UI tool test |
| 19 | 92a877f5-2ed4-4429-8cb7-1dcfe798809e | 2026-07-17T05:30:34.543Z | 16 | mid-edits | P Y N | P P Y N | P Y N | judging a repository, bringing its agents in |
| 20 | 019dbf6c-5e14-7160-ab07-02f1223b274c | 2026-04-26T06:21:33.544Z | 35 | mid-edits | P P Y | P P Y Y | P Y Y | retrieval chunk size, one commit, a rename |
| 21 | fe59f031-1de5-400e-abe7-8c72da3d3dae | 2026-09-29T03:48:07.219Z | 35 | mid-edits | Y Y Y | Y Y Y Y | Y Y Y | a skill that checks whether a plan can be built |
| 22 | d99f19a7-2851-4d13-98f7-3af9ab67206c | 2026-07-05T06:02:00.784Z | 36 | mid-edits | Y Y Y | Y Y Y Y | Y Y Y | index size, language model install command |
| 23 | b3302b99-a396-4868-9f19-bd53b709746b | 2026-07-08T09:10:14.035Z | 11 | mid-edits | P P N | P P Y N | Y Y N | what text to store, leaving out automated runs |
| 24 | 7c6f01ea-5564-4ca3-b09a-7a4fa74b020f | 2026-08-04T04:08:40.106Z | 14 | mid-edits | Y Y Y | Y Y Y Y | Y Y Y | a size cap, committed and checked on a sandbox |
| 25 | 6f8ba310-8d57-4993-9aeb-f34d71dfc536 | 2026-06-23T01:02:15.800Z | 13 | mid-edits | P P N | P P Y N | P Y N | a test-loop skill that missed a compile error |
| 26 | 019e0cec-1ecc-7521-8290-b90b23630ed5 | 2026-05-12T11:53:23.086Z | 17 | mid-edits | P Y N | Y Y Y N | Y Y N | reviewing and fixing a skill generator |
| 27 | 0aefcd57-4da5-4b84-9045-811ed73a59a0 | 2026-08-05T00:16:01.662Z | 10 | mid-noedits | Y Y Y | P P P Y | P P Y | wrapping up a feature, a bug fix, token use |
| 28 | 019d93e5-c2d2-7de3-a749-a918efcad620 | 2026-04-16T01:27:36.432Z | 11 | mid-noedits | P P N | P P Y N | P Y N | PR review by points, a cache key, an agent role |
| 29 | 01a02346-b145-77c2-876d-c02dff752886 | 2026-08-25T05:27:29.457Z | 20 | mid-noedits | Y Y Y | Y Y Y N | Y Y Y | why web search results are poor |
| 30 | 01a01813-ef35-7c12-b5ac-84b7896e517f | 2026-08-19T03:54:44.573Z | 27 | mid-noedits | Y Y N | Y Y Y N | Y Y N | prompt caching, forcing a tool |
| 31 | 019d896a-1c4f-7400-a4c5-436099d4a172 | 2026-04-14T06:23:03.000Z | 11 | mid-noedits | P P Y | P P Y Y | Y Y Y | search cache code questions, a check blocked by settings |
| 32 | 019e87d9-c5da-7fd2-b5df-eee8b2253ab4 | 2026-06-02T10:48:13.301Z | 13 | mid-noedits | Y Y Y | Y Y Y Y | Y Y Y | reviewing two skills over several fixes |
| 33 | 019e91ec-a8f8-7721-9201-f6d208834a00 | 2026-06-04T10:15:21.299Z | 13 | mid-noedits | Y Y Y | Y Y Y Y | Y Y Y | which skills to add, reviewing two |
| 34 | cf2321da-b354-4b45-9804-f0cbee38bedd | 2026-09-11T05:26:33.793Z | 10 | mid-noedits | P P Y | P P Y N | P Y N | branch state, a new field, a consumer error |
| 35 | b97b4f7c-e490-4a1f-9ddc-8a40dd93e906 | 2026-09-21T05:51:44.983Z | 36 | mid-noedits | P P N | P P P N | Y Y Y | a branch review, then song lyrics |
| 36 | 019ebfd8-49b9-7970-bac9-b010eb09541c | 2026-06-13T10:18:42.728Z | 30 | mid-noedits | P P N | Y Y Y N | Y Y N | a code graph design for reading less |
| 37 | 88248acc-d8c6-466c-8411-1dc32452979a | 2026-10-02T02:51:38.451Z | 9 | small | Y Y Y | Y Y Y Y | Y Y Y | blind comparison of three style guides |
| 38 | 019eb629-bae9-7773-909d-b7265247ab71 | 2026-06-11T14:18:46.392Z | 2 | small | Y Y N | Y Y Y N | Y Y N | a hook question |
| 39 | 019e3dd2-a787-7550-b35f-68c9a3630fff | 2026-05-20T13:01:47.578Z | 2 | small | Y Y Y | Y Y Y Y | Y Y Y | a heap dump taken, to continue later |
| 40 | 019df6d0-8d2b-7c23-a0b7-35b0f560af43 | 2026-05-05T10:42:47.432Z | 6 | small | Y Y Y | Y Y Y Y | Y Y Y | a template bug, how to start the next phase |
