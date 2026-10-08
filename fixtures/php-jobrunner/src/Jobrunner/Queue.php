<?php
namespace Jobrunner;

class Queue
{
    private array $jobs = [];

    public function push(Job $job): void
    {
        $this->jobs[] = $job;
    }

    public function pop(): ?Job
    {
        return array_shift($this->jobs);
    }
}
