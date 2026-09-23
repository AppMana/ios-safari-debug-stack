#!/usr/bin/env node
import { startEvaluationServer } from '../src/cdp/evaluator';

void startEvaluationServer({
  discoveryUrl: process.env.SAFARI_DISCOVERY_URL ?? 'http://127.0.0.1:9333/json/list',
  targetUrlPrefix: process.env.SAFARI_TARGET_URL,
  host: process.env.SAFARI_EVALUATE_HOST ?? '127.0.0.1',
  port: Number(process.env.SAFARI_EVALUATE_PORT ?? 9334),
}).then(instance => {
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => instance.close());
}).catch(error => { console.error(error); process.exitCode = 1; });
