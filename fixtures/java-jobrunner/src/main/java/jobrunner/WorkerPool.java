package jobrunner;

import java.util.Collection;
import java.util.concurrent.LinkedBlockingQueue;

public final class WorkerPool {
    private final LinkedBlockingQueue<Worker> idle;
    public WorkerPool(Collection<Worker> workers) { idle = new LinkedBlockingQueue<>(workers); }
    public Worker lease() throws InterruptedException { return idle.take(); }
    public void release(Worker worker) { idle.add(worker); }
}
