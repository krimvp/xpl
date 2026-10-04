use crate::bus::{EventBus, JobCompleted, JOB_COMPLETED};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct Metrics {
    pub prefix: String,
    pub completed: usize,
    pub total_duration_ms: u128,
    pub completed_by_type: HashMap<String, usize>,
}

pub fn create_metrics(prefix: &str) -> Arc<Mutex<Metrics>> {
    Arc::new(Mutex::new(Metrics {
        prefix: prefix.into(),
        ..Metrics::default()
    }))
}

pub fn on_job_completed(metrics: &mut Metrics, event: &JobCompleted) {
    metrics.completed += 1;
    metrics.total_duration_ms += event.duration_ms;
    *metrics
        .completed_by_type
        .entry(event.kind.clone())
        .or_default() += 1;
}

pub fn register_metrics(bus: &EventBus, metrics: Arc<Mutex<Metrics>>) {
    bus.on(
        JOB_COMPLETED,
        Arc::new(move |event| on_job_completed(&mut metrics.lock().unwrap(), event)),
    );
}

pub fn format_metrics(metrics: &Metrics) -> Vec<String> {
    let mut lines = vec![
        format!("{}.jobs.completed {}", metrics.prefix, metrics.completed),
        format!(
            "{}.jobs.duration_ms_total {}",
            metrics.prefix, metrics.total_duration_ms
        ),
    ];
    let mut by_type: Vec<_> = metrics.completed_by_type.iter().collect();
    by_type.sort_by_key(|(kind, _)| *kind);
    for (kind, count) in by_type {
        lines.push(format!(
            "{}.jobs.completed{{type=\"{kind}\"}} {count}",
            metrics.prefix
        ));
    }
    lines
}
