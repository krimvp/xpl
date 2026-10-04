use std::collections::HashMap;
use std::time::{Duration, Instant};

#[derive(Clone, Debug)]
pub struct Job {
    pub id: String,
    pub kind: String,
    pub payload: String,
    pub priority: i32,
    pub attempts: u32,
    pub enqueued_at: Instant,
    pub available_at: Instant,
}

pub struct DeadLetter {
    pub job: Job,
    pub error: String,
    pub dead_at: Instant,
}

pub trait JobQueue {
    fn pop(&mut self) -> Option<Job>;
    fn requeue(&mut self, job: Job, delay: Duration);
    fn ack(&mut self, job: Job);
    fn dead_letter(&mut self, job: Job, error: String);
    fn size(&self) -> usize;
}

pub struct Queue {
    ready: Vec<Job>,
    inflight: HashMap<String, Job>,
    max_pending: usize,
    next_id: u64,
    pub acked: usize,
    pub dead: Vec<DeadLetter>,
}

impl Queue {
    pub fn new(max_pending: usize) -> Self {
        Self {
            ready: Vec::new(),
            inflight: HashMap::new(),
            max_pending,
            next_id: 0,
            acked: 0,
            dead: Vec::new(),
        }
    }

    pub fn push(&mut self, kind: &str, payload: &str, priority: i32) -> Result<String, String> {
        if self.size() >= self.max_pending {
            return Err("queue is full".into());
        }
        self.next_id += 1;
        let now = Instant::now();
        let id = format!("job-{}", self.next_id);
        self.ready.push(Job {
            id: id.clone(),
            kind: kind.into(),
            payload: payload.into(),
            priority,
            attempts: 0,
            enqueued_at: now,
            available_at: now,
        });
        Ok(id)
    }
}

impl JobQueue for Queue {
    fn pop(&mut self) -> Option<Job> {
        let now = Instant::now();
        let index = self
            .ready
            .iter()
            .enumerate()
            .filter(|(_, job)| job.available_at <= now)
            .max_by(|(_, a), (_, b)| {
                a.priority
                    .cmp(&b.priority)
                    .then_with(|| b.enqueued_at.cmp(&a.enqueued_at))
            })
            .map(|(index, _)| index)?;
        let job = self.ready.remove(index);
        self.inflight.insert(job.id.clone(), job.clone());
        Some(job)
    }

    fn requeue(&mut self, mut job: Job, delay: Duration) {
        self.inflight.remove(&job.id);
        job.attempts += 1;
        job.available_at = Instant::now() + delay;
        self.ready.push(job);
    }

    fn ack(&mut self, job: Job) {
        self.inflight.remove(&job.id);
        self.acked += 1;
    }

    fn dead_letter(&mut self, mut job: Job, error: String) {
        self.inflight.remove(&job.id);
        job.attempts += 1;
        self.dead.push(DeadLetter {
            job,
            error,
            dead_at: Instant::now(),
        });
    }

    fn size(&self) -> usize {
        self.ready.len() + self.inflight.len()
    }
}
