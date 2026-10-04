package jobrunner;

import java.util.Map;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

public final class Worker {
    public record RunResult(boolean ok, Object value, String error, long durationMs) {}
    public final String id;
    public String current;
    private final Map<String, Handler> handlers;
    private final EventBus bus;

    public Worker(String id, Map<String, Handler> handlers, EventBus bus) {
        this.id = id;
        this.handlers = handlers;
        this.bus = bus;
    }
    public RunResult run(Queue.Job job, long timeoutMs) {
        long startedAt = System.currentTimeMillis();
        Handler handler = handlers.get(job.type);
        if (handler == null) return new RunResult(false, null, "no handler: " + job.type, 0);
        current = job.id;
        Object value;
        var executor = Executors.newSingleThreadExecutor();
        var future = executor.submit(() -> handler.handle(job));
        try {
            value = future.get(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (Exception error) {
            future.cancel(true);
            if (error instanceof InterruptedException) Thread.currentThread().interrupt();
            Throwable cause = error instanceof ExecutionException ? error.getCause() : error;
            return new RunResult(false, null, cause.toString(), System.currentTimeMillis() - startedAt);
        } finally {
            current = null;
            executor.shutdownNow();
        }
        long durationMs = System.currentTimeMillis() - startedAt;
        bus.emit("job.completed", new EventBus.JobCompleted(job.id, job.type, durationMs));
        return new RunResult(true, value, null, durationMs);
    }
}
