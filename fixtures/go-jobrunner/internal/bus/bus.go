// Package bus is a tiny synchronous publish/subscribe bus keyed by topic name.
package bus

import (
	"log"
	"slices"
	"sync"
	"time"
)

// JobCompleted is the payload of the "job.completed" topic, published by worker.Worker.Run.
type JobCompleted struct {
	JobID    string
	Type     string
	Duration time.Duration
}

// Handler receives the payload of one event.
type Handler func(payload any)

// Bus delivers events to the handlers subscribed to their topic. Publishers and
// subscribers share only a topic name and a payload type.
type Bus struct {
	mu       sync.RWMutex
	handlers map[string][]Handler
}

// New returns an empty bus.
func New() *Bus {
	return &Bus{handlers: make(map[string][]Handler)}
}

// On subscribes h to topic.
func (b *Bus) On(topic string, h Handler) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.handlers[topic] = append(b.handlers[topic], h)
}

// Emit delivers payload to every handler subscribed to topic, in subscription order.
// A panicking handler cannot break the emitter.
func (b *Bus) Emit(topic string, payload any) {
	b.mu.RLock()
	handlers := slices.Clone(b.handlers[topic])
	b.mu.RUnlock()

	for _, h := range handlers {
		deliver(topic, h, payload)
	}
}

func deliver(topic string, h Handler, payload any) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("bus: handler for %q panicked: %v", topic, r)
		}
	}()
	h(payload)
}

// Subscribe is a typed wrapper around On: fn only sees payloads of type T.
func Subscribe[T any](b *Bus, topic string, fn func(T)) {
	b.On(topic, func(payload any) {
		if v, ok := payload.(T); ok {
			fn(v)
		}
	})
}
