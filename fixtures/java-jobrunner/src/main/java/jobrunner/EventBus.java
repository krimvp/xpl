package jobrunner;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

public final class EventBus {
    public record JobCompleted(String jobId, String type, long durationMs) {}
    private final Map<String, List<Consumer<JobCompleted>>> listeners = new HashMap<>();

    public void on(String topic, Consumer<JobCompleted> listener) {
        listeners.computeIfAbsent(topic, key -> new ArrayList<>()).add(listener);
    }
    public void emit(String topic, JobCompleted event) {
        for (Consumer<JobCompleted> listener : listeners.getOrDefault(topic, List.of())) {
            try { listener.accept(event); }
            catch (RuntimeException error) { System.err.println(error.getMessage()); }
        }
    }
}
