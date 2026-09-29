// Package worker runs one attempt of a job at a time; a Pool hands workers out.
package worker

import (
	"context"
	"fmt"
	"time"

	"example.com/jobrunner/internal/bus"
	"example.com/jobrunner/internal/queue"
)

// Handler is application code for one job type. Returning an error (or panicking) fails the attempt.
type Handler func(ctx context.Context, job *queue.Job) (any, error)

// Options tune a single Run.
type Options struct {
	Timeout time.Duration
}

// Result is the outcome of one attempt. Failures are values here, not panics.
type Result struct {
	Value    any
	Err      error
	Duration time.Duration
}

// OK reports whether the attempt succeeded.
func (r Result) OK() bool { return r.Err == nil }

// Worker runs jobs with the handlers it was given.
type Worker struct {
	ID       string
	handlers map[string]Handler
	bus      *bus.Bus
}

// New returns a worker that looks handlers up by job type and publishes on b.
func New(id string, handlers map[string]Handler, b *bus.Bus) *Worker {
	return &Worker{ID: id, handlers: handlers, bus: b}
}

// Run runs one attempt of job. Job failures (errors, panics, timeouts) come back in Result.Err
// instead of being returned or propagated; success is published as "job.completed".
func (w *Worker) Run(ctx context.Context, job *queue.Job, opts Options) Result {
	started := time.Now()
	handler, ok := w.handlers[job.Type]
	if !ok {
		return Result{Err: fmt.Errorf("no handler for job type %q", job.Type)}
	}

	ctx, cancel := context.WithTimeout(ctx, opts.Timeout)
	defer cancel()

	type outcome struct {
		value any
		err   error
	}
	done := make(chan outcome, 1) // buffered, so a handler that outlives its timeout cannot leak
	go func() {
		defer func() {
			if r := recover(); r != nil {
				done <- outcome{err: fmt.Errorf("handler panicked: %v", r)}
			}
		}()
		value, err := handler(ctx, job)
		done <- outcome{value: value, err: err}
	}()

	var out outcome
	select {
	case out = <-done:
	case <-ctx.Done():
		out.err = fmt.Errorf("timed out after %s: %w", opts.Timeout, ctx.Err())
	}

	elapsed := time.Since(started)
	if out.err != nil {
		return Result{Err: out.err, Duration: elapsed}
	}

	// Success is announced on the bus; metrics (and anyone else) subscribe by topic.
	w.bus.Emit("job.completed", bus.JobCompleted{JobID: job.ID, Type: job.Type, Duration: elapsed})
	return Result{Value: out.value, Duration: elapsed}
}
