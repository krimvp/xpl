package runner

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"example.com/jobrunner/internal/bus"
	"example.com/jobrunner/internal/config"
	"example.com/jobrunner/internal/metrics"
	"example.com/jobrunner/internal/queue"
	"example.com/jobrunner/internal/worker"
)

var testRetry = config.Retry{MaxRetries: 3, BaseDelay: time.Millisecond, MaxDelay: 4 * time.Millisecond}

// recordingQueue wraps a real queue, records what the runner does with a job, and closes
// settled once the job is acked or dead-lettered. Embedding *queue.Queue promotes Pop, so the
// wrapper satisfies JobQueue without spelling that out.
type recordingQueue struct {
	*queue.Queue
	settled chan struct{}

	mu    sync.Mutex
	calls []string
	once  sync.Once
}

func newRecordingQueue() *recordingQueue {
	return &recordingQueue{Queue: queue.New(10), settled: make(chan struct{})}
}

func (q *recordingQueue) record(call string, settles bool) {
	q.mu.Lock()
	q.calls = append(q.calls, call)
	q.mu.Unlock()
	if settles {
		q.once.Do(func() { close(q.settled) })
	}
}

func (q *recordingQueue) Calls() []string {
	q.mu.Lock()
	defer q.mu.Unlock()
	return slices.Clone(q.calls)
}

func (q *recordingQueue) Requeue(job *queue.Job, delay time.Duration) error {
	q.record(fmt.Sprintf("requeue(%s)", delay), false)
	return q.Queue.Requeue(job, delay)
}

func (q *recordingQueue) Ack(job *queue.Job) error {
	err := q.Queue.Ack(job)
	q.record("ack", true)
	return err
}

func (q *recordingQueue) DeadLetter(job *queue.Job, cause error) error {
	err := q.Queue.DeadLetter(job, cause)
	q.record("dead_letter", true)
	return err
}

// runOne pushes one "job" job through a real runner and waits until it is acked or dead-lettered.
func runOne(t *testing.T, handler worker.Handler) (*recordingQueue, *metrics.Metrics) {
	t.Helper()
	b := bus.New()
	m := metrics.New("test")
	metrics.Register(b, m)

	q := newRecordingQueue()
	pool := worker.NewPool(worker.New("w1", map[string]worker.Handler{"job": handler}, b))
	r := New(q, pool, Config{IdleDelay: time.Millisecond, Timeout: time.Second, Retry: testRetry}, nil)

	if _, err := q.Push("job", nil, 0); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	done := make(chan error, 1)
	go func() { done <- r.Dispatch(ctx) }()

	select {
	case <-q.settled:
	case <-time.After(5 * time.Second):
		t.Fatal("the job was not settled in time")
	}
	cancel()
	if err := <-done; err != nil {
		t.Fatalf("Dispatch returned %v", err)
	}
	return q, m
}

func TestFailsTwiceThenSucceedsIsAckedAfterTwoRequeues(t *testing.T) {
	var calls atomic.Int32
	q, m := runOne(t, func(ctx context.Context, job *queue.Job) (any, error) {
		if n := calls.Add(1); n <= 2 {
			return nil, fmt.Errorf("boom #%d", n)
		}
		return "done", nil
	})

	if got, want := q.Calls(), []string{"requeue(1ms)", "requeue(2ms)", "ack"}; !slices.Equal(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
	if got := q.Acked(); got != 1 {
		t.Errorf("acked = %d, want 1", got)
	}
	if got := len(q.Dead()); got != 0 {
		t.Errorf("dead-lettered = %d, want 0", got)
	}
	if got := m.Completed(); got != 1 {
		t.Errorf("metrics saw %d completed jobs, want 1 (the worker reports over the bus)", got)
	}
}

func TestAlwaysFailingJobIsDeadLetteredAfterMaxRetries(t *testing.T) {
	q, m := runOne(t, func(ctx context.Context, job *queue.Job) (any, error) {
		return nil, errors.New("boom")
	})

	if got, want := q.Calls(), []string{"requeue(1ms)", "requeue(2ms)", "requeue(4ms)", "dead_letter"}; !slices.Equal(got, want) {
		t.Errorf("calls = %v, want %v", got, want)
	}
	if got := q.Acked(); got != 0 {
		t.Errorf("acked = %d, want 0", got)
	}
	dead := q.Dead()
	if len(dead) != 1 {
		t.Fatalf("dead-lettered = %d, want 1", len(dead))
	}
	if got := dead[0].Err.Error(); got != "boom" {
		t.Errorf("dead-letter error = %q, want %q", got, "boom")
	}
	if got, want := dead[0].Job.Attempts, testRetry.MaxRetries+1; got != want {
		t.Errorf("attempts = %d, want %d", got, want)
	}
	if got := m.Completed(); got != 0 {
		t.Errorf("metrics saw %d completed jobs, want 0", got)
	}
}

func TestBackoffDoublesWithEveryFailureAndStopsAtMaxDelay(t *testing.T) {
	policy := config.Retry{MaxRetries: 9, BaseDelay: 100 * time.Millisecond, MaxDelay: time.Second}
	var got []time.Duration
	for attempt := 1; attempt <= 5; attempt++ {
		got = append(got, backoffDelay(attempt, policy))
	}
	want := []time.Duration{100 * time.Millisecond, 200 * time.Millisecond, 400 * time.Millisecond, 800 * time.Millisecond, time.Second}
	if !slices.Equal(got, want) {
		t.Errorf("delays = %v, want %v", got, want)
	}
}

func TestDefaultConfigCarriesTheRetryPolicy(t *testing.T) {
	cfg, err := config.Load("../../config/default.yaml")
	if err != nil {
		t.Fatal(err)
	}
	want := config.Retry{MaxRetries: 3, BaseDelay: 500 * time.Millisecond, MaxDelay: 30 * time.Second}
	if cfg.Retry != want {
		t.Errorf("retry = %+v, want %+v", cfg.Retry, want)
	}
}
