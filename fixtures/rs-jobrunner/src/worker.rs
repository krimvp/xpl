use crate::bus::{EventBus, JobCompleted, JOB_COMPLETED};
use crate::queue::Job;
use std::collections::{HashMap, VecDeque};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::thread;
use std::time::{Duration, Instant};

pub type Handler = Arc<dyn Fn(&Job) -> Result<String, String> + Send + Sync>;

pub enum RunResult {
    Success { value: String, duration_ms: u128 },
    Failure { error: String, duration_ms: u128 },
}

pub struct Worker {
    pub id: String,
    pub current: Option<String>,
    handlers: Arc<HashMap<String, Handler>>,
    bus: EventBus,
}

impl Worker {
    pub fn new(id: String, handlers: Arc<HashMap<String, Handler>>, bus: EventBus) -> Self {
        Self {
            id,
            current: None,
            handlers,
            bus,
        }
    }

    pub fn run(&mut self, job: &Job, timeout: Duration) -> RunResult {
        let Some(handler) = self.handlers.get(&job.kind).cloned() else {
            return RunResult::Failure {
                error: format!("no handler for job type {}", job.kind),
                duration_ms: 0,
            };
        };
        self.current = Some(job.id.clone());
        let started = Instant::now();
        let (sender, receiver) = mpsc::sync_channel(1);
        let owned_job = job.clone();
        thread::spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| handler(&owned_job)))
                .unwrap_or_else(|_| Err("handler panicked".into()));
            let _ = sender.send(result);
        });
        // std cannot cancel a thread. A timed-out handler may still finish and have side effects.
        let result = receiver
            .recv_timeout(timeout)
            .unwrap_or_else(|error| Err(format!("job failed: {error}")));
        self.current = None;
        let duration_ms = started.elapsed().as_millis();
        match result {
            Ok(value) => {
                self.bus.emit(
                    JOB_COMPLETED,
                    &JobCompleted {
                        job_id: job.id.clone(),
                        kind: job.kind.clone(),
                        duration_ms,
                    },
                );
                RunResult::Success { value, duration_ms }
            }
            Err(error) => RunResult::Failure { error, duration_ms },
        }
    }
}

pub struct WorkerPool {
    idle: Mutex<VecDeque<Worker>>,
    available: Condvar,
}

impl WorkerPool {
    pub fn new(workers: Vec<Worker>) -> Self {
        assert!(!workers.is_empty(), "worker pool must not be empty");
        Self {
            idle: Mutex::new(workers.into()),
            available: Condvar::new(),
        }
    }

    pub fn lease(&self) -> Worker {
        let mut idle = self.idle.lock().unwrap();
        loop {
            if let Some(worker) = idle.pop_front() {
                return worker;
            }
            idle = self.available.wait(idle).unwrap();
        }
    }

    pub fn release(&self, worker: Worker) {
        self.idle.lock().unwrap().push_back(worker);
        self.available.notify_one();
    }
}

pub mod demo {
    pub mod handlers {
        use crate::queue::Job;

        pub fn echo(job: &Job) -> Result<String, String> {
            Ok(job.payload.clone())
        }
    }
}
