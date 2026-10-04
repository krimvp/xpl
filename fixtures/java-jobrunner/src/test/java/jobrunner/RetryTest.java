package jobrunner;

import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/** Standard-library end-to-end checks. Run this main explicitly; no JUnit is required. */
public final class RetryTest {
    private record Outcome(Queue queue, Metrics metrics) {}
    private static Outcome runOne(Handler handler) throws Exception {
        Config config = Config.parseYaml("queue:\n  idleDelayMs: 1\nworkers:\n  timeoutMs: 100\nretry:\n  maxRetries: 3\n  baseDelayMs: 1\n  maxDelayMs: 10\n");
        EventBus bus = new EventBus();
        Metrics metrics = new Metrics("test");
        metrics.registerMetrics(bus);
        Queue queue = new Queue(10);
        Runner runner = new Runner(queue, new WorkerPool(List.of(new Worker("w1", Map.of("job", handler), bus))), config, message -> {});
        queue.push("job");
        runner.start();
        try {
            long deadline = System.nanoTime() + 5_000_000_000L;
            while (queue.size() > 0 && System.nanoTime() < deadline) Thread.sleep(1);
            check(queue.size() == 0, "runner did not settle within five seconds");
        } finally { runner.stop(); }
        return new Outcome(queue, metrics);
    }
    private static void check(boolean condition, String message) {
        if (!condition) throw new AssertionError(message);
    }
    public static void main(String[] args) throws Exception {
        Outcome recovered = runOne(job -> {
            if (job.attempts < 2) throw new IllegalStateException("boom");
            return "done";
        });
        check(recovered.queue.acked == 1 && recovered.queue.dead.isEmpty(), "two failures then success must ack");
        check(recovered.metrics.completed == 1, "success must reach metrics through the bus");
        Outcome failed = runOne(new FailingHandler());
        check(failed.queue.acked == 0 && failed.queue.dead.size() == 1, "persistent failure must dead-letter");
        check(failed.queue.dead.get(0).job().attempts == 4, "three retries allow four attempts");
        check(failed.queue.dead.get(0).error().contains("this job always fails"), "dead letter must retain the cause");
        check(failed.metrics.completed == 0, "failures must not emit completion");
        Outcome timedOut = runOne(job -> { Thread.sleep(1000); return null; });
        check(timedOut.queue.dead.get(0).error().contains("TimeoutException"), "timeout must fail the attempt");
        check(timedOut.metrics.completed == 0, "timed out work must not emit completion");
        long[] expected = {100, 200, 400, 800, 1000};
        for (int i = 0; i < expected.length; i++) check(Runner.backoffDelay(i + 1, 100, 1000) == expected[i], "backoff must double and cap");
        Config config = Config.loadConfig(Path.of("config/default.yaml"));
        check(config.number("retry", "maxRetries") == 3 && config.number("retry", "baseDelayMs") == 500 && config.number("retry", "maxDelayMs") == 30000, "default retry policy");
        Queue ordered = new Queue(10);
        Queue.Job low = ordered.push("low", null, 0);
        Queue.Job high = ordered.push("high", null, 5);
        check(ordered.pop() == high, "highest priority goes first");
        ordered.requeue(high, 60000);
        check(ordered.pop() == low && ordered.pop() == null, "jobs in backoff must wait");
        System.out.println("retry, timeout, metrics, priority and config checks passed");
    }
}
