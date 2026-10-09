<?php
namespace Jobrunner;

class Runner
{
    public const MAX_BATCH = 10;

    public function drain(Queue $queue): array
    {
        $results = [];
        while ($job = $queue->pop()) {
            $results[] = $job->run();
        }
        return $results;
    }
}
