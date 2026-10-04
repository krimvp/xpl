package jobrunner;

import java.util.HashMap;
import java.util.Map;
import java.util.function.Consumer;

public final class Runner {
    public final class Stats {
        public int processed, deadLettered;
        public final Map<String, Long> msByType = new HashMap<>();
        void record(Queue.Job job, long elapsedMs) {
            processed++;
            msByType.merge(job.type, elapsedMs, Long::sum);
        }
    }
    public final Stats stats = new Stats();
    private final Queue queue;
    private final WorkerPool pool;
    private final Config config;
    private final Consumer<String> logger;
    private volatile boolean running;
    private Thread thread;

    public Runner(Queue queue, WorkerPool pool, Config config, Consumer<String> logger) {
        this.queue = queue;
        this.pool = pool;
        this.config = config;
        this.logger = logger;
    }
    public void start() {
        running = true;
        thread = new Thread(() -> {
            try { dispatch(); }
            catch (InterruptedException error) { Thread.currentThread().interrupt(); }
        });
        thread.start();
    }
    public void stop() throws InterruptedException {
        running = false;
        thread.join();
    }
    public void dispatch() throws InterruptedException {
        while (running) {
            Queue.Job job = queue.pop();
            if (job == null) { Thread.sleep(config.number("queue", "idleDelayMs")); continue; }
            Worker worker = pool.lease();
            long startedAt = System.currentTimeMillis();
            Worker.RunResult result;
            try {
                logger.accept("dispatching " + job.id + " (attempt " + (job.attempts + 1) + ")");
                result = worker.run(job, config.number("workers", "timeoutMs"));
            } finally { pool.release(worker); }
            stats.record(job, System.currentTimeMillis() - startedAt);
            if (result.ok()) { queue.ack(job); continue; }
            int attempt = job.attempts + 1;
            if (attempt <= config.number("retry", "maxRetries")) {
                queue.requeue(job, backoffDelay(attempt, config.number("retry", "baseDelayMs"), config.number("retry", "maxDelayMs")));
            } else {
                queue.deadLetter(job, result.error());
                stats.deadLettered++;
                logger.accept("dead-lettered " + job.id + " after " + attempt + " attempts");
            }
        }
        logger.accept("dispatch loop stopped");
    }
    public static long backoffDelay(int attempt, long baseDelayMs, long maxDelayMs) {
        return (long) Math.min(baseDelayMs * Math.pow(2, attempt - 1), maxDelayMs);
    }
}
