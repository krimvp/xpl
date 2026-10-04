use std::collections::HashMap;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{Arc, Mutex};

pub const JOB_COMPLETED: &str = "job.completed";

#[derive(Clone)]
pub struct JobCompleted {
    pub job_id: String,
    pub kind: String,
    pub duration_ms: u128,
}

pub type Listener = Arc<dyn Fn(&JobCompleted) + Send + Sync>;

#[derive(Clone, Default)]
pub struct EventBus {
    listeners: Arc<Mutex<HashMap<String, Vec<Listener>>>>,
}

impl EventBus {
    pub fn on(&self, topic: &str, listener: Listener) {
        self.listeners
            .lock()
            .unwrap()
            .entry(topic.into())
            .or_default()
            .push(listener);
    }

    pub fn emit(&self, topic: &str, payload: &JobCompleted) {
        let listeners = self
            .listeners
            .lock()
            .unwrap()
            .get(topic)
            .cloned()
            .unwrap_or_default();
        for listener in listeners {
            if catch_unwind(AssertUnwindSafe(|| listener(payload))).is_err() {
                eprintln!("listener for {topic} panicked");
            }
        }
    }
}
