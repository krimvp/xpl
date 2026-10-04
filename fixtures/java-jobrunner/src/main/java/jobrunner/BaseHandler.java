package jobrunner;

public abstract class BaseHandler implements Handler {
    protected final String name;
    protected BaseHandler(String name) { this.name = name; }
    public String name() { return name; }
    public abstract Object handle(Queue.Job job) throws Exception;
}
