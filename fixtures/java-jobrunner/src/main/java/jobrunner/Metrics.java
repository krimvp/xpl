package jobrunner;

import java.util.HashMap;
import java.util.Map;

public final class Metrics {
    public int completed;
    public long totalDurationMs;
    public final Map<String, Integer> completedByType = new HashMap<>();
    private final String prefix;
    public Metrics(String prefix) { this.prefix = prefix; }
    public void onJobCompleted(EventBus.JobCompleted event) {
        completed++;
        totalDurationMs += event.durationMs();
        completedByType.merge(event.type(), 1, Integer::sum);
    }
    public void registerMetrics(EventBus bus) { bus.on("job.completed", this::onJobCompleted); }
    public String formatMetrics() {
        StringBuilder lines = new StringBuilder(prefix + ".jobs.completed " + completed + "\n" + prefix + ".jobs.duration_ms_total " + totalDurationMs);
        completedByType.forEach((type, count) -> lines.append("\n").append(prefix).append(".jobs.completed{type=\"").append(type).append("\"} ").append(count));
        return lines.toString();
    }
}
