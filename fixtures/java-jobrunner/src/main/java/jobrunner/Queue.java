package jobrunner;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public class Queue {
    public static final class Job {
        public final String id, type;
        public final Object payload;
        public final int priority;
        public final long enqueuedAt;
        public int attempts;
        public long availableAt;

        Job(String id, String type, Object payload, int priority) {
            this.id = id;
            this.type = type;
            this.payload = payload;
            this.priority = priority;
            enqueuedAt = availableAt = System.currentTimeMillis();
        }
    }

    public record DeadJob(Job job, String error, long deadAt) {}
    public final List<DeadJob> dead = new ArrayList<>();
    public int acked;
    private final List<Job> ready = new ArrayList<>();
    private final Map<String, Job> inflight = new HashMap<>();
    private final int maxPending;
    private int nextId = 1;

    public Queue(int maxPending) { this.maxPending = maxPending; }
    public synchronized int size() { return ready.size() + inflight.size(); }
    public synchronized Job push(String type) { return push(type, null, 0); }
    public synchronized Job push(String type, Object payload, int priority) {
        if (ready.size() >= maxPending) throw new IllegalStateException("queue is full");
        Job job = new Job("job-" + nextId++, type, payload, priority);
        ready.add(job);
        return job;
    }

    public synchronized Job pop() {
        long now = System.currentTimeMillis();
        Job job = ready.stream().filter(j -> j.availableAt <= now)
            .min(Comparator.comparingInt((Job j) -> -j.priority).thenComparingLong(j -> j.enqueuedAt))
            .orElse(null);
        if (job != null) {
            ready.remove(job);
            inflight.put(job.id, job);
        }
        return job;
    }

    public synchronized void requeue(Job job, long delayMs) {
        inflight.remove(job.id);
        job.attempts++;
        job.availableAt = System.currentTimeMillis() + delayMs;
        ready.add(job);
    }
    public synchronized void ack(Job job) { inflight.remove(job.id); acked++; }
    public synchronized void deadLetter(Job job, String error) {
        inflight.remove(job.id);
        job.attempts++;
        dead.add(new DeadJob(job, error, System.currentTimeMillis()));
    }
}
