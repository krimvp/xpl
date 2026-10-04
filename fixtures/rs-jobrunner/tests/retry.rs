use rs_jobrunner::bus::EventBus;
use rs_jobrunner::config::{config_from_text, RetryConfig, RunnerConfig, DEFAULT_CONFIG};
use rs_jobrunner::metrics::{create_metrics, register_metrics};
use rs_jobrunner::queue::{JobQueue, Queue};
use rs_jobrunner::runner::{backoff_delay, Runner};
use rs_jobrunner::worker::{Handler, RunResult, Worker, WorkerPool};
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

fn run_one(handler: Handler) -> (Runner<Queue>, usize) {
    let bus = EventBus::default();
    let metrics = create_metrics("test");
    register_metrics(&bus, metrics.clone());
    let mut queue = Queue::new(10);
    queue.push("job", "", 0).unwrap();
    let workers = vec![Worker::new(
        "w1".into(),
        Arc::new(HashMap::from([("job".into(), handler)])),
        bus,
    )];
    let config = RunnerConfig {
        idle_delay: Duration::from_millis(1),
        timeout: Duration::from_secs(1),
        retry: RetryConfig {
            max_retries: 3,
            base_delay_ms: 1,
            max_delay_ms: 4,
        },
    };
    let mut runner = Runner::new(queue, WorkerPool::new(workers), config, Box::new(|_| {}));
    runner.start();
    let completed = metrics.lock().unwrap().completed;
    (runner, completed)
}

#[test]
fn fails_twice_then_acks_and_publishes_once() {
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let (runner, completed) = run_one(Arc::new(move |_| {
        if seen.fetch_add(1, Ordering::SeqCst) < 2 {
            Err("boom".into())
        } else {
            Ok("done".into())
        }
    }));
    assert_eq!(
        (
            runner.queue.acked,
            runner.queue.dead.len(),
            runner.queue.size()
        ),
        (1, 0, 0)
    );
    assert_eq!(
        (
            runner.stats.processed,
            completed,
            calls.load(Ordering::SeqCst)
        ),
        (3, 1, 3)
    );
}

#[test]
fn always_fails_then_dead_letters_after_three_requeues() {
    let (runner, completed) = run_one(Arc::new(|_| Err("boom".into())));
    assert_eq!(
        (
            runner.queue.acked,
            runner.queue.dead.len(),
            runner.queue.size()
        ),
        (0, 1, 0)
    );
    assert_eq!(runner.queue.dead[0].error, "boom");
    assert_eq!(runner.queue.dead[0].job.attempts, 4);
    assert_eq!(
        (
            runner.stats.processed,
            runner.stats.dead_lettered,
            completed
        ),
        (4, 1, 0)
    );
}

#[test]
fn backoff_doubles_and_caps() {
    let retry = RetryConfig {
        max_retries: 9,
        base_delay_ms: 100,
        max_delay_ms: 1000,
    };
    let delays: Vec<_> = (1..=5)
        .map(|attempt| backoff_delay(attempt, &retry).as_millis())
        .collect();
    assert_eq!(delays, vec![100, 200, 400, 800, 1000]);
}

#[test]
fn queue_orders_by_priority_then_age_and_skips_backoff() {
    let mut queue = Queue::new(3);
    let oldest = queue.push("job", "oldest", 0).unwrap();
    let first = queue.push("job", "high", 5).unwrap();
    let last = queue.push("job", "newest", 0).unwrap();
    assert_eq!(
        queue.push("job", "overflow", 0),
        Err("queue is full".into())
    );
    let high = queue.pop().unwrap();
    assert_eq!(high.id, first);
    queue.requeue(high, Duration::from_secs(60));
    let old = queue.pop().unwrap();
    assert_eq!(old.id, oldest);
    queue.ack(old);
    let new = queue.pop().unwrap();
    assert_eq!(new.id, last);
    queue.ack(new);
    assert!(queue.pop().is_none());
    assert_eq!(queue.size(), 1);
}

#[test]
fn worker_timeout_is_a_failure_and_releases_current_job() {
    let mut queue = Queue::new(1);
    queue.push("slow", "", 0).unwrap();
    let job = queue.pop().unwrap();
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let wait = std::sync::Mutex::new(wait);
    let handler: Handler = Arc::new(move |_| {
        wait.lock().unwrap().recv().unwrap();
        Ok("late".into())
    });
    let bus = EventBus::default();
    let metrics = create_metrics("test");
    register_metrics(&bus, metrics.clone());
    let mut worker = Worker::new(
        "w1".into(),
        Arc::new(HashMap::from([("slow".into(), handler)])),
        bus,
    );
    let outcome = worker.run(&job, Duration::from_millis(1));
    release.send(()).unwrap();
    match outcome {
        RunResult::Failure { error, .. } => assert!(error.contains("timed out")),
        RunResult::Success { .. } => panic!("blocked handler must time out"),
    }
    assert_eq!(worker.current, None);
    assert_eq!(metrics.lock().unwrap().completed, 0);
}

#[test]
fn default_yaml_carries_the_retry_policy() {
    let config = config_from_text(DEFAULT_CONFIG).unwrap();
    assert_eq!(
        (
            config.retry.max_retries,
            config.retry.base_delay_ms,
            config.retry.max_delay_ms
        ),
        (3, 500, 30000)
    );
    assert_eq!(
        (
            config.queue_name.as_str(),
            config.worker_count,
            config.metrics_enabled
        ),
        ("default", 4, true)
    );
    assert_eq!(
        config_from_text(&DEFAULT_CONFIG.replace("count: 4", "count: 0"))
            .err()
            .unwrap(),
        "worker count must be positive"
    );
}
