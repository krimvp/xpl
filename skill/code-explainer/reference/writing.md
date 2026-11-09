# Writing for readers

The viewer shows your text next to the code. Four kinds of people read it:

- a **newcomer** who knows the language but not this code;
- a **reviewer** who needs to know what changed and what it affects;
- a **manager** who reads the first screen for 2-3 minutes and never opens the code;
- a **presenter** who reads the step titles and notes aloud.

Write the tour `summary` for the manager, the notes for the newcomer, and keep every claim good enough for the reviewer. Most readers scan, so the first sentence of each text must carry its message.

**Concept first, code second.** Every text says what a part is _for_ before it names any code. Use the words a person outside the team would use. The reader learns the idea from your words and the code from the code pane next to them. A note that strings function names together tells the reader nothing that the code does not show. The higher the level, the fewer code names (section 6). A system map names none, the inside of a service names one, and a step about code names a few.

## 1. Where each text goes

Say each fact once, in the place where it belongs.

Write every authored text before ready export, including frame labels, transition conditions, audience and technology. `xpl lint` checks all of them for TODO placeholders. A tour note is one stored field, including its heading and body.

| Field                              | Says                                                                                               | Length                          | Format          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------- | --------------- |
| tour `summary`                     | the answer first, then up to four reasons; for a change: the behaviour change, the risk, the tests | 2-5 sentences                   | markdown        |
| tour `title`                       | the question the tour answers, or what it covers; for a change, the change                         | about 8 words                   | plain           |
| note heading (`### ...`)           | the point of this step, as a statement                                                             | about 8 words                   | plain           |
| note body                          | what to notice here and why it matters; what no summary says; a comparison may be a small table    | 1-3 sentences, 50 words at most | markdown        |
| element `summary`                  | what this part is for, then what it does, with its conditions                                      | 1-2 sentences, 45 words at most | inline markdown |
| element `detail`                   | the cases, conditions and lists that do not fit in the summary                                     | paragraphs of 80 words at most  | markdown        |
| view `title`                       | what the diagram shows                                                                             | about 8 words                   | plain           |
| flow step `label`                  | the stage, in plain words ("Find a handler", "Answer 400")                                         | 2-5 words                       | plain           |
| sequence step `label`              | the call, as written in the code (`requeue(job, backoff)`)                                         | the call text                   | plain           |
| step `summary`                     | what happens at this step, with its condition                                                      | 1-2 sentences, 45 words at most | inline markdown |
| group, concept and edge labels     | a plain noun phrase; an edge label may be the topic or key (`job.completed`)                       | 1-4 words                       | plain           |
| box `label` on an architecture map | what the part is to a reader ("Payments", "Orders database"), not its folder or class              | 1-3 words                       | plain           |
| box `tech`                         | the technology ("PostgreSQL", "REST API", "Go service")                                            | 1-3 words                       | plain           |
| arrow label to an outside box      | what passes ("stores orders", "charges cards", "sends receipts")                                   | 1-4 words                       | plain           |
| frame `label`                      | when the steps inside run ("attempts left", "for each route")                                      | a short condition, may be code  | plain           |

**Formats.** _Markdown_ fields render markdown. Headings and links go only in a note body or a `detail`. _Inline markdown_ fields render code spans and emphasis (`` `Queue.requeue` ``, `**Changed:**`), but no headings or links. _Plain_ fields are shown as written, so `**Changed:**` appears with its asterisks: write no markup there. Backticks around identifiers are fine everywhere. The reply to the user is not a field: SKILL.md, "Workflow", says what it holds.

**Tables.** A note may compare two to four things: two options, a value before and after, the policies of a setting. Then a small table after its sentences reads faster than a list. Write a header row, a rule row, then one row per item. Start and end each row with `|`. Leave a blank line before the table. Keep each cell to a few words. `:--`, `:-:` or `--:` in the rule row aligns a column left, centre or right. The Tour tab and Present show the table under the note, in both themes. `xpl lint` reads each cell on its own, so a row is never one long sentence, but the cells count toward the note's 50 words.

```
### A fixed wait never grows

The backoff policy doubles the wait after each failure; the fixed one does not.

| Policy  | First retry waits | Third retry waits |
| ------- | ----------------: | ----------------: |
| fixed   |            500 ms |            500 ms |
| backoff |            500 ms |               2 s |
```

A summary is concrete and about this code ("requeues with `baseDelay * 2^attempt`, capped at `maxDelay`"), never generic ("handles retries"). A note never repeats the summary of what its step focuses: the viewer shows that summary already. Both may need the same guard condition. Then the summary states the guard, and the note says what it means for the reader ("with the default settings, the cap is not reached"). The note adds the "so what": why this step matters, what the reader should look at, or the condition that changes the outcome. A heading is not the first sentence of the body again.

## 2. The rules

1. **Short sentences, one topic each.** A sentence that tells someone to do something has 20 words at most. Any other sentence has 25 words at most; aim for 15. `xpl lint` flags a sentence over 25 words and a field whose sentences average over 20. Split at a semicolon and at "and then".
2. **Active voice, present tense.** "The queue hands out the oldest due job", not "the oldest due job is handed out". `xpl lint` flags a field with two passive clauses or more (`passive-voice`).
3. **Name the subject.** No sentence starts with a bare "It", "This" or "They": repeat the noun (`Runner.dispatch` calls ...). An element `summary` may start with a verb ("Runs one attempt ..."), because the viewer shows the element's name next to it. Its second sentence may then start with "It". Notes and the tour summary always name their subject. `xpl lint` (`bare-it`) also flags "These are", "There is" and "There are". Do not make a noun of the action the subject ("Discovery uses git"): name the code that does it ("`listFiles` uses git"). `xpl lint` flags this as `abstract-subject`.
4. **Common words, one meaning each.** Use the words in section 2b. If "wrap" means "calls inside a `try`", do not also use it for "adds a layer".
5. **Define each term the first time it appears**, in one clause: "a dead-letter list, where the runner keeps jobs with no retries left, ...". This covers protocol names, acronyms, header fields and the project's own jargon (backoff, lease, in-flight). Define it in the tour summary or the first note that uses it, not later.
6. **Identifiers in backticks** in summaries and notes: `backoffDelay`, `Queue.requeue`. Titles: section 3.
7. **No marketing or filler words**: powerful, robust, seamless, elegant, simply, just, basically, crucial, comprehensive, leverage, utilize, facilitate, intuitive, under the hood, it is worth noting. `xpl lint` has the full list, each with a plain replacement.
8. **No slogans.** A title or note states one fact the code shows. Slogans like "the same way everywhere", "never loses a job", "everything is an event" or "now all three agree" are usually false in some case.
9. **Claims you can prove.** Absolute words, guard conditions, complete lists and folklore follow the rules in SKILL.md, "Accuracy".
10. **One concrete example** helps more than a general rule: "with the default settings, the three retries wait 500 ms, 1 s and 2 s".
11. **Talk to the reader** about their own code: "your handler", "your config file". Do not use "we" (`xpl lint`: `we-voice`).
12. **Plain words for the reader**, not tool words: say box, diagram (or map, flow, sequence), step, arrow and code link. `xpl lint` (`tool-word`) flags evidence, upsert, llm, provenance, stub, ghost, overlay and call-site everywhere, and node, edge and anchor in tours only: a box summary may describe code that has nodes and edges of its own. A word that is in the name of a box of the guide passes, and so does "stub" in a text about tests. Avoid "view" and "group" too.
13. **Rewrite, do not append.** When the code changes, rewrite the text whole, so the summary still says what the part is for in 1-2 sentences. Put a new case in `detail` or in a step of its own. A summary is never a list of changes.
14. **Tell the reader what the code does**, not what to do. "Look at", "Notice" and "Compare" are fine. Author steps (reindex, choose an anchor) belong in the skill, not in a guide.

### 2a. Orwell and Simplified Technical English

The rules above follow George Orwell's six rules from "Politics and the English Language", applied to guides:

1. No worn-out figures of speech: not "the heart of", "under the hood", "heavy lifting", "glue", "source of truth".
2. No long word where a short one will do: "use", not "utilize".
3. Cut every word you can: "to", not "in order to"; drop "very", "really", "actually".
4. Active, not passive: "the runner requeues the job", not "the job is requeued".
5. No jargon when an everyday word exists: "the code that calls it", not "the call-site".
6. Break any of these rules before you write something unclear.

They also follow the core of ASD-STE100, Simplified Technical English:

- An instruction has 20 words at most; a description has 25 at most.
- One topic per sentence, and one instruction per sentence.
- A paragraph has 6 sentences at most, and starts with its topic.
- Use the active voice and the simple present tense.
- Use one word for one meaning, and keep it everywhere (section 2b).
- Keep "the" and "a"; do not drop articles to save words.
- No noun stacks of more than three words: "the queue's retry delay", not "queue retry delay value".
- Use a list for steps that a reader does in order.

### 2b. Words

**Use the word on the left**, not the ones on the right. A code name in backticks is always fine (`validate`, `emit`). `xpl lint` checks the vague verbs (manages, preserve, retain, harness as a verb) and many of the other words on the right, such as utilize, commence and prior to. It does not check the code verbs (render, dispatch, emit, persist, expose, enable, allow, verify, discover, provides, supplies), because they are real API words: choose those yourself.

| Use                           | Not                                                |
| ----------------------------- | -------------------------------------------------- |
| use                           | utilize, leverage, harness (the verb), make use of |
| start                         | commence, initiate, kick off                       |
| end                           | terminate, conclude                                |
| check                         | verify, validate (except the `xpl validate` name)  |
| send                          | dispatch, emit (except the code name)              |
| keep                          | retain, persist, preserve                          |
| let                           | allow, enable, empower                             |
| show                          | display, render, expose, showcase                  |
| get                           | obtain, acquire, retrieve                          |
| find                          | discover, locate                                   |
| change                        | modify, alter, mutate                              |
| many                          | numerous, a number of, myriad, plethora            |
| about                         | regarding, with respect to                         |
| because                       | due to the fact that, since (for a reason)         |
| if                            | in the event that                                  |
| can                           | is able to                                         |
| before                        | prior to                                           |
| a verb that says what it does | handles, manages, takes care of, deals with        |

**One word, one meaning.** These words have one meaning in a guide. Use no other word for the same thing.

| Word             | Means                                                                |
| ---------------- | -------------------------------------------------------------------- |
| guide            | the whole thing a reader opens: one page, one `.explainer.json` file |
| tour             | the ordered steps of a guide                                         |
| step             | one stop in a tour, a flow or a sequence                             |
| diagram          | a map, a flow or a sequence                                          |
| map              | boxes and arrows that show parts and how they connect                |
| flow             | the stages and decisions that one input goes through                 |
| sequence         | who calls whom, in what order                                        |
| box              | one part on a map                                                    |
| arrow            | a line drawn between two boxes, or between two lifelines             |
| concept          | an idea that spans files, with a card of its own                     |
| code link        | the place in the code that a text points at (stored as an anchor)    |
| outside this map | code or a system that the current map does not show                  |
| precise          | a reference that a language tool checked                             |
| heuristic        | a reference that xpl matched by name, which can be wrong             |
| call             | one function runs another                                            |
| import           | one file names another to use its code                               |
| read             | code uses a value without changing it                                |
| outside system   | a database, an API or a queue that the repository does not contain   |

"Wrap", "hook", "handle" and "manage" each need a definition in the guide before you use them.

## 3. Titles and labels

A good title is a plain statement of about 8 words that a presenter can say aloud: "The queue hands out the oldest due job", "Callers now get a `Result` or an error". A class name used as a noun is fine; a call or an expression is not.

A title is never:

- code: `queue.pop()`, `backoff_delay`, `if attempts <= max_retries:`;
- a label: "Fix 1", "Note", "Overview", "Step 3", "Details";
- two titles joined: "Retry policy · Dead-letter list";
- a slogan or a promise: "The job runner in five minutes", "never lose a job".

Every tour note starts with its title as a markdown heading line, then the body:

```
### The queue hands out the oldest due job

`Queue.pop` skips jobs whose delay has not passed yet. Among the rest, the highest priority wins, then the oldest.
```

The viewer shows the heading as the step's title in the contents, the guide and Present, and does not print it again.

Flow step labels name a stage ("Take the next due job", "No retries left: park it"), because the box shows the label in large type. Sequence step labels stay the call text, because they sit on an arrow between two named lifelines.

## 4. The tour summary

The first thing on the screen, so it leads with the answer. The first sentence states the answer to the tour's question (what this is, what the code does, or what the change does for its users). Then up to four sentences give the reasons, one each: 2-5 sentences in plain words. A reader who stops after the first sentence still has the answer, and the steps show the reasons in the code. Use at most one or two code identifiers. Example input values in backticks (`maxDelayMs: 100`, a sample header) are fine. They are often the clearest way to show a behaviour change.

- **Whole project:** what the project is (language and kind: "a Python web framework", "a Go command-line tool"), what it is for, and the main path in one sentence. Take what the project is from its README or package metadata (`xpl show file:README.md`, `pyproject.toml#project.description`), and say nothing the README or the code does not say.
  > go-jobrunner is a small Go program that runs background jobs from an in-memory queue. A runner takes each job, runs it on a worker, and retries a failed job with a growing delay. An event bus tells the metrics when a job finishes. This tour shows those parts and follows one job from the queue to the end.
- **Part of a project:** the answer to the question in the first sentence, then the reasons, and what the tour leaves out.
- **No code names in the summary** unless the reader must type one (a command, a setting). Say "the payment step", not `chargeCard`.
  > The runner puts a failed job back on the queue with a growing delay, until the job uses up its retries. After that, the runner parks the job in a dead-letter list. The runner makes each decision, and the queue stores the job again. This tour leaves out the metrics and the worker pool.
- **A change:** what changes for users (with one example), who is affected, the worst realistic failure (`explain-change.md` section 7), and what the tests cover. Example: `explain-change.md` section 10.

## 5. Rewrites

Each pair shows a mistake that reviewers found in generated explainers. The examples use the job-runner fixtures of the xpl repo (`fixtures/ts-jobrunner`, `py-jobrunner`, `go-jobrunner`) or invented changes to them.

**1. A title made of code**

> Before: `backoffDelay(attempts, this.config.retry)`
>
> After: `### The delay doubles after each failure`

**2. A slogan as the tour title**

> Before: "Retries that never lose a job"
>
> After: "How a failed job is retried". The summary then says what the code does: after `retry.maxRetries` retries, the runner moves the job to a dead-letter list, which the queue keeps in memory.

**3. An undefined term in a slogan**

> Before: "Everything is an event. The worker, the metrics and the runner talk through the bus, so they stay decoupled."
>
> After: "### Metrics hear about jobs through the bus" / "An event bus delivers a message to each function that subscribed to its topic, a name such as `job.completed`. `Worker.run` publishes `job.completed`, and `registerMetrics` subscribes to it. The runner, in contrast, calls the queue directly."

**4. A sentence without a subject, and a list that reads as complete**

> Before: "It pops a job and runs it, then acks or requeues it."
>
> After: "`Runner.dispatch` pops the next due job and runs it on a leased worker. Then the loop acks the job, requeues it with a delay, or dead-letters it."

**5. A long sentence that drops its guard**

> Before: "It sleeps when there is nothing to do, leases a worker, runs the job with a timeout, records stats and then acks, requeues or dead-letters it so the loop can continue."
>
> After: "### Each pass runs one job" / "When the queue has no due job, `Runner.dispatch` sleeps for `idleDelayMs` and tries again. Otherwise the loop leases a worker and runs the job with the configured timeout. Then the loop acks, requeues or dead-letters the job."

**6. A dropped guard condition**

> Before: "Metrics count every finished job."
>
> After: "When `metrics.enabled` is true, `registerMetrics` subscribes the metrics to `job.completed`, so the metrics count each successful attempt. With `enabled: false`, nothing subscribes the metrics handler, and the counters stay at 0."

**7. Folklore instead of code**

> Before: "The worker kills a job that runs past its timeout."
>
> After: "`withTimeout` rejects after `timeoutMs`, so `Worker.run` reports a failure. Nothing cancels the handler's promise: its work can still finish in the background." (A timeout often means "stop the work"; this code only stops waiting.)

**8. A "before" claim nobody checked** (an invented change that makes `loadConfig` reject `maxDelayMs < baseDelayMs`)

> Before: "Before this change, a `maxDelayMs` below `baseDelayMs` was ignored."
>
> After: "Before: `backoffDelay` returned `Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)`, so every retry waited `maxDelayMs`. Now: `loadConfig` rejects the file and names both keys." (Checked in the base code with `git show <base>:src/runner.ts`, not inferred from the hunk.)

## 6. Concept first: notes by level

A note is 1-3 short sentences under its title (`xpl lint`: `long-note` over 50 words). What it says depends on the diagram it sits on:

| The step's diagram                | The first sentence answers             | The note says                                                                             | Code names               |
| --------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------ |
| a system map                      | what is this for, and for whom?        | what the system is for, who uses it, what it relies on and why (SKILL.md, "Accuracy")     | none                     |
| the inside of a service           | what job does this part do?            | each part's job in everyday words, and what it asks of the others or of an outside system | at most 1 (`code-heavy`) |
| a flow, a sequence, a map of code | what does this step decide or hand on? | the one decision or hand-off to notice, then the code that makes it                       | at most 3 (`code-heavy`) |

Name each box of a map in some note, by its label in plain words ("the web server" counts for "Web servers"): `tour-covers-map` checks it. Steps, note lengths and boxes per map for each scope: SKILL.md, "The tour".

Start with the role in the system ("The front door: it turns a web request into an order"). Then give the consequence ("so a failed payment stops before the order is saved"). A comparison to something familiar helps when it is exact: "the queue works like a ticket line: the oldest due job goes first".

**9. A note that is a list of functions**

> Before: "`deriveGraph` lifts each reference of a shown kind to the boxes that stand for its two ends, via `repr`, so `edge:calls:a->b` aggregates `count` refs and `planStubs` turns the rest into ghosts."
>
> After: "### Arrows are worked out, not stored" / "The map draws an arrow between two boxes when code in one calls code in the other. Nobody writes those arrows by hand: the viewer counts the calls each time it draws the map."

**10. A system map step that reads like code**

> Before: "`createServer` registers `POST /orders`, which calls `placeOrder`, `charge` (Stripe SDK) and `saveOrder` (`pg.Pool`)."
>
> After: "### The shop takes orders from customers over the web" / "Customers' apps send orders to the shop. The shop takes the payment through Stripe, keeps the order in its database and emails a receipt."

## 7. Checklist

`xpl lint <name>` checks the mechanical rules: headings, markup, the length of sentences, summaries and `detail` paragraphs, and the words (bare "It", passive voice, "we", tool, filler and absolute words). It also checks the shape: notes that repeat a summary or another tour, diagrams no tour shows, too many concepts and disconnected system maps (`cli.md`, `xpl lint`). SKILL.md, "Accuracy", covers the claims. Read every title, label, summary and note once more, in tour order, for what neither can check:

- Does the first sentence of the tour `summary` give the answer, before any reason or detail?
- Is every term defined the first time it appears (rule 5), with one word for one meaning (rule 4)?
- Does each title state one fact the code shows, with no slogan (rule 8)?
- Does each note add the "so what" (section 1)? Is each sentence active (rule 2)?
- Could a manager follow the first three steps without opening the code? Does each note on a map say what a part is for before it names code (section 6)?
- Does the first step of each diagram say why the part exists before how it works?
- Is every changed text rewritten whole, with no sentence added to an old summary (rule 13)?
- Does the tour end with where to go next: the boxes or views it skipped, and what each answers?
