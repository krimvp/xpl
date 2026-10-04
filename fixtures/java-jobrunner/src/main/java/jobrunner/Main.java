package jobrunner;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Map;

public final class Main {
    public static void main(String[] args) throws Exception {
        Config config = Config.loadConfig(Path.of(args.length == 0 ? "config/default.yaml" : args[0]));
        EventBus bus = new EventBus();
        Metrics metrics = new Metrics(config.text("metrics", "prefix"));
        if (config.flag("metrics", "enabled")) metrics.registerMetrics(bus);
        Map<String, Handler> handlers = Map.of("echo", new EchoHandler(), "broken", new FailingHandler(), "flaky", job -> {
            if (job.attempts < 2) throw new IllegalStateException("flaky failure");
            return "recovered";
        });
        var workers = new ArrayList<Worker>();
        for (int i = 0; i < config.number("workers", "count"); i++) {
            workers.add(new Worker(config.text("workers", "namePrefix") + "-" + i, handlers, bus));
        }
        Queue queue = new Queue((int) config.number("queue", "maxPending"));
        Runner runner = new Runner(queue, new WorkerPool(workers), config, System.out::println);
        queue.push("echo", "hello", 0);
        queue.push("flaky", null, 5);
        queue.push("broken");
        runner.start();
        try { while (queue.size() > 0) Thread.sleep(config.number("queue", "idleDelayMs")); }
        finally { runner.stop(); }
        System.out.println("acked=" + queue.acked + " dead-lettered=" + queue.dead.size());
        if (config.flag("metrics", "printSummary")) System.out.println(metrics.formatMetrics());
    }
}
