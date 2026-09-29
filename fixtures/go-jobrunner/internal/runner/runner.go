// Package runner contains the dispatch loop and the retry policy.
package runner

import (
	"context"
	"errors"
	"fmt"
	"time"

	"example.com/jobrunner/internal/config"
	"example.com/jobrunner/internal/queue"
	"example.com/jobrunner/internal/worker"
)

// JobQueue is the part of a queue the runner needs. *queue.Queue satisfies it implicitly,
// and so can any other implementation (a networked queue, a test double).
type JobQueue interface {
	Pop() (*queue.Job, error)
	Requeue(job *queue.Job, delay time.Duration) error
	Ack(job *queue.Job) error
	DeadLetter(job *queue.Job, cause error) error
}

// WorkerPool hands out workers one at a time. *worker.Pool satisfies it implicitly.
type WorkerPool interface {
	Lease(ctx context.Context) (*worker.Worker, error)
	Release(w *worker.Worker)
}

// Config is the slice of configuration the runner needs.
type Config struct {
	IdleDelay time.Duration
	Timeout   time.Duration
	Retry     config.Retry
}

// Logf is a printf-style logger.
type Logf func(format string, args ...any)

// Stats are counters the runner keeps for itself (metrics fed by the bus live in the metrics package).
type Stats struct {
	Processed    int
	DeadLettered int
	TimeByType   map[string]time.Duration
}

func (s *Stats) record(job *queue.Job, elapsed time.Duration) {
	if s.TimeByType == nil {
		s.TimeByType = make(map[string]time.Duration)
	}
	s.Processed++
	s.TimeByType[job.Type] += elapsed
}

// Runner pulls jobs off a queue one at a time and runs each on a leased worker.
// The retry policy lives here: the queue only stores jobs, the worker only runs them.
type Runner struct {
	Stats Stats
	queue JobQueue
	pool  WorkerPool
	cfg   Config
	logf  Logf
}

// New returns a Runner. A nil logf discards log output.
func New(q JobQueue, p WorkerPool, cfg Config, logf Logf) *Runner {
	if logf == nil {
		logf = func(string, ...any) {}
	}
	return &Runner{queue: q, pool: p, cfg: cfg, logf: logf}
}

// Dispatch runs the loop until ctx is cancelled, which is a normal stop and returns nil; the job
// in progress is allowed to finish. Any other error means the queue or the pool failed.
func (r *Runner) Dispatch(ctx context.Context) error {
	for ctx.Err() == nil {
		// Take the next job; an empty queue means we wait a tick.
		// (Jobs are ordered by priority, then by enqueue time.)
		job, err := r.queue.Pop()
		if errors.Is(err, queue.ErrEmpty) {
			sleep(ctx, r.cfg.IdleDelay)
			continue
		}
		if err != nil {
			return fmt.Errorf("pop: %w", err)
		}

		// Lease a free worker; it goes back to the pool when we are done.
		w, err := r.pool.Lease(ctx)
		if err != nil {
			return fmt.Errorf("lease a worker for %s: %w", job.ID, err)
		}
		startedAt := time.Now()
		r.logf("dispatching %s (attempt %d)", job.ID, job.Attempts+1)
		// A worker never panics or errors for job failures; it reports them in the result.
		// Timeouts are enforced inside the worker. WithoutCancel lets a job finish during shutdown.
		result := w.Run(context.WithoutCancel(ctx), job, worker.Options{Timeout: r.cfg.Timeout})
		r.pool.Release(w)
		r.Stats.record(job, time.Since(startedAt))

		if result.OK() {
			if err := r.queue.Ack(job); err != nil {
				return fmt.Errorf("ack %s: %w", job.ID, err)
			}
			continue
		}

		// Retry policy: exponential backoff up to MaxRetries, then dead-letter.
		attempts := job.Attempts + 1
		if attempts <= r.cfg.Retry.MaxRetries {
			backoff := backoffDelay(attempts, r.cfg.Retry)
			if err := r.queue.Requeue(job, backoff); err != nil {
				return fmt.Errorf("requeue %s: %w", job.ID, err)
			}
		} else {
			if err := r.queue.DeadLetter(job, result.Err); err != nil {
				return fmt.Errorf("dead-letter %s: %w", job.ID, err)
			}
			r.Stats.DeadLettered++
			r.logf("dead-lettered %s after %d attempts", job.ID, attempts)
		}
	}

	r.logf("dispatch loop stopped")
	return nil
}

// backoffDelay is the exponential backoff for the n-th failure (n starts at 1): base * 2^(n-1), capped at MaxDelay.
func backoffDelay(attempt int, retry config.Retry) time.Duration {
	delay := retry.BaseDelay
	for i := 1; i < attempt && delay < retry.MaxDelay; i++ {
		delay *= 2
	}
	return min(delay, retry.MaxDelay)
}

// sleep waits for d or until ctx is done, whichever comes first.
func sleep(ctx context.Context, d time.Duration) {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-timer.C:
	case <-ctx.Done():
	}
}
