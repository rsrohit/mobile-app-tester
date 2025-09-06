#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { executeTest } = require('../src/test-runner/test_executor');

async function main() {
  const appPath = process.env.APP_PATH;
  const testsPath = process.env.TEST_PATH;
  const platform = process.env.PLATFORM || 'android';
  const deviceName = process.env.DEVICE_NAME || '';
  const osVersion = process.env.OS_VERSION || '';
  const aiService = process.env.AI_SERVICE || 'gemini';

  if (!appPath || !testsPath) {
    console.error('APP_PATH and TEST_PATH environment variables are required');
    process.exit(1);
  }

  const rawStepsText = fs.readFileSync(path.resolve(testsPath), 'utf8');

  const sessionId = await executeTest(
    path.resolve(appPath),
    rawStepsText,
    { to: () => ({ emit: () => {} }) },
    'cli',
    aiService,
    'browserstack',
    platform,
    deviceName,
    osVersion,
  );

  console.log(`BrowserStack session ID: ${sessionId}`);

  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `session_id=${sessionId}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
