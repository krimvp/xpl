// Package metrics keeps counters that are fed by bus events, never by direct calls from the worker.
package metrics

import (
	"fmt"
	"slices"
	"sync"
	"time"

	"example.com/jobrunner/internal/bus"
)

// Metrics counts completed jobs.
type Metrics struct {
	prefix string

	mu            sync.Mutex
	completed     int
	totalDuration time.Duration
	byType        map[string]int
}

// New returns empty metrics whose names start with prefix.
func New(prefix string) *Metrics {
	return &Metrics{prefix: prefix, byType: make(map[string]int)}
}

// OnJobCompleted handles "job.completed". Nothing calls it directly: it only runs when the bus delivers an event.
func (m *Metrics) OnJobCompleted(e bus.JobCompleted) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.completed++
	m.totalDuration += e.Duration
	m.byType[e.Type]++
}

// Register wires m to the bus.
func Register(b *bus.Bus, m *Metrics) {
	bus.Subscribe(b, "job.completed", m.OnJobCompleted)
}

// Completed returns how many jobs have completed.
func (m *Metrics) Completed() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.completed
}

// Lines renders the counters as `name value` lines, each name starting with the configured prefix.
func (m *Metrics) Lines() []string {
	m.mu.Lock()
	defer m.mu.Unlock()

	lines := []string{
		fmt.Sprintf("%s.jobs.completed %d", m.prefix, m.completed),
		fmt.Sprintf("%s.jobs.duration_ms_total %d", m.prefix, m.totalDuration.Milliseconds()),
	}
	types := make([]string, 0, len(m.byType))
	for t := range m.byType {
		types = append(types, t)
	}
	slices.Sort(types)
	for _, t := range types {
		lines = append(lines, fmt.Sprintf("%s.jobs.completed{type=%q} %d", m.prefix, t, m.byType[t]))
	}
	return lines
}
