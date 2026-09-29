package queue

import (
	"slices"
	"time"
)

// DeadJob is a job that ran out of retries, with the error of its last attempt.
type DeadJob struct {
	Job    Job
	Err    error
	DeadAt time.Time
}

// DeadLetter parks a job that ran out of retries, together with the error of its last attempt.
func (q *Queue) DeadLetter(job *Job, cause error) error {
	q.mu.Lock()
	defer q.mu.Unlock()

	if err := q.release(job); err != nil {
		return err
	}
	failed := *job
	failed.Attempts++
	q.dead = append(q.dead, DeadJob{Job: failed, Err: cause, DeadAt: time.Now()})
	return nil
}

// Dead returns a copy of the dead-letter list.
func (q *Queue) Dead() []DeadJob {
	q.mu.Lock()
	defer q.mu.Unlock()
	return slices.Clone(q.dead)
}
