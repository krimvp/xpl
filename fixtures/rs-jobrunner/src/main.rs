use rs_jobrunner::bus::EventBus;
use rs_jobrunner::config::{config_from_text, load_config, runner_config, DEFAULT_CONFIG};
use rs_jobrunner::metrics::{create_metrics, format_metrics, register_metrics};
use rs_jobrunner::queue::Queue;
use rs_jobrunner::runner::Runner;
use rs_jobrunner::worker::{Handler, Worker, WorkerPool};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

mod demo {
    use rs_jobrunner::queue::Job;

    pub fn echo(job: &Job) -> Result<String, String> {
        rs_jobrunner::worker::demo::handlers::echo(job)
    }
}

fn demo_handlers() -> Arc<HashMap<String, Handler>> {
    let attempts = Mutex::new(HashMap::<String, u32>::new());
    let echo: Handler = Arc::new(demo::echo);
    let flaky: Handler = Arc::new(move |job| {
        let mut seen = attempts.lock().unwrap();
        let count = seen.entry(job.id.clone()).or_default();
        *count += 1;
        if *count <= 2 {
            Err(format!("flaky failure on attempt {count}"))
        } else {
            Ok("recovered".into())
        }
    });
    let broken: Handler = Arc::new(|_| Err("this job always fails".into()));
    Arc::new(HashMap::from([
        ("echo".into(), echo),
        ("flaky".into(), flaky),
        ("broken".into(), broken),
    ]))
}

fn main() -> Result<(), String> {
    let config = match std::env::args().nth(1) {
        Some(path) => load_config(path)?,
        None => config_from_text(DEFAULT_CONFIG)?,
    };
    let bus = EventBus::default();
    let metrics = create_metrics(&config.metrics_prefix);
    if config.metrics_enabled {
        register_metrics(&bus, metrics.clone());
    }
    let handlers = demo_handlers();
    let workers = (1..=config.worker_count)
        .map(|index| {
            Worker::new(
                format!("{}-{index}", config.worker_prefix),
                handlers.clone(),
                bus.clone(),
            )
        })
        .collect();
    let mut queue = Queue::new(config.max_pending);
    queue.push("echo", "hello", 0)?;
    queue.push("flaky", "", 5)?;
    queue.push("broken", "", 0)?;
    println!(
        "queue {}: {} workers, up to {} retries",
        config.queue_name, config.worker_count, config.retry.max_retries
    );
    let mut runner = Runner::new(
        queue,
        WorkerPool::new(workers),
        runner_config(&config),
        Box::new(|line| println!("[runner] {line}")),
    );
    runner.start();
    println!(
        "acked={} dead-lettered={}",
        runner.queue.acked,
        runner.queue.dead.len()
    );
    if config.print_summary {
        println!("{}", format_metrics(&metrics.lock().unwrap()).join("\n"));
    }
    Ok(())
}
