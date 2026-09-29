package worker

import "context"

// Pool is a fixed set of workers that callers lease one at a time.
type Pool struct {
	idle chan *Worker
}

// NewPool returns a pool holding workers.
func NewPool(workers ...*Worker) *Pool {
	p := &Pool{idle: make(chan *Worker, len(workers))}
	for _, w := range workers {
		p.idle <- w
	}
	return p
}

// Lease takes a free worker, waiting for a release when all of them are busy.
func (p *Pool) Lease(ctx context.Context) (*Worker, error) {
	select {
	case w := <-p.idle:
		return w, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Release gives a worker back to the pool. It never blocks: the channel holds every worker.
func (p *Pool) Release(w *Worker) {
	p.idle <- w
}
