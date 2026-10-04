package jobrunner;

@FunctionalInterface
public interface Handler {
    Object handle(Queue.Job job) throws Exception;
}
