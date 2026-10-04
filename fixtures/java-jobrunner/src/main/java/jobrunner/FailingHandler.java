package jobrunner;

public final class FailingHandler implements Handler {
    @Override public Object handle(Queue.Job job) {
        throw new IllegalStateException("this job always fails");
    }
}
