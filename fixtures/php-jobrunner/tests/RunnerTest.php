<?php
require_once __DIR__ . '/../src/Jobrunner/Job.php';
require_once __DIR__ . '/../src/Jobrunner/Queue.php';
require_once __DIR__ . '/../src/Jobrunner/Runner.php';

class TestJob implements Jobrunner\Job
{
    public function run(): string
    {
        return 'done';
    }
}

$queue = new Jobrunner\Queue();
$queue->push(new TestJob());
if ((new Jobrunner\Runner())->drain($queue) !== ['done']) {
    throw new RuntimeException('runner did not drain the queue');
}
