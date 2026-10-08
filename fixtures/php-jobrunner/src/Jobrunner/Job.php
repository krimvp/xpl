<?php
namespace Jobrunner;

interface Job
{
    public function run(): string;
}
