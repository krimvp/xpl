package jobrunner;

public final class EchoHandler extends BaseHandler implements Handler {
    public EchoHandler() { super("echo"); }
    @Override public Object handle(Queue.Job job) { return job.payload; }
}
