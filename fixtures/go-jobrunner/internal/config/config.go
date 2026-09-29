// Package config loads config/default.yaml. The YAML subset is tiny, so it is parsed by hand.
package config

import (
	"bufio"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Queue configures the job queue.
type Queue struct {
	Name       string
	MaxPending int
	IdleDelay  time.Duration
}

// Workers configures the worker pool.
type Workers struct {
	Count      int
	NamePrefix string
	Timeout    time.Duration
}

// Retry is the retry policy.
type Retry struct {
	MaxRetries int
	BaseDelay  time.Duration
	MaxDelay   time.Duration
}

// Metrics configures metric collection.
type Metrics struct {
	Enabled      bool
	Prefix       string
	PrintSummary bool
}

// Config is the whole configuration file.
type Config struct {
	Queue   Queue
	Workers Workers
	Retry   Retry
	Metrics Metrics
}

// Load reads and validates a config file.
func Load(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	return Parse(string(data))
}

// Parse validates the text of a config file.
func Parse(text string) (Config, error) {
	sections, err := parseSections(text)
	if err != nil {
		return Config{}, err
	}

	r := &reader{sections: sections}
	cfg := Config{
		Queue: Queue{
			Name:       read(r, "queue", "name", parseText),
			MaxPending: read(r, "queue", "maxPending", strconv.Atoi),
			IdleDelay:  read(r, "queue", "idleDelayMs", parseMillis),
		},
		Workers: Workers{
			Count:      read(r, "workers", "count", strconv.Atoi),
			NamePrefix: read(r, "workers", "namePrefix", parseText),
			Timeout:    read(r, "workers", "timeoutMs", parseMillis),
		},
		Retry: Retry{
			MaxRetries: read(r, "retry", "maxRetries", strconv.Atoi),
			BaseDelay:  read(r, "retry", "baseDelayMs", parseMillis),
			MaxDelay:   read(r, "retry", "maxDelayMs", parseMillis),
		},
		Metrics: Metrics{
			Enabled:      read(r, "metrics", "enabled", strconv.ParseBool),
			Prefix:       read(r, "metrics", "prefix", parseText),
			PrintSummary: read(r, "metrics", "printSummary", strconv.ParseBool),
		},
	}
	if r.err != nil {
		return Config{}, r.err
	}
	return cfg, nil
}

// reader looks values up in the parsed sections and remembers the first problem it meets.
type reader struct {
	sections map[string]map[string]string
	err      error
}

// read finds section.key and converts it with parse. Once a read has failed, later reads return zero values.
func read[T any](r *reader, section, key string, parse func(string) (T, error)) T {
	var zero T
	if r.err != nil {
		return zero
	}
	raw, ok := r.sections[section][key]
	if !ok {
		r.err = fmt.Errorf("config: missing %s.%s", section, key)
		return zero
	}
	value, err := parse(raw)
	if err != nil {
		r.err = fmt.Errorf("config: %s.%s: %w", section, key, err)
		return zero
	}
	return value
}

func parseText(s string) (string, error) { return s, nil }

// parseMillis converts a whole number of milliseconds.
func parseMillis(s string) (time.Duration, error) {
	n, err := strconv.Atoi(s)
	return time.Duration(n) * time.Millisecond, err
}

var comment = regexp.MustCompile(`(^|\s)#.*$`)

// parseSections parses the YAML subset used by config/default.yaml: top-level `section:` lines,
// each followed by indented `key: value` lines. Comments start with `#`. Values stay as text.
func parseSections(text string) (map[string]map[string]string, error) {
	sections := make(map[string]map[string]string)
	var current map[string]string

	scanner := bufio.NewScanner(strings.NewReader(text))
	for number := 1; scanner.Scan(); number++ {
		line := strings.TrimRight(comment.ReplaceAllString(scanner.Text(), ""), " \t\r")
		if strings.TrimSpace(line) == "" {
			continue
		}

		key, value, found := strings.Cut(line, ":")
		if !found {
			return nil, fmt.Errorf("config line %d: expected \"key: value\"", number)
		}
		key, value = strings.TrimSpace(key), unquote(strings.TrimSpace(value))
		indented := line[0] == ' ' || line[0] == '\t'

		switch {
		case !indented && value != "":
			return nil, fmt.Errorf("config line %d: section %q cannot have a value", number, key)
		case !indented:
			current = make(map[string]string)
			sections[key] = current
		case current == nil:
			return nil, fmt.Errorf("config line %d: %q is outside any section", number, key)
		default:
			current[key] = value
		}
	}
	return sections, scanner.Err()
}

func unquote(s string) string {
	if len(s) >= 2 && (s[0] == '"' || s[0] == '\'') && s[len(s)-1] == s[0] {
		return s[1 : len(s)-1]
	}
	return s
}
