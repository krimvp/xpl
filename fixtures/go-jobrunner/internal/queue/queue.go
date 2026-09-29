// Package queue holds jobs until a runner asks for them.
package queue

import (
	"errors"
	"fmt"
	"slices"
	"sync"
	"time"
)

// Job is one unit of work.
type Job struct {
	ID          string
	Type        string
	Payload     map[string]any
	Priority    int // higher runs first
	Attempts    int // failed attempts recorded so far
	EnqueuedAt  time.Time
	AvailableAt time.Time // not eligible before this time; used for retry backoff
}

var (
	// ErrEmpty is returned by Pop when no job is due.
	ErrEmpty = errors.New("queue: no job is due")
	// ErrFull is returned by Push when the maximum number of waiting jobs is reached.
	ErrFull = errors.New("queue: full")
	// ErrNotLeased is returned when a job that was never popped is acked, requeued or dead-lettered.
	ErrNotLeased = errors.New("queue: job is not leased")
)

// Queue is an in-memory job queue. It is safe for concurrent use.
type Queue struct {
	mu         sync.Mutex
	ready      []*Job
	inflight   map[string]*Job
	dead       []DeadJob
	maxPending int
	nextID     int
	acked      int
}

// New returns a queue that holds at most maxPending waiting jobs.
func New(maxPending int) *Queue {
	return &Queue{inflight: make(map[string]*Job), maxPending: maxPending, nextID: 1}
}

// Len returns the number of jobs that are waiting or running.
func (q *Queue) Len() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return len(q.ready) + len(q.inflight)
}

// Acked returns how many jobs have been acked.
func (q *Queue) Acked() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.acked
}

// Push adds a job to the queue. It returns ErrFull when maxPending jobs are already waiting.
func (q *Queue) Push(jobType string, payload map[string]any, priority int) (*Job, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	if len(q.ready) >= q.maxPending {
		return nil, ErrFull
	}
	now := time.Now()
	job := &Job{
		ID:          fmt.Sprintf("job-%d", q.nextID),
		Type:        jobType,
		Payload:     payload,
		Priority:    priority,
		EnqueuedAt:  now,
		AvailableAt: now,
	}
	q.nextID++
	q.ready = append(q.ready, job)
	return job, nil
}

// Pop hands out the next job: highest priority first, then oldest enqueue time.
// Jobs that are still backing off are skipped. It returns ErrEmpty when nothing is due.
func (q *Queue) Pop() (*Job, error) {
	q.mu.Lock()
	defer q.mu.Unlock()

	now := time.Now()
	next := -1
	for i, job := range q.ready {
		if job.AvailableAt.After(now) {
			continue
		}
		if next < 0 || runsBefore(job, q.ready[next]) {
			next = i
		}
	}
	if next < 0 {
		return nil, ErrEmpty
	}

	job := q.ready[next]
	q.ready = slices.Delete(q.ready, next, next+1)
	q.inflight[job.ID] = job
	return job, nil
}

// Requeue puts a failed job back to try again after delay. It records the failed attempt.
// The job keeps its original enqueue time, so it goes ahead of newer jobs once it is due.
func (q *Queue) Requeue(job *Job, delay time.Duration) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	if err := q.release(job); err != nil {
		return err
	}
	retry := *job
	retry.Attempts++
	retry.AvailableAt = time.Now().Add(delay)
	q.ready = append(q.ready, &retry)
	return nil
}

// Ack marks a job as done for good.
func (q *Queue) Ack(job *Job) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	if err := q.release(job); err != nil {
		return err
	}
	q.acked++
	return nil
}

// release takes job out of the in-flight set. The caller must hold q.mu.
func (q *Queue) release(job *Job) error {
	if _, ok := q.inflight[job.ID]; !ok {
		return fmt.Errorf("%w: %s", ErrNotLeased, job.ID)
	}
	delete(q.inflight, job.ID)
	return nil
}

// runsBefore reports whether a should be handed out before b.
func runsBefore(a, b *Job) bool {
	if a.Priority != b.Priority {
		return a.Priority > b.Priority
	}
	return a.EnqueuedAt.Before(b.EnqueuedAt)
}
