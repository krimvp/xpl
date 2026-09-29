// Command jobrunner wires the job runner together and runs a short demo.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"sync"
	"time"

	"example.com/jobrunner/internal/bus"
	"example.com/jobrunner/internal/config"
	"example.com/jobrunner/internal/metrics"
	"example.com/jobrunner/internal/queue"
	"example.com/jobrunner/internal/runner"
	"example.com/jobrunner/internal/worker"
)

func main() {
	path := "config/default.yaml"
	if len(os.Args) > 1 {
		path = os.Args[1]
	}
	if err := run(path); err != nil {
		fmt.Fprintln(os.Stderr, "jobrunner:", err)
		os.Exit(1)
	}
}

// demoHandlers are sample job types: one that works, one that needs retries, one that never works.
func demoHandlers() map[string]worker.Handler {
	var mu sync.Mutex
	attemptsSeen := make(map[string]int)

	return map[string]worker.Handler{
		"echo": func(ctx context.Context, job *queue.Job) (any, error) {
			time.Sleep(20 * time.Millisecond) // pretend to do some work
			return job.Payload, nil
		},
		"flaky": func(ctx context.Context, job *queue.Job) (any, error) {
			mu.Lock()
			attemptsSeen[job.ID]++
			attempt := attemptsSeen[job.ID]
			mu.Unlock()
			if attempt <= 2 {
				return nil, fmt.Errorf("flaky failure on attempt %d", attempt)
			}
			return "recovered", nil
		},
		"broken": func(ctx context.Context, job *queue.Job) (any, error) {
			return nil, errors.New("this job always fails")
		},
	}
}

func run(path string) error {
	cfg, err := config.Load(path)
	if err != nil {
		return err
	}

	// Metrics only ever hear about completed jobs through the bus.
	b := bus.New()
	m := metrics.New(cfg.Metrics.Prefix)
	if cfg.Metrics.Enabled {
		metrics.Register(b, m)
	}

	handlers := demoHandlers()
	workers := make([]*worker.Worker, cfg.Workers.Count)
	for i := range workers {
		workers[i] = worker.New(fmt.Sprintf("%s-%d", cfg.Workers.NamePrefix, i+1), handlers, b)
	}
	q := queue.New(cfg.Queue.MaxPending)
	r := runner.New(q, worker.NewPool(workers...), runnerConfig(cfg), log.Printf)
	fmt.Printf("queue %q: %d workers, up to %d retries\n", cfg.Queue.Name, len(workers), cfg.Retry.MaxRetries)

	if _, err := q.Push("echo", map[string]any{"greeting": "hello"}, 0); err != nil {
		return err
	}
	if _, err := q.Push("flaky", nil, 5); err != nil {
		return err
	}
	if _, err := q.Push("broken", nil, 0); err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() { done <- r.Dispatch(ctx) }()

	for q.Len() > 0 {
		select {
		case err := <-done: // the loop only ends early when the queue or the pool failed
			return err
		case <-time.After(cfg.Queue.IdleDelay):
		}
	}
	cancel()
	if err := <-done; err != nil {
		return err
	}

	fmt.Printf("acked=%d dead-lettered=%d\n", q.Acked(), len(q.Dead()))
	if cfg.Metrics.PrintSummary {
		for _, line := range m.Lines() {
			fmt.Println(line)
		}
	}
	return nil
}

// runnerConfig picks the values the runner needs out of a full config.
func runnerConfig(cfg config.Config) runner.Config {
	return runner.Config{IdleDelay: cfg.Queue.IdleDelay, Timeout: cfg.Workers.Timeout, Retry: cfg.Retry}
}
