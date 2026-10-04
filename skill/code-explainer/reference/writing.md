# Writing for readers

The viewer shows your text next to the code. Four kinds of people read it:

- a **newcomer** who knows the language but not this code;
- a **reviewer** who needs to know what changed and what it affects;
- a **manager** who reads the first screen for 2-3 minutes and never opens the code;
- a **presenter** who reads the step titles and notes aloud.

Write the tour `summary` for the manager, the notes for the newcomer, and keep every claim good enough for the reviewer. Most readers scan, so the first sentence of each text must carry its message.

**Concept first, code second.** Every text says what a part is _for_, in words a person outside the team would use, before it names any code. The reader learns the idea from your words and the code from the code pane next to them, so a note that strings function names together explains nothing the code does not show already. The higher the level, the fewer code names: none on a system map, one on the inside of a service, a few on a step about code (section 6).

## 1. Where each text goes

Say each fact once, in the place where it belongs.

| Field                              | Says                                                                                     | Length                          | Format          |
| ---------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------- | --------------- |
| tour `summary`                     | what this is and why it matters; for a change: the behaviour change, the risk, the tests | 2-4 sentences (a change: 2-5)   | markdown        |
| tour `title`                       | the question the tour answers, or what it covers; for a change, the change               | about 8 words                   | plain           |
| note heading (`### ...`)           | the point of this step, as a statement                                                   | about 8 words                   | plain           |
| note body                          | what to notice here and why it matters; what no summary says                             | 1-3 sentences, 60 words at most | markdown        |
| element `summary`                  | what this code does, with its conditions                                                 | 1-2 sentences                   | inline markdown |
| element `detail`                   | the cases, conditions and lists that do not fit in the summary                           | only when needed                | markdown        |
| view `title`                       | what the picture shows                                                                   | about 8 words                   | plain           |
| flow step `label`                  | the stage, in plain words ("Find a handler", "Answer 400")                               | 2-5 words                       | plain           |
| sequence step `label`              | the call, as written in the code (`requeue(job, backoff)`)                               | the call text                   | plain           |
| step `summary`                     | what happens at this step, with its condition                                            | 1-2 sentences                   | inline markdown |
| group, concept and edge labels     | a plain noun phrase; an edge label may be the topic or key (`job.completed`)             | 1-4 words                       | plain           |
| box `label` on an architecture map | what the part is to a reader ("Payments", "Orders database"), not its folder or class    | 1-3 words                       | plain           |
| box `tech`                         | the technology ("PostgreSQL", "REST API", "Go service")                                  | 1-3 words                       | plain           |
| arrow label to an outside box      | what passes ("stores orders", "charges cards", "sends receipts")                         | 1-4 words                       | plain           |
| frame `label`                      | when the steps inside run ("attempts left", "for each route")                            | a short condition, may be code  | plain           |

**Formats.** _Markdown_ fields render markdown. Headings and links go only in a note body or a `detail`. _Inline markdown_ fields render code spans and emphasis (`` `Queue.requeue` ``, `**Changed:**`), but no headings or links. _Plain_ fields are shown as written, so `**Changed:**` appears with its asterisks: write no markup there. Backticks around identifiers are fine everywhere. The reply to the user is not a field: SKILL.md, "Show the result", says what it holds.

A summary is concrete and about this code ("requeues with `baseDelay * 2^attempt`, capped at `maxDelay`"), never generic ("handles retries"). A note never repeats the summary of what its step focuses: the viewer shows that summary already. When both need the same guard condition, the summary states the guard and the note says what it means for the reader ("with the default settings, the cap is not reached"). The note adds the "so what": why this step matters, what the reader should look at, or the condition that changes the outcome. A heading is not the first sentence of the body again.

## 2. The rules

1. **Short sentences.** Aim for 15-20 words; `xpl lint` flags a sentence over 25 words and a field whose sentences average over 20. One idea per sentence. Split at a semicolon and at "and then".
2. **Active voice, present tense.** "The queue hands out the oldest due job", not "the oldest due job is handed out".
3. **Name the subject.** No sentence starts with a bare "It", "This" or "They": repeat the noun (`Runner.dispatch` calls ...). An element `summary` may start with a verb ("Runs one attempt ..."), because the viewer shows the element's name next to it. Notes and the tour summary always name their subject.
4. **Common words.** Use, start, end, check, send, keep. Not utilize, commence, leverage, facilitate. Use one word for one meaning: if "wrap" means "calls inside a `try`", do not also use it for "adds a layer".
5. **Define each term the first time it appears**, in one clause: "a dead-letter list, where jobs with no retries left are kept, ...". This covers protocol names, acronyms, header fields and the project's own jargon (backoff, lease, in-flight). Define it in the tour summary or the first note that uses it, not later.
6. **Identifiers in backticks** in summaries and notes: `backoffDelay`, `Queue.requeue`. Titles: section 3.
7. **No marketing or filler words**: powerful, robust, seamless, elegant, simply, just, basically, crucial, comprehensive, leverage, utilize, facilitate, intuitive, under the hood, it is worth noting. `xpl lint` has the full list, each with a plain replacement.
8. **No slogans.** A title or note states one fact the code shows. Slogans like "the same way everywhere", "never loses a job", "everything is an event" or "now all three agree" are usually false in some case.
9. **Claims you can prove.** Absolute words, guard conditions, complete lists and folklore follow the rules in SKILL.md, "Accuracy".
10. **One concrete example** helps more than a general rule: "with the default settings, the three retries wait 500 ms, 1 s and 2 s".
11. **Talk to the reader** about their own code: "your handler", "your config file". Do not use "we".
12. **Plain words for the reader**, not tool words: say "box", "picture", "step", not "node", "view", "group", "stub", "llm", "call-site".

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

2-4 sentences in plain words (a change: up to 5): the first thing on the screen. Use at most one or two code identifiers; example input values in backticks (`maxDelayMs: 100`, a sample header) are fine, and often the clearest way to show a behaviour change.

- **Whole project:** what the project is (language and kind: "a Python web framework", "a Go command-line tool"), what it is for, and the main path in one sentence. Take what the project is from its README or package metadata (`xpl show file:README.md`, `pyproject.toml#project.description`), and say nothing the README or the code does not say.
  > go-jobrunner is a small Go program that runs background jobs from an in-memory queue. A runner takes each job, runs it on a worker, and retries a failed job with a growing delay. An event bus tells the metrics when a job finishes. This tour shows those parts and follows one job from the queue to the end.
- **Part of a project:** the question, the answer in one or two sentences, and what the tour leaves out.
- **No code names in the summary** unless the reader must type one (a command, a setting). Say "the payment step", not `chargeCard`.
  > A failed job is retried with a growing delay until its retry budget is spent. After that, the runner parks it in a dead-letter list. The runner makes each decision, and the queue stores the job again. Metrics and the worker pool are left out.
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
> After: "How a failed job is retried". The summary then says what the code does: after `retry.maxRetries` retries, the runner moves the job to a dead-letter list, which is kept in memory.

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
> After: "When `metrics.enabled` is true, `registerMetrics` subscribes the metrics to `job.completed`, so each successful attempt is counted. With `enabled: false`, the metrics handler is not subscribed, and the counters stay at 0."

**7. Folklore instead of code**

> Before: "The worker kills a job that runs past its timeout."
>
> After: "`withTimeout` rejects after `timeoutMs`, so `Worker.run` reports a failure. The handler's promise is not cancelled: its work can still finish in the background." (A timeout often means "stop the work"; this code only stops waiting.)

**8. A "before" claim nobody checked** (an invented change that makes `loadConfig` reject `maxDelayMs < baseDelayMs`)

> Before: "Before this change, a `maxDelayMs` below `baseDelayMs` was ignored."
>
> After: "Before: `backoffDelay` returned `Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs)`, so every retry waited `maxDelayMs`. Now: `loadConfig` rejects the file and names both keys." (Checked in the base code with `git show <base>:src/runner.ts`, not inferred from the hunk.)

## 6. Concept first: notes by level

A note is 1-3 short sentences under its title (`xpl lint`: `long-note` over 60 words). What it says depends on the picture it sits on:

| The step's picture                | The note says                                                                             | Code names               |
| --------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------ |
| a system map                      | what the system is for, who uses it, what it relies on and why                            | none                     |
| the inside of a service           | each part's job in everyday words, and what it asks of the others or of an outside system | at most 1 (`code-heavy`) |
| a flow, a sequence, a map of code | the one decision or hand-off to notice, then the code that makes it                       | at most 3 (`code-heavy`) |

Start with the role in the system ("The front door: it turns a web request into an order"), then the consequence ("so a failed payment stops before the order is saved"). A comparison to something familiar helps when it is exact: "the queue works like a ticket line: the oldest due job goes first".

**9. A note that is a list of functions**

> Before: "`deriveGraph` lifts each reference of a shown kind to the boxes that stand for its two ends, via `repr`, so `edge:calls:a->b` aggregates `count` refs and `planStubs` turns the rest into ghosts."
>
> After: "### Arrows are worked out, not stored" / "The map draws an arrow between two boxes when code in one calls code in the other. Nobody writes those arrows by hand: the viewer counts the calls each time it draws the map."

**10. A system map step that reads like code**

> Before: "`createServer` registers `POST /orders`, which calls `placeOrder`, `charge` (Stripe SDK) and `saveOrder` (`pg.Pool`)."
>
> After: "### The shop takes orders from customers over the web" / "Customers' apps send orders to the shop. The shop takes the payment through Stripe, keeps the order in its database and emails a receipt."

## 7. Checklist

`xpl lint <name>` checks the mechanical rules (headings, markup, sentence length, bare "It", filler and absolute words, notes that repeat a summary; `cli.md`, `xpl lint`). SKILL.md, "Accuracy", covers the claims. Read every title, label, summary and note once more, in tour order, for what neither can check:

- Does the tour `summary` say what this is and why it matters, before any detail?
- Is every term defined the first time it appears (rule 5), with one word for one meaning (rule 4)?
- Does each title state one fact the code shows, with no slogan (rule 8)?
- Does each note add the "so what" (section 1)? Is each sentence active (rule 2)?
- Could a manager follow the first three steps without opening the code? Does each note on a map say what a part is for before it names code (section 6)?
